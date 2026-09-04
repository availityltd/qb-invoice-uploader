import { getAccessToken } from './qb.js';
import { postPayment } from './cpr.js';
import { recordRun, getSetting, setSetting } from './settings.js';
import { writeCell } from './sheets.js';

// one advance run per company, kept on the server so leaving the page is safe
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

export function startAdvJob(realmId, body) {
  const live = jobs.get(realmId);
  if (live && live.state === 'running') {
    throw new Error('An advance payment run is already going for this company');
  }

  if (!Array.isArray(body.rows) || !body.rows.length) throw new Error('Nothing to receive');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    body,
    total: body.rows.length,
    doneCount: 0,
    posted: 0,
    totalAmount: 0,
    results: [],
    paid: [],
    toStamp: [],
    stamped: 0,
    events: [],
    lastId: 0,
    token: null,
    tokenAt: 0,
    startedAt: Date.now(),
    finishedAt: null
  };

  jobs.set(realmId, job);
  run(realmId, job).catch(e => {
    push(job, 'error', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });

  return job.id;
}

async function run(realmId, job) {
  const {
    rows, methodId,
    txnDate, label, courier,
    sheetId, tab, postedCol, stamp
  } = job.body;

  push(job, 'log', 'Connecting to QuickBooks...');
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
        if (m.sheetRow) job.toStamp.push(m.sheetRow);
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

    if (lines.length < SPLIT_ABOVE) {
      await sendPart(lines, 1, 1);
      continue;
    }

    const parts = Math.ceil(lines.length / CHUNK);
    push(job, 'log', `${lines.length} invoices for this customer - sending as ${parts} payments.`);
    for (let i = 0; i < parts && !job.stop; i++) {
      await sendPart(lines.slice(i * CHUNK, (i + 1) * CHUNK), i + 1, parts);
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
  if (sheetId && tab && postedCol >= 0 && job.toStamp.length) {
    push(job, 'log', `Writing "${stamp}" against ${job.toStamp.length} rows in the sheet...`);
    for (const rowNo of job.toStamp) {
      try {
        await writeCell(sheetId, tab, Number(rowNo), Number(postedCol), stamp);
        job.stamped++;
      } catch (e) {
        push(job, 'fail', `Could not mark sheet row ${rowNo}: ${e.message}`);
      }
    }
    push(job, 'ok', `Marked ${job.stamped} rows in the sheet.`);
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

export function stopAdvJob(realmId) {
  const job = jobs.get(realmId);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the payment in flight...');
  return true;
}

export function clearAdvJob(realmId) {
  const job = jobs.get(realmId);
  if (job && job.state === 'running') return false;
  jobs.delete(realmId);
  return true;
}

export function advSnapshot(realmId, since, full) {
  const job = jobs.get(realmId);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    doneCount: job.doneCount,
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
  }

  return out;
}
