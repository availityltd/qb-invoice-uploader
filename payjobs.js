import { getAccessToken } from './qb.js';
import { postPayment, liveBalances, matchCpr, colourPlan, colourCpr } from './cpr.js';
import { writeStatusSheet, writeStatusExcel } from './sheets.js';
import { recordRun, getSetting, setSetting } from './settings.js';
import { realmOf } from './desk.js';
import { claimIds, releaseIds } from './paylock.js';

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
    desk,
    state: 'running',
    stop: false,
    body,
    total: body.matched.length,
    doneCount: 0,
    posted: 0,
    totalAmount: 0,
    results: [],
    paidInvoices: [],
    skipped: [],
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
    headerRow, statusCol, writeStatus = true, cprKey
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

  // the invoices this desk is holding while it pays them
  const held = [];

  // A row that is not paid, and why. It is not a failure of QuickBooks, and it
  // is not something to try again - it is something to look at.
  function noteSkip(m, why) {
    job.skipped.push({
      invoice: m.invoice, qbDoc: m.qbDoc, customer: m.customerName || '', why
    });
    job.doneCount++;
    job.results.push({
      ok: false, customer: m.customerName || '', count: 1, msg: `${m.invoice} - ${why}`
    });
  }

  // The balances are read again, here, immediately before the money goes
  // across, and every line is cut down to what its invoice still owes. The
  // figures a match carries are the figures of the moment the sheet was
  // searched; by the time Receive is pressed the invoice may already be part
  // paid or settled - by another CPR, or by the person at the next desk.
  // Handing QuickBooks the older, larger figure is what leaves money sitting
  // unapplied, or as a credit on the customer, against an invoice that reads
  // as received. Nothing more than the invoice owes now is ever sent.
  async function prepare(custId, lines) {
    const ids = [];
    lines.forEach(m => openParts(m).forEach(p => { if (p.qbId) ids.push(String(p.qbId)); }));

    const { mine, taken } = claimIds(realmId, job.desk, ids);
    held.push(...mine);
    const busy = new Set(taken);

    push(job, 'log', 'Checking what these invoices still owe...');
    const live = await liveBalances(realmId, token, mine);
    const owes = new Map(mine.map(id => [id, live.has(id) ? live.get(id) : 0]));

    const ready = [];
    for (const m of lines) {
      const parts = openParts(m).filter(p => p.qbId);
      if (!parts.length) {
        noteSkip(m, 'there is no QuickBooks invoice behind it');
        continue;
      }

      // half a merged row is no use to anyone: if any part of it is in
      // somebody else's payment this second, the whole row waits for them
      if (parts.some(p => busy.has(String(p.qbId)))) {
        noteSkip(m, 'somebody else is receiving it at this moment - left for them');
        push(job, 'fail', `LEFT  ${m.invoice} - somebody else is receiving it right now`);
        continue;
      }

      const use = [];
      for (const p of parts) {
        const id = String(p.qbId);
        const owed = owes.has(id) ? owes.get(id) : 0;
        const want = Math.round(Number(p.amount || 0) * 100) / 100;
        const amount = Math.round(Math.min(want, owed) * 100) / 100;
        if (!(amount > 0.005)) continue;
        owes.set(id, Math.round((owed - amount) * 100) / 100);
        use.push({ qbId: id, qbDoc: p.qbDoc, amount });
      }

      if (!use.length) {
        noteSkip(m, 'already settled in QuickBooks - not received a second time');
        push(job, 'fail', `SKIPPED  ${m.invoice} - already settled in QuickBooks`);
        continue;
      }

      const asked = Math.round(parts.reduce(
        (s, p) => s + Math.round(Number(p.amount || 0) * 100) / 100, 0) * 100) / 100;
      const amount = Math.round(use.reduce((s, x) => s + x.amount, 0) * 100) / 100;
      if (Math.round((asked - amount) * 100) / 100 > 0.005) {
        push(job, 'log',
          `${m.invoice} was part paid already - receiving ${amount.toFixed(2)} of ${asked.toFixed(2)}.`);
      }

      ready.push({ m, parts: use, amount });
    }

    return ready;
  }

  // sends one payment; if QB chokes on the size, halves it and tries again
  async function sendPart(custId, entries, label, depth) {
    if (job.stop) return;

    // the total is the sum of the lines QuickBooks is being given, to the
    // cent, so there is nothing left over to sit unapplied
    const amount = Math.round(entries.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    const who = entries[0].m.customerName || custId;
    const tag = label ? ` (${label})` : '';

    push(job, 'log', `Sending ${entries.length} invoices for ${who}${tag}...`);

    const payload = {
      CustomerRef: { value: String(custId) },
      TotalAmt: amount,
      DepositToAccountRef: { value: String(accountId) },
      Line: entries.flatMap(e => e.parts.map(p => ({
        Amount: p.amount,
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
      job.doneCount += entries.length;

      entries.forEach(e => {
        if (e.m.sheetRow) paidRows.push(e.m.sheetRow);
        job.paidInvoices.push({
          invoice: e.m.invoice,
          qbDoc: e.m.qbDoc,
          customer: e.m.customerName || '',
          amount: e.amount
        });
      });

      job.results.push({
        ok: true,
        customer: who + tag,
        count: entries.length,
        amount,
        paymentId: r.id
      });
      push(job, 'ok', `OK  ${who}${tag} - ${entries.length} invoices`);
      return;
    }

    // too big for QuickBooks - cut it in half and send both halves
    if (entries.length > 1 && depth < 2) {
      push(job, 'log', `QuickBooks refused ${entries.length} at once - splitting in two.`);
      const half = Math.ceil(entries.length / 2);
      await sendPart(custId, entries.slice(0, half), `${label || 'part'} a`, depth + 1);
      await sendPart(custId, entries.slice(half), `${label || 'part'} b`, depth + 1);
      return;
    }

    job.doneCount += entries.length;
    job.results.push({ ok: false, customer: who + tag, count: entries.length, msg: r.msg });
    push(job, 'fail', `FAILED  ${who}${tag} - ${String(r.msg).slice(0, 200)}`);
  }

  for (const [custId, lines] of byCustomer) {
    if (job.stop) break;

    if (!custId || custId === 'none') {
      job.doneCount += lines.length;
      job.results.push({ ok: false, msg: 'Invoices with no customer were skipped', count: lines.length });
      continue;
    }

    try {
      const entries = await prepare(custId, lines);
      if (!entries.length) continue;

      if (entries.length <= SPLIT_ABOVE) {
        await sendPart(custId, entries, '', 0);
        continue;
      }

      // over the limit, so it goes in two halves rather than many small ones
      const half = Math.ceil(entries.length / 2);
      push(job, 'log', `${entries.length} invoices for this customer - sending as 2 payments.`);
      await sendPart(custId, entries.slice(0, half), 'part 1 of 2', 0);
      if (!job.stop) await sendPart(custId, entries.slice(half), 'part 2 of 2', 0);
    } finally {
      // the hold lasts as long as the payment does, and no longer
      releaseIds(realmId, job.desk, held.splice(0, held.length));
    }
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

  // which CPR to read again: the one the page was on. Without it there is no
  // telling this CPR's rows from the rest of the tab, and a whole tab is not
  // ours to colour.
  const colourKey = cprKey === 'All rows' ? '(no CPR number)' : (cprKey || cprNumber || '');

  // Colouring the sheet is part of the run, and it happens here - on the
  // server, where the run lives.
  //
  // It used to be the page's job: when the run finished, the browser read the
  // CPR again and then coloured. Which meant it only happened if somebody was
  // still sitting on that page, with that CPR open - and the log said
  // "Colouring the sheet... Process complete" either way, so a sheet that was
  // never touched read as a sheet that had been. Anyone who left the page
  // while the payments went through, as the page invites them to, came back to
  // a finished run and an uncoloured sheet.
  //
  // Now the run reads the CPR again itself and puts the colours in. It happens
  // once, before the run is called done, so the log tells the truth and every
  // computer watching sees the same thing.
  if (job.posted > 0 && sheetId && tab && !colourKey) {
    push(job, 'log', 'This run does not say which CPR it was, so the sheet is left as it is.');
  } else if (job.posted > 0 && sheetId && tab) {
    if (excel) {
      // only a Google Sheet has colours the API can reach
      push(job, 'log', 'The sheet is an Excel workbook, so it cannot be coloured - ' +
                       'only a Google Sheet can.');
    } else {
      try {
        push(job, 'log', 'Reading this CPR again, so the colours match what it now says...');

        // the run can be long, and the sign-in behind it only lasts the hour
        const fresh = await matchCpr(realmId, await getAccessToken(realmId), {
          sheetId, tab, courier, excel: false,
          cpr: colourKey
        });

        const plan = colourPlan(fresh);
        if (!plan.length) {
          push(job, 'log', 'No row needed a colour.');
        } else {
          push(job, 'log', 'Colouring the sheet...');
          const done = await colourCpr(sheetId, tab, plan);
          const t = done.tally || {};
          const bits = [];
          if (t.green)  bits.push(`${t.green} received`);
          if (t.yellow) bits.push(`${t.yellow} amount differs`);
          if (t.orange) bits.push(`${t.orange} under another CPR`);
          if (t.red)    bits.push(`${t.red} not in QuickBooks`);
          job.coloured = { painted: done.painted, tally: t };
          push(job, 'ok', `Coloured ${done.painted} rows` + (bits.length ? ' - ' + bits.join(', ') : ''));
        }
      } catch (e) {
        job.results.push({
          ok: false,
          msg: 'The payments are recorded; only the colouring did not finish: ' + e.message
        });
        push(job, 'fail', 'The sheet could not be coloured: ' + e.message);
      }
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
    push(job, 'ok', '--- Process complete ---');
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
  const done = new Set(job.paidInvoices.map(key));
  // a row already settled in QuickBooks, or being paid by another desk, was
  // put aside on purpose - carrying on does not go back for it
  (job.skipped || []).forEach(x => done.add(key(x)));
  const left = job.body.matched.filter(m => !done.has(key(m)));
  if (!left.length) throw new Error('Nothing is left to receive');

  job.results = job.results.filter(r => r.ok);
  job.doneCount = job.paidInvoices.length + (job.skipped || []).length;
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

// End process. Stop leaves the run sitting on the server so it can be carried
// on from where it stopped; End means the run is over - whatever is left is
// dropped and nothing of it stays behind, not even after a restart. What is
// already written is not undone.
export function endPayJob(desk) {
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


export function paySnapshot(desk, since, full) {
  const job = jobs.get(desk);
  if (!job) return null;

  const out = {
    id: job.id,
    state: job.state,
    total: job.total,
    doneCount: job.doneCount,
    leftCount: Math.max(0, job.total - job.paidInvoices.length - (job.skipped || []).length),
    posted: job.posted,
    amount: Math.round(job.totalAmount * 100) / 100,
    stamped: job.stamped,
    coloured: job.coloured || null,
    cprNumber: job.body.cprNumber || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: job.lastId
  };

  if (full || job.state !== 'running') {
    out.results = job.results;
    out.paidInvoices = job.paidInvoices;
    out.skipped = job.skipped || [];
  }

  return out;
}
