// Whose run it is.
//
// Everything that takes a while - an upload, a void, a search of the courier
// sheets - lives on the server rather than in the page, so closing the laptop
// does not end it. It used to be kept under the company's name, which meant
// two people signed into the same company saw one another's runs and shared
// one Stop button. QuickBooks does not work that way: two people are two
// desks, each with their own work in front of them, in the same set of books.
//
// So a run is kept under a desk: the company and the person together. The
// company is still what QuickBooks is asked about and what the books are
// written to - that never changes - but whose run it is, is this.

const SEP = '|';

export function deskKey(realmId, sub) {
  return String(realmId || '') + SEP + String(sub || '');
}

// A realm id has no separator in it, so the first one divides the two halves
// whatever the sign-in name turns out to look like.
export function realmOf(desk) {
  const s = String(desk == null ? '' : desk);
  const at = s.indexOf(SEP);
  return at < 0 ? s : s.slice(0, at);
}

export function userOf(desk) {
  const s = String(desk == null ? '' : desk);
  const at = s.indexOf(SEP);
  return at < 0 ? '' : s.slice(at + 1);
}
