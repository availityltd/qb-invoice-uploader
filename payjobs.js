import { getAccessToken } from './qb.js';
import { postPayment } from './cpr.js';
import { writeStatusSheet, writeStatusExcel } from './sheets.js';
import { recordRun, getSetting, setSetting } from './settings.js';
import { realmOf } from './desk.js';

// one payment run per desk - the company and the person signed in, together -
// kept on the server, so leaving the page or moving to another computer is
// safe, and two people in the same books do not share a run
const jobs = new Map();
const MAX_EVENTS = 2000;

// Up to this many go across as one payment; beyond it the run is halved.
const SPLIT_ABOVE = 2000;

export const QB_STATUS_HEADER = 'QB Status';

function push(job, type, msg, extra) {
  job.lastId++;
  job.events.push(Object.assign({ id: job.lastId, type, msg }, extra || {}));
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

export function startPayJob(desk, body) {
  const realmId = realmOf(desk);
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A payment run of yours is already going');
  }

  if (!body.accountId) throw new Error('Deposit account required');
  if (!Array.isArray(body.matched) || !body.matched.length) throw new Error('Nothing to receive');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    body,
    total: body.matched.length,
    doneCount: 0,
    posted: 0,
    totalAmount: 0,
    results: [],
    paidInvoices: [],
    stamped: 0,
    events: [],
    lastId: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(desk, job);
  run(realmId, job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function run(realmId, job, only) {
  const {
    courier, cprNumber, cprDate, accountId, accountName, methodId,
    matched: allMatched, sheetId, tab, excel = false,
    headerRow, statusCol, writeStatus = true
  } = job.body;

  const matched = only || allMatched;
  push(job, 'log', (only ? 'Carrying on: ' + matched.length + ' left. ' : '') + 'Connecting to QuickBooks...');
  const token = await getAccessToken(realmId);

  // one payment per customer - QB will not mix two customers in one
  const byCustomer = new Map();
  matched.forEach(m => {
    const k = m.customerId || 'none';
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(m);
  });

  const ref = String(cprNumber || '').trim().slice(0, 21);
  const paidRows = [];

  // a merged cell holds several invoice numbers, and the row is only paid when
  // their balances add up to the sheet amount - so every one of them gets its
  // own line, not just the first
  const openParts = m => (Array.isArray(m.lines) && m.lines.length)
    ? m.lines
    : [{ qbId: m.qbId, qbDoc: m.qbDoc, amount: m.qbBalance }];

  // sends one payment; if QB chokes on the size, halves it and tries again
  async function sendPart(custId, lines, label, depth) {
    if (job.stop) return;

    // add up the lines as QuickBooks will see them, so the total agrees to the cent
    const amount = lines.reduce(
      (s, m) => s + openParts(m).reduce((t, p) => t + Math.round(p.amount * 100) / 100, 0), 0);
    const who = lines[0].customerName || custId;
    const tag = label ? ` (${label})` : '';

    push(job, 'log', `Sending ${lines.length} invoices for ${who}${tag}...`);

    const payload = {
      CustomerRef: { value: String(custId) },
      TotalAmt: Math.round(amount * 100) / 100,
      DepositToAccountRef: { value: String(accountId) },
      Line: lines.flatMap(m => openParts(m).map(p => ({
        Amount: Math.round(p.amount * 100) / 100,
        LinkedTxn: [{ TxnId: String(p.qbId), TxnType: 'Invoice' }]
      })))
    };
    if (cprDate) payload.TxnDate = cprDate;
    if (methodId) payload.PaymentMethodRef = { value: String(methodId) };
    if (ref) payload.PaymentRefNum = ref;

    const r = await postPayment(realmId, token, payload);

    if (r.ok) {
      job.posted++;
      job.totalAmount += amount;
      job.doneCount += lines.length;

      lines.forEach(m => {
        if (m.sheetRow) paidRows.push(m.sheetRow);
        job.paidInvoices.push({
          invoice: m.invoice,
          qbDoc: m.qbDoc,
          customer: m.customerName || '',
          amount: Math.round(m.qbBalance * 100) / 100
        });
      });

      job.results.push({
        ok: true,
        customer: who + tag,
        count: lines.length,
        amount: Math.round(amount * 100) / 100,
        paymentId: r.id
      });
      push(job, 'ok', `OK  ${who}${tag} - ${lines.length} invoices`);
      return;
    }

    // too big for QuickBooks - cut it in half and send both halves
    if (lines.length > 1 && depth < 2) {
      push(job, 'log', `QuickBooks refused ${lines.length} at once - splitting in two.`);
      const half = Math.ceil(lines.length / 2);
      await sendPart(custId, lines.slice(0, half), `${label || 'part'} a`, depth + 1);
      await sendPart(custId, lines.slice(half), `${label || 'part'} b`, depth + 1);
      return;
    }

    job.doneCount += lines.length;
    job.results.push({ ok: false, customer: who + tag, count: lines.length, msg: r.msg });
    push(job, 'fail', `FAILED  ${who}${tag} - ${String(r.msg).slice(0, 200)}`);
  }

  for (const [custId, lines] of byCustomer) {
    if (job.stop) break;

    if (!custId || custId === 'none') {
      job.doneCount += lines.length;
      job.results.push({ ok: false, msg: 'Invoices with no customer were skipped', count: lines.length });
      continue;
    }

     if (lines.length <= SPLIT_ABOVE) {
      await sendPart(custId, lines, '', 0);
      continue;
    }

    // over the limit, so it goes in two halves rather than many small ones
    const half = Math.ceil(lines.length / 2);
    push(job, 'log', `${lines.length} invoices for this customer - sending as 2 payments.`);
    await sendPart(custId, lines.slice(0, half), 'part 1 of 2', 0);
    if (!job.stop) await sendPart(custId, lines.slice(half), 'part 2 of 2', 0);
  }

  // stamp the sheet only if the payments actually landed
  if (writeStatus && paidRows.length && sheetId && tab &&
      headerRow !== undefined && statusCol !== undefined) {
    try {
      push(job, 'log', 'Writing "Received" into the sheet...');
      if (excel) {
        job.stamped = await writeStatusExcel(sheetId, tab, Number(headerRow), Number(statusCol),
                                             paidRows, QB_STATUS_HEADER, 'Received');
      } else {
        job.stamped = await writeStatusSheet(sheetId, tab, Number(headerRow), Number(statusCol),
                                             paidRows, QB_STATUS_HEADER, 'Received');
      }
      push(job, 'ok', `Wrote "Received" against ${job.stamped} rows.`);
    } catch (e) {
      job.results.push({ ok: false, msg: 'Payments went through, writing the sheet failed: ' + e.message });
      push(job, 'fail', 'Sheet not written: ' + e.message);
    }
  }

  try {
    await recordRun(realmId, {
      courier, cprNumber, cprDate, sheetId,
      matched: matched.length, unmatched: 0,
      amount: Math.round(job.totalAmount * 100) / 100,
      qbPaymentId: (job.results.find(x => x.ok) || {}).paymentId || null,
      bankAccount: accountName || null
    });
  } catch (e) {}

  try {
    const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
    if (courier) prefs[courier] = { accountId, methodId };
    await setSetting(realmId, 'cpr:prefs', prefs);
  } catch (e) {}

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log', `--- ${job.posted} payment${job.posted === 1 ? '' : 's'} recorded ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

// Carry on after a Stop: the rows not yet paid go through again, in the same log.
// A row is paid once its invoice is in job.paidInvoices, so nothing is paid twice.
export function resumePayJob(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no run to carry on');
  if (job.state === 'running') throw new Error('The run is still going');

  const key = x => String(x.invoice) + '|' + String(x.qbDoc);
  const paidKeys = new Set(job.paidInvoices.map(key));
  const left = job.body.matched.filter(m => !paidKeys.has(key(m)));
  if (!left.length) throw new Error('Nothing is left to receive');

  job.results = job.results.filter(r => r.ok);
  job.doneCount = job.paidInvoices.length;
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  run(realmId, job, left).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
}

export function stopPayJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the payment in flight...');
  return true;
}

export function clearPayJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

export function paySnapshot(desk, since, full) {
  const job = jobs.get(desk);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    doneCount: job.doneCount,
    leftCount: Math.max(0, job.total - job.paidInvoices.length),
    posted: job.posted,
    amount: Math.round(job.totalAmount * 100) / 100,
    stamped: job.stamped,
    cprNumber: job.body.cprNumber || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full || job.state !== 'running') {
    out.results = job.results;
    out.paidInvoices = job.paidInvoices;
  }

  return out;
}
