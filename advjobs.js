import { getAccessToken } from './qb.js';
import { postPayment, liveBalances } from './cpr.js';
import { recordRun, getSetting, setSetting } from './settings.js';
import { stampRows } from './sheets.js';
import { realmOf } from './desk.js';
import { claimIds, releaseIds } from './paylock.js';

// one advance run per desk - the company and the person signed in, together -
// kept on the server, so leaving the page or moving to another computer is
// safe, and two people in the same books do not share a run
const jobs = new Map();
const MAX_EVENTS = 2000;

// QuickBooks will not take a payment with thousands of lines on it
const SPLIT_ABOVE = 1000;
const CHUNK = 500;

// tokens last an hour - refresh well before that
const TOKEN_LIFE = 40 * 60 * 1000;

function push(job, type, msg, extra) {
  job.lastId++;
  job.events.push(Object.assign({ id: job.lastId, type, msg, at: Date.now() }, extra || {}));
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

async function tokenFor(realmId, job, force) {
  if (force || !job.token || (Date.now() - job.tokenAt) > TOKEN_LIFE) {
    job.token = await getAccessToken(realmId);
    job.tokenAt = Date.now();
    if (force) push(job, 'log', 'QuickBooks sign-in had expired - signed in again.');
  }
  return job.token;
}

export function startAdvJob(desk, body) {
  const realmId = realmOf(desk);
  const live = jobs.get(desk);
  if (live && live.state === 'running') {
    throw new Error('An advance payment run of yours is already going');
  }

  if (!Array.isArray(body.rows) || !body.rows.length) throw new Error('Nothing to receive');

  const job = {
    id: Date.now(),
    desk,
    state: 'running',
    stop: false,
    body,
    total: body.rows.length,
    doneCount: 0,
    posted: 0,
    totalAmount: 0,
    results: [],
    paid: [],
    skipped: [],
    toStamp: [],
    stampAt: new Map(),
    stamped: 0,
    events: [],
    lastId: 0,
    token: null,
    tokenAt: 0,
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
    rows: allRows, methodId,
    txnDate, label, courier,
    sheetId, tab, postedCol, stamp
  } = job.body;

  const rows = only || allRows;
  push(job, 'log', (only ? 'Carrying on: ' + rows.length + ' left. ' : '') + 'Connecting to QuickBooks...');
  await tokenFor(realmId, job);

  const memo = `Advance payment\ndated: ${label}`;

  // QuickBooks will not mix two customers on one payment, and each row names
  // its own bank, so a payment is one customer paid into one account
  const groups = new Map();
  rows.forEach(r => {
    const k = (r.customerId || 'none') + '|' + (r.accountId || 'none');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  // the invoices this desk is holding while it pays them
  const holding = [];

  function noteSkip(m, why) {
    job.skipped.push({
      invoice: m.invoice, qbDoc: m.qbDoc, customer: m.customerName || '', why
    });
    job.doneCount++;
    job.results.push({
      ok: false, customer: m.customerName || '', count: 1, msg: `${m.invoice} - ${why}`
    });
  }

  // What the invoice owes is read again here, a moment before the money goes
  // across, and the advance is cut down to it. The balance a row carries is the
  // balance of when the sheet was read; if the invoice has been part paid or
  // settled since - by a CPR, or by the person at the next desk - the older
  // figure would hand QuickBooks more than is owed, and the difference would
  // sit unapplied or as a credit on the customer.
  async function prepare(lines) {
    const { mine, taken } = claimIds(realmId, job.desk, lines.map(m => m.qbId));
    holding.push(...mine);
    const busy = new Set(taken);

    push(job, 'log', 'Checking what these invoices still owe...');
    const token = await tokenFor(realmId, job);
    const live = await liveBalances(realmId, token, mine);

    const ready = [];
    for (const m of lines) {
      const id = String(m.qbId || '');
      if (!id) { noteSkip(m, 'there is no QuickBooks invoice behind it'); continue; }

      if (busy.has(id)) {
        noteSkip(m, 'somebody else is receiving it at this moment - left for them');
        push(job, 'fail', `LEFT  ${m.invoice} - somebody else is receiving it right now`);
        continue;
      }

      const owed = live.has(id) ? live.get(id) : 0;
      if (!(owed > 0.005)) {
        noteSkip(m, 'already settled in QuickBooks - not received a second time');
        push(job, 'fail', `SKIPPED  ${m.invoice} - already settled in QuickBooks`);
        continue;
      }

      const want = Math.round(Number(m.willPay || 0) * 100) / 100;
      const pay = Math.round(Math.min(want, owed) * 100) / 100;
      if (!(pay > 0.005)) {
        noteSkip(m, 'nothing left to receive against it');
        continue;
      }
      if (Math.round((want - pay) * 100) / 100 > 0.005) {
        push(job, 'log',
          `${m.invoice} owes only ${pay.toFixed(2)} now - receiving that, not ${want.toFixed(2)}.`);
      }

      ready.push(Object.assign({}, m, { willPay: pay }));
    }

    return ready;
  }

  async function sendPart(lines, part, parts) {
    if (job.stop) return;

    const custId = lines[0].customerId;
    const acct = lines[0].accountId;
    const amount = lines.reduce((s, m) => s + Number(m.willPay || 0), 0);
    const who = lines[0].customerName || custId;
    const bankName = lines[0].bank || '';
    const tag = parts > 1 ? ` (part ${part} of ${parts})` : '';

    push(job, 'log', `Sending ${lines.length} invoices for ${who} into ${bankName}${tag}...`);

    const payload = {
      CustomerRef: { value: String(custId) },
      TotalAmt: Math.round(amount * 100) / 100,
      DepositToAccountRef: { value: String(acct) },
      PrivateNote: memo + tag,
      Line: lines.map(m => ({
        Amount: Math.round(Number(m.willPay) * 100) / 100,
        LinkedTxn: [{ TxnId: String(m.qbId), TxnType: 'Invoice' }]
      }))
    };
    if (txnDate) payload.TxnDate = txnDate;
    if (methodId) payload.PaymentMethodRef = { value: String(methodId) };

    const token = await tokenFor(realmId, job);
    const r = await postPayment(realmId, token, payload);

    if (r.ok) {
      job.posted++;
      job.totalAmount += amount;
      job.doneCount += lines.length;

      lines.forEach(m => {
        // A row carries the sheet and tab it came from when the rows were
        // gathered from several tabs at once - a pasted list can span months.
        // Where it does not, they all belong to the one tab the page picked.
        if (m.sheetRow) {
          job.toStamp.push(m.sheetRow);
          const where = (m.sheetId || job.body.sheetId || '') + '|' + (m.tab || job.body.tab || '');
          if (!job.stampAt.has(where)) job.stampAt.set(where, []);
          job.stampAt.get(where).push(m.sheetRow);
        }
        job.paid.push({
          invoice: m.invoice,
          qbDoc: m.qbDoc,
          customer: m.customerName || '',
          bank: m.bank || '',
          amount: Math.round(Number(m.willPay) * 100) / 100,
          balanceWas: m.qbBalance
        });
      });

      job.results.push({
        ok: true,
        customer: who + ' - ' + bankName + tag,
        count: lines.length,
        amount: Math.round(amount * 100) / 100,
        paymentId: r.id
      });
      push(job, 'ok', `OK  ${who} - ${bankName}${tag} - ${lines.length} invoices, ${amount.toFixed(2)}`);
      return;
    }

    // too big for QuickBooks - halve it and send both halves
    if (lines.length > 1) {
      push(job, 'log', `QuickBooks refused ${lines.length} at once - splitting in two.`);
      const half = Math.ceil(lines.length / 2);
      await sendPart(lines.slice(0, half), part, parts);
      await sendPart(lines.slice(half), part, parts);
      return;
    }

    job.doneCount += lines.length;
    job.results.push({ ok: false, customer: who + tag, count: lines.length, msg: r.msg });
    push(job, 'fail', `FAILED  ${who}${tag} - ${String(r.msg).slice(0, 200)}`);
  }

  for (const [key, lines] of groups) {
    if (job.stop) break;

    // a row with no customer, or a bank we were never told about, is left alone
    if (!lines[0].customerId || !lines[0].accountId) {
      job.doneCount += lines.length;
      job.results.push({
        ok: false,
        msg: 'Rows with no customer or no bank were skipped',
        count: lines.length
      });
      continue;
    }

    try {
      const ready = await prepare(lines);
      if (!ready.length) continue;

      if (ready.length < SPLIT_ABOVE) {
        await sendPart(ready, 1, 1);
        continue;
      }

      const parts = Math.ceil(ready.length / CHUNK);
      push(job, 'log', `${ready.length} invoices for this customer - sending as ${parts} payments.`);
      for (let i = 0; i < parts && !job.stop; i++) {
        await sendPart(ready.slice(i * CHUNK, (i + 1) * CHUNK), i + 1, parts);
      }
    } finally {
      // the hold lasts as long as the payment does, and no longer
      releaseIds(realmId, job.desk, holding.splice(0, holding.length));
    }
  }

  try {
    await recordRun(realmId, {
      courier: courier || 'Advance payments',
      cprNumber: label,
      cprDate: txnDate,
      sheetId: job.body.sheetId || null,
      matched: rows.length,
      unmatched: 0,
      amount: Math.round(job.totalAmount * 100) / 100,
      qbPaymentId: (job.results.find(x => x.ok) || {}).paymentId || null,
      bankAccount: 'per row'
    });
  } catch (e) {}

  // Mark the rows in the sheet, so a second run leaves them alone. This is
  // what the invoice balance cannot tell us - an advance always leaves some
  // owing, so the sheet has to remember instead.
  if (postedCol >= 0 && job.toStamp.length) {
    push(job, 'log', `Writing "${stamp}" against ${job.toStamp.length} rows in the sheet...`);
    job.stamped = 0;

    for (const [where, list] of job.stampAt) {
      const at = where.indexOf('|');
      const thisSheet = where.slice(0, at), thisTab = where.slice(at + 1);
      if (!thisSheet || !thisTab || !list.length) continue;
      try {
        job.stamped += await stampRows(thisSheet, thisTab, Number(postedCol), list, stamp);
      } catch (e) {
        push(job, 'fail', `Could not mark ${thisTab}: ${e.message}`);
      }
    }

    if (job.stamped) push(job, 'ok', `Marked ${job.stamped} rows in the sheet.`);
  }

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log', `--- ${job.posted} payment${job.posted === 1 ? '' : 's'} recorded, ${job.totalAmount.toFixed(2)} in all ---`);
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

// Carry on after a Stop: the rows not yet paid go through again, in the same log.
// A row is paid once its invoice is in job.paid, so nothing is paid twice.
export function resumeAdvJob(desk) {
  const realmId = realmOf(desk);
  const job = jobs.get(desk);
  if (!job) throw new Error('There is no run to carry on');
  if (job.state === 'running') throw new Error('The run is still going');

  const key = x => String(x.invoice) + '|' + String(x.qbDoc);
  const done = new Set(job.paid.map(key));
  // a row already settled in QuickBooks, or being paid by another desk, was
  // put aside on purpose - carrying on does not go back for it
  (job.skipped || []).forEach(x => done.add(key(x)));
  const left = job.body.rows.filter(r => !done.has(key(r)));
  if (!left.length) throw new Error('Nothing is left to receive');

  job.results = job.results.filter(r => r.ok);
  job.doneCount = job.paid.length + (job.skipped || []).length;
  job.toStamp = [];
  job.stampAt = new Map();
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  run(realmId, job, left).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
}

export function stopAdvJob(desk) {
  const job = jobs.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the payment in flight...');
  return true;
}

export function clearAdvJob(desk) {
  const job = jobs.get(desk);
  if (job && job.state === 'running') return false;
  jobs.delete(desk);
  return true;
}

// End process. Stop leaves the run sitting on the server so it can be carried
// on from where it stopped; End means the run is over - whatever is left is
// dropped and nothing of it stays behind, not even after a restart. What is
// already written is not undone.
export function endAdvJob(desk) {
  const job = jobs.get(desk);
  if (job) {
    job.ended = true;
    job.stop = true;
    job.cancel = true;
    job.state = 'ended';
  }
  jobs.delete(desk);
  return !!job;
}


export function advSnapshot(desk, since, full) {
  const job = jobs.get(desk);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    doneCount: job.doneCount,
    leftCount: Math.max(0, job.total - job.paid.length - (job.skipped || []).length),
    posted: job.posted,
    amount: Math.round(job.totalAmount * 100) / 100,
    label: job.body.label || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full || job.state !== 'running') {
    out.stamped = job.stamped;
    out.results = job.results;
    out.paid = job.paid;
    out.skipped = job.skipped || [];
  }

  return out;
}
