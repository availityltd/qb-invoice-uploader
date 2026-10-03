// The check list: what a CPR actually paid for, read back out of QuickBooks.
//
// Receiving works forwards - the sheet says what to pay, and the payment goes in.
// This reads the other way round: it takes the payments that carry the CPR number
// and asks of every invoice inside them "does this order belong to this CPR at
// all, and was the right amount taken?". An order that is not on the CPR's sheet
// has no business being paid by it, and money taken over the amount owed has to
// come back off. Both are put right by editing the payment itself, never by
// deleting a payment that other orders are also sitting on.

import { getAccessToken, qbQuery } from './qb.js';
import {
  loadSheet, isDelivered, findInvoices, clean, digitsOf
} from './cpr.js';
import { getSetting } from './settings.js';
import { realmOf } from './desk.js';

const API = 'https://quickbooks.api.intuit.com';
const MAX_EVENTS = 2000;

// one read and one fix per company - every computer on the company sees the same
// both keyed by the desk - the company and the person - so one person's check
// or fix is not another's to watch, stop or clear
const scans = new Map();
const fixes = new Map();

/* ==================== small helpers ==================== */

function push(job, type, msg) {
  job.lastId++;
  job.events.push({ id: job.lastId, type, msg });
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

function money(n) { return Math.round(Number(n || 0) * 100) / 100; }

function faultOf(text) {
  let msg = String(text).slice(0, 300);
  try {
    const f = JSON.parse(text).Fault;
    if (f && f.Error && f.Error.length) {
      msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
    }
  } catch (e) {}
  return msg;
}

// the number as the courier wrote it, with the # and any padding taken off
function key(n) { return digitsOf(n) || clean(n).replace(/^#/, '').toLowerCase(); }

/* ==================== reading payments out of QuickBooks ==================== */

// Every payment we post carries the CPR number in PaymentRefNum. Asking for it
// straight is one query; some companies answer that filter with a fault, so the
// fall-back sweeps the months around the CPR date and keeps the ones that match.
async function paymentsWithRef(realmId, token, ref, aroundDate, job) {
  const wanted = clean(ref);
  if (!wanted) return [];

  const safe = wanted.replace(/'/g, "\\'");
  const out = [];

  try {
    let start = 1;
    while (true) {
      if (job && job.stop) break;
      const q = await qbQuery(realmId, token,
        `SELECT * FROM Payment WHERE PaymentRefNum = '${safe}' ` +
        `STARTPOSITION ${start} MAXRESULTS 500`);
      const arr = q.Payment || [];
      arr.forEach(p => out.push(p));
      if (arr.length < 500) break;
      start += 500;
      if (start > 9000) break;
    }
    return out;
  } catch (e) {
    // a half-read page is worse than none - the sweep below starts clean
    out.length = 0;
    if (job) push(job, 'log', 'Asking by CPR number was refused - reading the dates around it instead.');
  }

  // fall-back: a window around the CPR date, then keep what carries the number
  const base = aroundDate && /^\d{4}-\d{2}-\d{2}$/.test(aroundDate)
    ? new Date(aroundDate + 'T00:00:00Z') : new Date();
  const shift = d => new Date(base.getTime() + d * 86400000).toISOString().slice(0, 10);
  const from = shift(-150), to = shift(150);

  let start = 1;
  while (true) {
    if (job && job.stop) break;
    const q = await qbQuery(realmId, token,
      `SELECT * FROM Payment WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ` +
      `STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Payment || [];
    arr.forEach(p => { if (clean(p.PaymentRefNum) === wanted) out.push(p); });
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) break;
  }
  return out;
}

// whole payments by their own ids - the ids come off the invoices' LinkedTxn,
// which is the only way to reach a payment that went in under no number at all
async function fullPaymentsByIds(realmId, token, ids, job) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = [];
  for (let i = 0; i < list.length; i += 30) {
    if (job && job.stop) break;
    const chunk = list.slice(i, i + 30).map(x => `'${x}'`).join(',');
    try {
      const q = await qbQuery(realmId, token,
        `SELECT * FROM Payment WHERE Id IN (${chunk}) MAXRESULTS 500`);
      (q.Payment || []).forEach(p => out.push(p));
    } catch (e) {}
  }
  return out;
}

// the invoices a payment's lines point at, by QuickBooks id
async function invoicesByIds(realmId, token, ids, job) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < list.length; i += 40) {
    if (job && job.stop) break;
    const chunk = list.slice(i, i + 40).map(x => `'${x}'`).join(',');
    const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef ` +
      `FROM Invoice WHERE Id IN (${chunk}) MAXRESULTS 500`);
    (q.Invoice || []).forEach(inv => {
      map.set(String(inv.Id), {
        id: String(inv.Id),
        doc: clean(inv.DocNumber),
        date: inv.TxnDate || '',
        total: Number(inv.TotalAmt || 0),
        balance: Number(inv.Balance === undefined ? inv.TotalAmt : inv.Balance),
        customerId: inv.CustomerRef ? String(inv.CustomerRef.value) : '',
        customerName: inv.CustomerRef ? (inv.CustomerRef.name || '') : ''
      });
    });
  }
  return map;
}

// every invoice line inside a payment, flattened
function linesOf(pay) {
  const out = [];
  (pay.Line || []).forEach((l, i) => {
    (l.LinkedTxn || []).forEach(t => {
      if (t.TxnType !== 'Invoice') return;
      out.push({ index: i, invoiceId: String(t.TxnId), amount: Number(l.Amount || 0) });
    });
  });
  return out;
}

function appliedOf(pay) {
  return money(linesOf(pay).reduce((s, l) => s + l.amount, 0));
}

/* ==================== the check ==================== */

export function startCheck(desk, body) {
  const realmId = realmOf(desk);
  const live = scans.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A check of yours is already going');
  }

  const job = {
    id: Date.now(),
    kind: body.kind === 'invoices' ? 'invoices' : 'cpr',
    state: 'running',
    stop: false,
    body,
    events: [],
    lastId: 0,
    result: null,
    startedAt: Date.now(),
    finishedAt: null
  };

  scans.set(desk, job);
  runCheck(realmId, job).catch(e => {
    push(job, 'fail', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
  return job.id;
}

async function runCheck(realmId, job) {
  if (job.kind === 'invoices') await checkInvoices(realmId, job);
  else await checkCpr(realmId, job);

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    job.state = 'done';
  }
  job.finishedAt = Date.now();
}

async function checkCpr(realmId, job) {
  const { sheetId, tab, excel = false, courier, cpr } = job.body;
  if (!sheetId || !tab) throw new Error('The sheet and its tab are needed');

  push(job, 'log', 'Reading the CPR sheet...');
  const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;
  const data = await loadSheet(sheetId, tab, excel, saved);
  const hasStatus = data.cols.status >= 0;

  let rows = data.rows;
  if (cpr) rows = rows.filter(r => (r.cprNumber || '(no CPR number)') === cpr);
  if (!rows.length) throw new Error('No rows for that CPR');

  const sheetCpr = clean(rows[0].cprNumber);
  const sheetDate = rows[0].cprDate || null;

  // what this CPR is allowed to pay for: every order number on its rows
  const belongs = new Map();                 // key -> the sheet's side of that order
  rows.forEach(r => {
    const delivered = isDelivered(r, hasStatus);
    (r.invoices || [r.invoice]).forEach(n => {
      const k = key(n);
      if (!k || belongs.has(k)) return;
      belongs.set(k, {
        number: clean(n),
        sheetRow: r.sheetRow,
        merged: !!r.merged,
        rowAmount: money(r.amount),
        delivered
      });
    });
  });

  push(job, 'log', `${belongs.size} order${belongs.size === 1 ? '' : 's'} on this CPR. ` +
                   'Connecting to QuickBooks...');
  const token = await getAccessToken(realmId);
  if (job.stop) return;

  // the payments that carry this CPR number
  push(job, 'log', 'Reading the payments filed under ' + (sheetCpr || 'this CPR') + '...');
  const byRef = sheetCpr ? await paymentsWithRef(realmId, token, sheetCpr, sheetDate, job) : [];
  if (job.stop) return;
  push(job, 'ok', `${byRef.length} payment${byRef.length === 1 ? '' : 's'} carry that number.`);

  // and the payments sitting on this CPR's own invoices, whatever number they
  // carry - that is how a CPR received under the wrong number is still seen
  push(job, 'log', 'Looking up this CPR’s orders in QuickBooks...');
  const wanted = [];
  belongs.forEach(v => wanted.push(v.number));
  const found = await findInvoices(realmId, token, wanted);
  if (job.stop) return;

  const seenIds = new Set(byRef.map(p => String(p.Id)));
  const extraIds = [];
  found.forEach(inv => (inv.paymentIds || []).forEach(id => {
    if (!seenIds.has(String(id))) extraIds.push(String(id));
  }));
  const others = await fullPaymentsByIds(realmId, token, extraIds, job);
  if (job.stop) return;

  const payments = byRef.concat(others);
  push(job, 'log', `Opening ${payments.length} payment${payments.length === 1 ? '' : 's'}...`);

  // every invoice those payments touch, including ones the sheet never mentions
  const invIds = [];
  payments.forEach(p => linesOf(p).forEach(l => invIds.push(l.invoiceId)));
  const invoices = await invoicesByIds(realmId, token, invIds, job);
  if (job.stop) return;

  const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
  const bank = courier ? (prefs[courier] || null) : null;

  const mine = [], extra = [], wrongCpr = [];
  const paidKeys = new Map();                // order -> what this CPR put on it
  const payRows = [];

  payments.forEach(p => {
    const ref = clean(p.PaymentRefNum);
    const underThis = sheetCpr ? ref === sheetCpr : !!ref;
    const applied = appliedOf(p);
    const total = money(p.TotalAmt);
    const accountId = p.DepositToAccountRef ? String(p.DepositToAccountRef.value) : '';
    const accountName = p.DepositToAccountRef ? (p.DepositToAccountRef.name || '') : '';

    payRows.push({
      id: String(p.Id),
      ref,
      date: p.TxnDate || '',
      total,
      applied,
      unapplied: money(total - applied),
      lines: linesOf(p).length,
      accountId,
      accountName,
      customer: p.CustomerRef ? (p.CustomerRef.name || '') : '',
      underThis,
      wrongDate: !!(underThis && sheetDate && p.TxnDate && p.TxnDate !== sheetDate),
      wrongBank: !!(underThis && bank && bank.accountId && accountId &&
                    accountId !== String(bank.accountId))
    });

    linesOf(p).forEach(l => {
      const inv = invoices.get(l.invoiceId);
      const k = inv ? key(inv.doc) : '';
      const on = k ? belongs.get(k) : null;

      const row = {
        paymentId: String(p.Id),
        ref,
        date: p.TxnDate || '',
        accountId, accountName,
        invoiceId: l.invoiceId,
        doc: inv ? inv.doc : '(gone)',
        customer: inv ? inv.customerName : (p.CustomerRef ? p.CustomerRef.name || '' : ''),
        invoiceTotal: inv ? money(inv.total) : 0,
        invoiceBalance: inv ? money(inv.balance) : 0,
        paid: money(l.amount),
        sheetRow: on ? on.sheetRow : null,
        sheetAmount: on ? on.rowAmount : 0,
        merged: on ? on.merged : false
      };

      if (!underThis) {
        // A payment under another number is only this CPR's business where it is
        // sitting on one of this CPR's own orders - the rest of that payment
        // belongs to whichever CPR it was posted for.
        if (!on) return;
        row.otherRef = ref || '(no CPR number)';
        wrongCpr.push(row);
        return;
      }

      if (!on) {
        extra.push(row);                      // not on this CPR's sheet at all
        return;
      }

      // what the courier says this order was worth; a merged parcel carries one
      // amount for several orders, so the invoice's own total is the measure there
      const expect = (!on.merged && on.rowAmount > 0)
        ? on.rowAmount
        : money(inv ? inv.total : 0);
      row.expect = expect;
      row.over = money(row.paid - expect);
      row.times = 1;
      paidKeys.set(k, money((paidKeys.get(k) || 0) + l.amount));
      mine.push(row);
    });
  });

  // an order paid twice inside the same CPR - the second line is money taken twice
  const counts = new Map();
  mine.forEach(r => {
    const k = key(r.doc);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  mine.forEach(r => { r.times = counts.get(key(r.doc)) || 1; });

  const over = mine.filter(r => r.over > 0.005);
  const twice = mine.filter(r => r.times > 1);

  // the other way round: what the CPR says should have been paid and was not
  const notPaid = [];
  belongs.forEach((v, k) => {
    if (paidKeys.has(k)) return;
    const inv = found.get(clean(v.number).replace(/^#/, '')) || found.get(k);
    notPaid.push({
      number: v.number,
      sheetRow: v.sheetRow,
      sheetAmount: v.rowAmount,
      delivered: v.delivered,
      inQb: !!inv,
      doc: inv ? inv.doc : '',
      invoiceId: inv ? inv.id : '',
      balance: inv ? money(inv.balance) : 0,
      elsewhere: inv
        ? [...new Set(wrongCpr.filter(w => w.invoiceId === String(inv.id))
                              .map(w => w.otherRef))]
        : []
    });
  });

  job.result = {
    kind: 'cpr',
    cpr: sheetCpr || '(no CPR number)',
    cprDate: sheetDate,
    courier: courier || '',
    bank,
    sheetRows: rows.length,
    sheetOrders: belongs.size,
    sheetAmount: money(rows.filter(r => isDelivered(r, hasStatus))
                           .reduce((s, r) => s + r.amount, 0)),
    qbAmount: money(payRows.filter(p => p.underThis).reduce((s, p) => s + p.total, 0)),
    payments: payRows,
    belong: mine,
    extra, over, twice, wrongCpr, notPaid
  };

  push(job, 'ok',
    `${mine.length} paid line${mine.length === 1 ? '' : 's'} belong to this CPR, ` +
    `${extra.length} do not, ${over.length} took too much, ` +
    `${notPaid.length} still unpaid.`);
}

async function checkInvoices(realmId, job) {
  const numbers = (job.body.numbers || []).map(clean).filter(Boolean);
  if (!numbers.length) throw new Error('No order numbers were given');

  push(job, 'log', `Looking up ${numbers.length} order number${numbers.length === 1 ? '' : 's'}...`);
  const token = await getAccessToken(realmId);
  const found = await findInvoices(realmId, token, numbers);
  if (job.stop) return;

  const payIds = [];
  found.forEach(inv => (inv.paymentIds || []).forEach(id => payIds.push(String(id))));
  const payments = await fullPaymentsByIds(realmId, token, payIds, job);
  if (job.stop) return;

  const payById = new Map(payments.map(p => [String(p.Id), p]));
  const out = [];

  numbers.forEach(n => {
    const inv = found.get(clean(n).replace(/^#/, '')) || found.get(key(n)) || null;
    if (!inv) {
      out.push({ number: n, inQb: false, lines: [] });
      return;
    }

    const lines = [];
    (inv.paymentIds || []).forEach(id => {
      const p = payById.get(String(id));
      if (!p) return;
      linesOf(p).filter(l => String(l.invoiceId) === String(inv.id)).forEach(l => {
        lines.push({
          paymentId: String(p.Id),
          ref: clean(p.PaymentRefNum) || '(no CPR number)',
          date: p.TxnDate || '',
          accountName: p.DepositToAccountRef ? (p.DepositToAccountRef.name || '') : '',
          accountId: p.DepositToAccountRef ? String(p.DepositToAccountRef.value) : '',
          paid: money(l.amount),
          paymentTotal: money(p.TotalAmt),
          paymentLines: linesOf(p).length,
          invoiceId: String(inv.id),
          doc: inv.doc
        });
      });
    });

    const paid = money(lines.reduce((s, l) => s + l.paid, 0));
    out.push({
      number: n,
      inQb: true,
      invoiceId: inv.id,
      doc: inv.doc,
      customer: inv.customerName,
      date: inv.date,
      total: money(inv.total),
      balance: money(inv.balance),
      paid,
      over: money(paid - inv.total),
      lines
    });
  });

  job.result = { kind: 'invoices', rows: out };
  push(job, 'ok', `${out.filter(r => r.inQb).length} of ${out.length} found in QuickBooks.`);
}

export function stopCheck(desk) {
  const job = scans.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the read in flight...');
  return true;
}

export function resumeCheck(desk) {
  const realmId = realmOf(desk);
  const job = scans.get(desk);
  if (!job) throw new Error('There is no check to carry on');
  if (job.state === 'running') throw new Error('The check is still going');
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  push(job, 'log', 'Carrying on...');
  runCheck(realmId, job).catch(e => {
    push(job, 'fail', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
  return job.id;
}

export function clearCheck(desk) {
  const job = scans.get(desk);
  if (job && job.state === 'running') return false;
  scans.delete(desk);
  return true;
}

export function checkSnapshot(desk, since, full) {
  const job = scans.get(desk);
  if (!job) return null;
  const out = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId,
    hasResult: !!job.result
  };
  if (full || job.state !== 'running') out.result = job.result;
  return out;
}

/* ==================== putting it right ==================== */

// One payment can be carrying thousands of orders, so a wrong order is taken
// off by rewriting that payment without its line - never by deleting the
// payment, which would unpay everything else on it. The total comes down with
// the line, so no money is left sitting unapplied on the customer.
async function writePayment(realmId, token, pay, lines) {
  const total = money(lines.reduce((s, l) => s + Number(l.Amount || 0), 0));
  const payload = Object.assign({}, pay, { Line: lines, TotalAmt: total, sparse: false });

  const r = await fetch(`${API}/v3/company/${realmId}/payment?minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(faultOf(text));
  return total;
}

async function deletePayment(realmId, token, pay) {
  const r = await fetch(`${API}/v3/company/${realmId}/payment?operation=delete&minorversion=70`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Id: pay.Id, SyncToken: pay.SyncToken })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(faultOf(text));
}

async function readPayment(realmId, token, paymentId) {
  const q = await qbQuery(realmId, token, `SELECT * FROM Payment WHERE Id = '${paymentId}'`);
  return (q.Payment || [])[0] || null;
}

// take one invoice off a payment, or set what that invoice was paid
async function editLine(realmId, token, action, job) {
  const pay = await readPayment(realmId, token, action.paymentId);
  if (!pay) return { ok: true, msg: 'that payment is not in QuickBooks any more' };

  const invId = String(action.invoiceId);
  const kept = [];
  let touched = false;

  (pay.Line || []).forEach(l => {
    const links = l.LinkedTxn || [];
    const mine = links.some(t => t.TxnType === 'Invoice' && String(t.TxnId) === invId);
    if (!mine) { kept.push(l); return; }

    touched = true;
    if (action.kind === 'amount') {
      const amount = money(action.amount);
      if (amount > 0.005) kept.push(Object.assign({}, l, { Amount: amount }));
      // an amount of nothing is the same as taking the line off
      return;
    }
    // 'unlink' - the line goes, unless it is carrying other invoices too
    const rest = links.filter(t => !(t.TxnType === 'Invoice' && String(t.TxnId) === invId));
    if (rest.length) kept.push(Object.assign({}, l, { LinkedTxn: rest }));
  });

  if (!touched) return { ok: true, msg: 'that invoice was not on this payment' };

  const left = kept.filter(l => (l.LinkedTxn || []).some(t => t.TxnType === 'Invoice'));
  if (!left.length) {
    await deletePayment(realmId, token, pay);
    return { ok: true, msg: 'nothing was left on the payment, so the payment went too' };
  }

  const total = await writePayment(realmId, token, pay, kept);
  return { ok: true, msg: 'payment now stands at ' + total.toFixed(2) };
}

export function startFix(desk, body) {
  const realmId = realmOf(desk);
  const live = fixes.get(desk);
  if (live && live.state === 'running') {
    throw new Error('A fix of yours is already going');
  }

  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (!actions.length) throw new Error('Nothing was ticked to put right');

  const job = {
    id: Date.now(),
    state: 'running',
    stop: false,
    actions,
    done: new Set(),
    doneCount: 0,
    failed: 0,
    results: [],
    events: [],
    lastId: 0,
    label: body.label || '',
    startedAt: Date.now(),
    finishedAt: null
  };

  fixes.set(desk, job);
  runFix(realmId, job).catch(e => {
    push(job, 'fail', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
  return job.id;
}

function actionKey(a, i) {
  return [a.kind, a.paymentId || '', a.invoiceId || '', i].join('|');
}

function describe(a) {
  if (a.kind === 'unlink') {
    return `Taking ${a.doc || a.invoiceId} off payment ${a.paymentId}` +
           (a.ref ? ' (' + a.ref + ')' : '');
  }
  if (a.kind === 'amount') {
    return `Setting ${a.doc || a.invoiceId} to ${money(a.amount).toFixed(2)} ` +
           `on payment ${a.paymentId}`;
  }
  if (a.kind === 'delete') {
    return `Deleting payment ${a.paymentId}` + (a.ref ? ' (' + a.ref + ')' : '');
  }
  if (a.kind === 'fix') {
    const bits = [];
    if (a.cprNumber !== undefined) bits.push('CPR ' + a.cprNumber);
    if (a.cprDate) bits.push('dated ' + a.cprDate);
    if (a.accountId) bits.push('bank ' + (a.accountName || a.accountId));
    return `Putting payment ${a.paymentId} right: ` + bits.join(', ');
  }
  return 'Unknown change';
}

async function runFix(realmId, job) {
  push(job, 'log', 'Connecting to QuickBooks...');
  let token = await getAccessToken(realmId);
  const startedWith = job.doneCount;

  for (let i = 0; i < job.actions.length; i++) {
    if (job.stop) break;
    const a = job.actions[i];
    const k = actionKey(a, i);
    if (job.done.has(k)) continue;

    push(job, 'log', describe(a));
    try {
      let msg = '';
      if (a.kind === 'unlink' || a.kind === 'amount') {
        const r = await editLine(realmId, token, a, job);
        msg = r.msg;
      } else if (a.kind === 'delete') {
        const pay = await readPayment(realmId, token, a.paymentId);
        if (!pay) msg = 'already gone';
        else { await deletePayment(realmId, token, pay); msg = 'deleted'; }
      } else if (a.kind === 'fix') {
        const pay = await readPayment(realmId, token, a.paymentId);
        if (!pay) msg = 'already gone';
        else {
          const patch = { Id: pay.Id, SyncToken: pay.SyncToken, sparse: true };
          if (a.cprNumber !== undefined) patch.PaymentRefNum = String(a.cprNumber).slice(0, 21);
          if (a.cprDate) patch.TxnDate = a.cprDate;
          if (a.accountId) patch.DepositToAccountRef = { value: String(a.accountId) };
          const r = await fetch(`${API}/v3/company/${realmId}/payment?minorversion=70`, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify(patch)
          });
          const text = await r.text();
          if (!r.ok) throw new Error(faultOf(text));
          msg = 'put right';
        }
      } else {
        throw new Error('Unknown change: ' + a.kind);
      }

      job.done.add(k);
      job.doneCount++;
      job.results.push({ ok: true, what: describe(a), msg });
      push(job, 'ok', 'OK  ' + msg);
    } catch (e) {
      job.failed++;
      job.results.push({ ok: false, what: describe(a), msg: e.message });
      push(job, 'fail', 'FAILED  ' + String(e.message).slice(0, 220));
    }
  }

  if (job.stop) {
    push(job, 'log', 'Stopped.');
    job.state = 'stopped';
  } else {
    push(job, 'log', `--- ${job.doneCount - startedWith} change` +
                     `${job.doneCount - startedWith === 1 ? '' : 's'} made` +
                     (job.failed ? `, ${job.failed} failed` : '') + ' ---');
    job.state = job.doneCount + job.failed < job.actions.length ? 'stopped' : 'done';
  }
  job.finishedAt = Date.now();
}

export function stopFix(desk) {
  const job = fixes.get(desk);
  if (!job) return false;
  job.stop = true;
  push(job, 'log', 'Stop requested - finishing the change in flight...');
  return true;
}

// what is not done yet goes again - a change already made is never made twice
export function resumeFix(desk) {
  const realmId = realmOf(desk);
  const job = fixes.get(desk);
  if (!job) throw new Error('There is no fix to carry on');
  if (job.state === 'running') throw new Error('The fix is still going');

  const left = job.actions.filter((a, i) => !job.done.has(actionKey(a, i)));
  if (!left.length) throw new Error('Nothing is left to put right');

  job.failed = 0;
  job.stop = false;
  job.state = 'running';
  job.finishedAt = null;
  push(job, 'log', `Carrying on: ${left.length} left.`);
  runFix(realmId, job).catch(e => {
    push(job, 'fail', 'ERROR: ' + e.message);
    job.state = 'error';
    job.finishedAt = Date.now();
  });
  return job.id;
}

export function clearFix(desk) {
  const job = fixes.get(desk);
  if (job && job.state === 'running') return false;
  fixes.delete(desk);
  return true;
}

export function fixSnapshot(desk, since) {
  const job = fixes.get(desk);
  if (!job) return null;
  const left = job.actions.filter((a, i) => !job.done.has(actionKey(a, i))).length;
  const out = {
    id: job.id,
    state: job.state,
    label: job.label,
    total: job.actions.length,
    doneCount: job.doneCount,
    failed: job.failed,
    leftCount: left,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };
  if (job.state !== 'running') out.results = job.results;
  return out;
}
