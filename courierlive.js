// Everything the dashboard shows, asked from the courier at the moment it is
// asked for. Nothing is written down. A short memory of the last answer keeps
// a page refresh from making the courier repeat itself.

import { listAccounts, getAccount } from './couriers.js';
import { adapter as postexAdapter } from './postex.js';

const ADAPTERS = { postex: postexAdapter };

// account id + span -> { at, orders }
const recent = new Map();
const HOLD = 90 * 1000;

function keyOf(id, from, to) { return id + '|' + from + '|' + to; }

async function ordersFor(acc, from, to) {
  const k = keyOf(acc.id, from, to);
  const hit = recent.get(k);
  if (hit && Date.now() - hit.at < HOLD) return hit.orders;

  const a = ADAPTERS[acc.courier];
  if (!a) return [];

  const orders = await a.fetchOrders(acc.token, from, to, 0);
  recent.set(k, { at: Date.now(), orders });

  // keep the memory small
  if (recent.size > 40) {
    const oldest = [...recent.entries()].sort((x, y) => x[1].at - y[1].at)[0];
    recent.delete(oldest[0]);
  }

  return orders;
}

export function forget(accountId) {
  [...recent.keys()].forEach(k => {
    if (k.split('|')[0] === String(accountId)) recent.delete(k);
  });
}

// which accounts this view covers
async function accountsFor(realmId, { account, courier }) {
  if (account) {
    const one = await getAccount(realmId, Number(account));
    return one ? [one] : [];
  }
  const all = await listAccounts(realmId);
  const live = all.filter(a => ADAPTERS[a.courier]);
  return courier ? live.filter(a => a.courier === courier) : live;
}

const r2 = v => Math.round(Number(v || 0) * 100) / 100;

function nextDay(s) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// the portal's own arithmetic, done here so every page agrees
export function summarise(orders, from, to) {
  const groups = {};
  const statuses = {};
  const cities = {};
  const byDay = {};

   let amount = 0, fee = 0, tax = 0, payout = 0;
  let codPaid = 0, codPending = 0, pendingOrders = 0;

  const SETTLED = { delivered: 1, returned: 1, cancelled: 1, expired: 1, lost: 1, damaged: 1 };

  orders.forEach(o => {
    const g = o.statusGroup;
    if (!groups[g]) groups[g] = { count: 0, amount: 0 };
    groups[g].count++;
    groups[g].amount += o.amount;

    const s = o.status || '(blank)';
    if (!statuses[s]) statuses[s] = { count: 0, amount: 0, group: g };
    statuses[s].count++;
    statuses[s].amount += o.amount;

        amount += o.amount;
    fee += o.fee;
    tax += o.tax;
    payout += o.payout || 0;

    // the courier counts what it owes, not what the customer was billed
    if (g === 'delivered') codPaid += (o.payout || 0);
    else if (!SETTLED[g]) { codPending += o.amount; pendingOrders++; }

    if (o.city) cities[o.city] = (cities[o.city] || 0) + 1;

    const d = o.bookedOn;
    if (d) {
      if (!byDay[d]) byDay[d] = { day: d, orders: 0, delivered: 0, amount: 0 };
      byDay[d].orders++;
      byDay[d].amount += o.amount;
    }

    const dd = o.deliveredOn;
    if (dd) {
      if (!byDay[dd]) byDay[dd] = { day: dd, orders: 0, delivered: 0, amount: 0 };
      byDay[dd].delivered++;
    }
  });

  // every day in the span gets a slot, even the quiet ones
  const daily = [];
  let cur = from, guard = 0;
  while (cur <= to && guard < 400) {
    const d = byDay[cur] || { day: cur, orders: 0, delivered: 0, amount: 0 };
    daily.push({ day: d.day, orders: d.orders, delivered: d.delivered, amount: r2(d.amount) });
    cur = nextDay(cur); guard++;
  }

  // newest first, so the page can show the last few movements
  const moved = orders
    .filter(o => o.deliveredOn || o.bookedOn)
    .sort((a, b) => String(b.deliveredOn || b.bookedOn).localeCompare(String(a.deliveredOn || a.bookedOn)))
    .slice(0, 25)
    .map(o => ({
      tracking: o.tracking,
      orderRef: o.orderRef,
      amount: r2(o.amount),
      status: o.status,
      statusGroup: o.statusGroup,
      city: o.city,
      on: o.deliveredOn || o.bookedOn
    }));

  const g = k => groups[k] || { count: 0, amount: 0 };
  const delivered = g('delivered'), returned = g('returned');
  const settledCount = delivered.count + returned.count;

  return {
    totals: {
      orders: orders.length,
      amount: r2(amount),
            fee: r2(fee),
      tax: r2(tax),
      payout: r2(payout),
      codPaid: r2(codPaid),
      codPending: r2(codPending),
      pendingOrders,
      deliveredAmount: r2(delivered.amount),
      codPaid: r2(codPaid),
      successRate: settledCount ? r2(100 * delivered.count / settledCount) : 0,
      returnRate: settledCount ? r2(100 * returned.count / settledCount) : 0
    },
    groups: Object.keys(groups)
      .map(k => ({ group: k, count: groups[k].count, amount: r2(groups[k].amount) }))
      .sort((a, b) => b.count - a.count),
    statuses: Object.keys(statuses)
      .map(k => ({ status: k, group: statuses[k].group, count: statuses[k].count, amount: r2(statuses[k].amount) }))
      .sort((a, b) => b.count - a.count),
    cities: Object.keys(cities)
      .map(k => ({ city: k, count: cities[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    daily,
    recent: moved
  };
}

// the whole picture, live
export async function liveStats(realmId, opts) {
  const { from, to } = opts;
  const accounts = await accountsFor(realmId, opts);
  if (!accounts.length) return { from, to, accounts: [], noAccounts: true, ...summarise([], from, to) };

  const all = [];
  const perAccount = [];
  const trouble = [];

  for (const acc of accounts) {
    try {
      const orders = await ordersFor(acc, from, to);
      all.push(...orders);

      const s = summarise(orders, from, to);
      perAccount.push({
        id: acc.id,
        label: acc.label,
        courier: acc.courier,
        orders: orders.length,
        delivered: (s.groups.find(x => x.group === 'delivered') || {}).count || 0,
        returned: (s.groups.find(x => x.group === 'returned') || {}).count || 0,
        amount: s.totals.amount,
        deliveredAmount: s.totals.deliveredAmount,
        codPending: s.totals.codPending,
        successRate: s.totals.successRate
      });
    } catch (e) {
      trouble.push({ id: acc.id, label: acc.label, error: e.message });
    }
  }

  return Object.assign(
    { from, to, accounts: perAccount, trouble, pulledAt: new Date().toISOString() },
    summarise(all, from, to)
  );
}

// one parcel, wherever it is
export async function trackOne(realmId, tracking, accountId) {
  const list = accountId
    ? [await getAccount(realmId, Number(accountId))].filter(Boolean)
    : (await listAccounts(realmId)).filter(a => ADAPTERS[a.courier]);

  const wanted = String(tracking || '').trim();
  if (!wanted) throw new Error('Give a tracking number');

  for (const acc of list) {
    const a = ADAPTERS[acc.courier];
    if (!a || !a.fetchPayment) continue;

    try {
      const pay = await a.fetchPayment(acc.token, wanted);
      if (!pay || !pay.tracking) continue;

      // whatever the last pull knows about this parcel fills in the rest
      let order = null;
      for (const [, v] of recent) {
        const hit = (v.orders || []).find(o => o.tracking === pay.tracking);
        if (hit) { order = hit; break; }
      }

      return {
        found: true,
        account: { id: acc.id, label: acc.label, courier: acc.courier },
        payment: pay,
        order: order ? {
          tracking: order.tracking,
          orderRef: order.orderRef,
          status: order.status,
          statusGroup: order.statusGroup,
          amount: order.amount,
          fee: order.fee,
          tax: order.tax,
          city: order.city,
          bookedOn: order.bookedOn,
          pickedOn: order.pickedOn,
          deliveredOn: order.deliveredOn
        } : null
      };
    } catch (e) { /* the next account may know it */ }
  }

  return { found: false, tracking: wanted };
}
// the orders behind one number on the dashboard
export async function liveOrders(realmId, opts) {
  const { from, to, status, group } = opts;
  const accounts = await accountsFor(realmId, opts);

  const rows = [];
  for (const acc of accounts) {
    let orders = [];
    try { orders = await ordersFor(acc, from, to); } catch (e) { continue; }

    orders.forEach(o => {
      if (status && o.status !== status) return;
      if (group && o.statusGroup !== group) return;
      rows.push({
        account: acc.label,
        tracking: o.tracking,
        orderRef: o.orderRef,
        status: o.status,
        statusGroup: o.statusGroup,
        amount: r2(o.amount),
        fee: r2(o.fee),
        tax: r2(o.tax),
        city: o.city,
        bookedOn: o.bookedOn,
        pickedOn: o.pickedOn,
        deliveredOn: o.deliveredOn
      });
    });
  }

  rows.sort((a, b) => String(b.bookedOn || '').localeCompare(String(a.bookedOn || '')));
  return {
    from, to, status: status || null, group: group || null,
    count: rows.length,
    amount: r2(rows.reduce((s, x) => s + x.amount, 0)),
    orders: rows.slice(0, 500)
  };
}
// one untouched row, exactly as the courier sent it
export async function peekRaw(realmId, opts) {
  const accounts = await accountsFor(realmId, opts);
  if (!accounts.length) return { error: 'No accounts' };

  const orders = await ordersFor(accounts[0], opts.from, opts.to);
  const one = opts.status
    ? orders.find(o => o.status === opts.status)
    : orders.find(o => o.statusGroup === 'delivered');

  const names = {};
  orders.forEach(o => { names[o.status] = (names[o.status] || 0) + 1; });

  return { statusNames: names, sample: one ? one.raw : null };
}
