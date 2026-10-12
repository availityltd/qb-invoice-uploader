// Two desks, one set of books.
//
// A run belongs to a desk, but the invoices in it do not. The same invoice can
// sit in two people's work at once - two CPRs, or a CPR at one desk and the
// advance sheet at another - and QuickBooks will take a payment for it twice
// without a word. The second one has nothing left to apply to, so it lands as
// unapplied money, or as a credit on the customer, against an invoice that
// already reads as received. That is what people saw when two of them received
// at the same time; by hand, in QuickBooks, they would have seen the invoice
// gone from the list.
//
// So while a payment is in flight, the invoices on it are held for the desk
// that is paying them. Another desk is told, and leaves those rows for them.
// The hold lasts as long as the payment does and no longer, and it lives in
// this one place so every page that receives money respects the same one.

const held = new Map();                          // realmId -> Map(qbId -> desk)

function book(realmId) {
  let m = held.get(realmId);
  if (!m) { m = new Map(); held.set(realmId, m); }
  return m;
}

// Takes what is free; says what somebody else is already paying.
export function claimIds(realmId, desk, ids) {
  const m = book(realmId);
  const mine = [];
  const taken = [];
  (ids || []).forEach(id => {
    const key = String(id);
    if (!key) return;
    const by = m.get(key);
    if (by && by !== desk) { taken.push(key); return; }
    m.set(key, desk);
    mine.push(key);
  });
  return { mine, taken };
}

export function releaseIds(realmId, desk, ids) {
  const m = book(realmId);
  (ids || []).forEach(id => {
    const key = String(id);
    if (m.get(key) === desk) m.delete(key);
  });
  if (!m.size) held.delete(realmId);
}
