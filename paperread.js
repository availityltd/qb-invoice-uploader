// Reading the supplier's own paper, so an order or a bill does not have to be
// typed out line by line.
//
// What arrives is whatever the supplier happened to send. A photograph of a
// message - a product, a rate, a code, and the pieces broken down by shade. A
// PDF out of their own software. A scan of a printed bill. A Word file, or a
// sheet. Every one of them is read here, and nothing is sent anywhere: there is
// no account, no key, and no meter.
//
// Four steps, and they are deliberately separate:
//
//   1. OPENING. The file turned into text, by what kind of file it is. That is
//      paperfile.js, and for everything except a photograph it is exact - a PDF
//      carries its own text, and text taken out of it cannot be misread.
//   2. OCR. Dots to letters, for the pictures: a photograph, or the pictures
//      inside a PDF that is really a scan. Tesseract, running on this server.
//   3. PARSING. Letters to lines, by rule. "Rate Rs. 195" is 195 because the
//      rule says so, not because something judged it - so the same picture
//      gives the same answer today and next year. Two shapes of paper are
//      known: a message typed out shade by shade, and a printed table with a
//      heading row over its columns.
//   4. MATCHING. Which QuickBooks item that is, decided against this company's
//      own item list.
//
// The reader will get some characters wrong - it read "Beige 3= 72" as
// "Beige 3-72", and "pieces" as "pIeCes". The rules are written loose enough to
// take that, and whatever still cannot be read is handed back as it was read,
// for a person to put right. Nothing here writes to QuickBooks.

import { createWorker } from 'tesseract.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { kindOf, openPaper, MAX_BYTES } from './paperfile.js';

// The language data sits in this repository, not on somebody's CDN: a server
// that has just restarted should be able to read a picture without first being
// able to reach the internet.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESSDATA = path.join(HERE, 'tessdata');

const MAX_FILES = 10;

/* ==================== dots to letters ==================== */

// One worker for the whole process, started the first time somebody reads
// something. Starting one costs a second or two, and starting a fresh one per
// picture would be the slowest part of the job.
let workerOnce = null;

function worker() {
  if (!workerOnce) {
    workerOnce = createWorker('eng', 1, {
      langPath: TESSDATA,
      cachePath: TESSDATA,
      gzip: false,
      legacyCore: false
    }).catch(e => { workerOnce = null; throw e; });
  }
  return workerOnce;
}

// Every file that came through, in the order they were dropped, each one opened
// according to what it is and only read letter by letter where there was no
// text to take. A file that cannot be opened is said so by name and the rest
// still go through: one locked PDF should not take a whole bill down with it.
export async function readPapers(files) {
  const taken = [];
  const left = [];

  for (const f of (files || [])) {
    const kind = kindOf(f);
    if (!kind) { left.push(f.originalname + ' — this kind of file cannot be read'); continue; }
    if (f.size > MAX_BYTES) {
      left.push(f.originalname + ' — over ' + Math.round(MAX_BYTES / 1024 / 1024) + ' MB');
      continue;
    }
    if (taken.length >= MAX_FILES) {
      left.push(f.originalname + ' — more than ' + MAX_FILES + ' at once');
      continue;
    }
    taken.push({ file: f, kind: kind });
  }

  if (!taken.length) throw new Error(left.length ? left[0] : 'No file came through');

  const parts = [];
  const read = [];
  const how = [];
  let worst = 100;
  let looked = false;          // whether anything had to be read letter by letter

  for (const t of taken) {
    let opened;
    try {
      opened = await openPaper(t.file, t.kind);
    } catch (e) {
      left.push(t.file.originalname + ' — ' + e.message);
      continue;
    }

    const bits = [];
    for (const piece of opened.parts) {
      if (piece.text != null) { bits.push(piece.text); continue; }
      looked = true;
      const w = await worker();
      const { data } = await w.recognize(piece.picture);
      const said = data.text || '';
      bits.push(said);

      // Only a picture that gave up some words has an opinion worth having
      // about how clear it was. A logo on a cover page reads as two letters the
      // reader is rightly unsure of, and that is no reason to doubt the bill.
      if (said.replace(/[^A-Za-z0-9]/g, '').length >= 10) {
        worst = Math.min(worst, Number(data.confidence || 0));
      }
    }

    parts.push(bits.join('\n'));
    read.push(t.file.originalname);
    how.push(t.file.originalname + ' — ' + opened.how);
  }

  if (!read.length) throw new Error(left[0] || 'Nothing could be read');

  return {
    text: parts.join('\n\n'),
    read: read,
    skipped: left,
    // what each file was read as, so "nothing matched" can be told apart from
    // "that PDF was a scan and the scan was crooked"
    how: how,
    // how sure the reader was of its own characters - low means the photo was
    // blurred or at an angle, and that is worth saying before the numbers are
    // trusted. Text taken out of a PDF or a sheet was not read, it was taken,
    // so there is nothing to be unsure about.
    sure: looked ? Math.round(worst) : 100,
    looked: looked
  };
}

/* ==================== letters to lines ==================== */

const num = s => Number(String(s).replace(/[,\s]/g, '')) || 0;

// "Rate Rs. 195", "rate Rs . 45", "Rate Rs 450", "Rate: 465/-"
const RATE = /\brate\b\s*(?:rs|rupees)?\s*[.:]?\s*(?:rs)?\s*[.:]?\s*([\d][\d,]*(?:\.\d+)?)/i;

// "SKU 7601-069", "sku: 7101-014", "SKU # 7003-036" - and the hyphen comes back
// as a dash or an en-dash often enough to be worth allowing
const SKU = /\bsku\b\s*[:#.]?\s*([0-9]{3,6})\s*[-–—]\s*([0-9]{2,5})/i;

// "Ivory 6= 288 pieces", "Beige 3-72 pieces", "N2=122pIeCes", "Fair= 5760 pcs".
// The word for pieces has to be there: it is what tells a shade written
// "1-12" apart from a shade with a quantity after it.
const SHADE = /^(.{1,40}?)\s*[=:\-–—]\s*([\d][\d,]*)\s*(?:p\w*|nos?\b)/i;

// a line that is nothing but a quantity - the shade was named on the line above
const ALONE = /^([\d][\d,]*)\s*(?:p\w*|nos?\b)\s*[.,]?$/i;

// "All 1728 pieces" - the whole of it, before the shades it covers are named
const WHOLE = /^all\s+([\d][\d,]*)\s*(?:p\w*)/i;

// The word for a shade, however it was spelt or read. A register types
// "Vairant M1" as readily as "Variant M1", and the reader turns one into the
// other anyway - and a word misspelt must not end up inside the shade, where it
// stops the shade finding its product.
const VARWORD = /^(?:for\s+|each\s+|every\s+)?(?:v[ao]?[ai]?r[ia]?[ae]?nts?|shades?|colou?rs?)\b\s*[:=]?\s*/i;

// "Product name: Setting spray", "Item: Fancy Chiffon" - the name written on
// its own line, above the code and the rate.
const NAMED = /^(?:product\s*name|product|item\s*name|item|name|design|article|material)\s*[:=-]\s*(.+)$/i;

// "(pieces 192 each)", "192 pieces each", "(192 pcs)" - a quantity that belongs
// to each of the shades named beside it, not to all of them together.
const PER = [
  /^(.*?)\s*[([]?\s*(?:pieces?|pcs?|nos?)\s*[:=]?\s*([\d][\d,]*)\s*(?:each|per|ea|every)?\s*[)\]]?\s*\.?$/i,
  /^(.*?)\s*[([]?\s*([\d][\d,]*)\s*(?:pieces?|pcs?|nos?)\s*(?:each|per|ea|every)?\s*[)\]]?\s*\.?$/i
];

// "Each variant 80 pieces", "All 240 pieces" - that many of every shade this
// code has, with no shade named anywhere. Which shades those are is not written
// on the paper at all: the supplier means whatever shades the code has, and the
// only place that knows them is this company's own item list. So the quantity
// is carried through as "every shade", and the shades are filled in at matching
// where the list is.
const EACH = /^(?:each|every|per)\s+(?:v[ao]?[ai]?r[ia]?[ae]?nts?|shades?|colou?rs?)\s*[:=]?\s*([\d][\d,]*)\s*(?:p\w*|nos?\b)/i;

// Words that sit in front of a run of shades and are not part of any shade's
// name: "from 629 to 663" is shades 629 to 663, and not shade "from 629".
const LEADIN = /^(?:from|between|v[ao]?[ai]?r[ia]?[ae]?nts?|shades?|colou?rs?|no\.?|number|#)\s*/i;

// "1-12", "01 - 12", "Beige 1 to 4" - a run of shades written as its two ends.
// The quantity beside it belongs to EACH of them, not to all of them together:
// when one shade in a run is different it is taken out and written on its own
// line, which is exactly what the New foundation block does.
const RUN = /^(.{0,24}?)\s*([0-9]{1,3})\s*(?:[-–—]|to)\s*([0-9]{1,3})\s*$/i;

const MOST_SHADES = 60;

// Reading noise, not content: WhatsApp's own clock, ticks, "Edited".
const NOISE = /^(?:edited|[\d:apm\s.]{0,12}(?:am|pm)[\s\d:.]*|[^\w\d]{0,4})$/i;

function tidy(s) {
  return String(s).replace(/\s+/g, ' ').replace(/^[^\w\d]+|[^\w\d)\]]+$/g, '').trim();
}

/* ---------- a printed table ---------- */

// A bill out of a supplier's own software is a table, and its heading row is
// what says which column is which. Nothing is assumed about the order of them:
// a bill with AMOUNT before QTY is as common as the other way round, and a
// quantity read as a rate is a cost booked at a hundred times what it was.
//
// Columns reach here as tabs, put in by whatever opened the file. Where there
// are none - a reader looking at a photograph of a table has only the white
// space to go on, and puts no tabs anywhere - two spaces or more stand in for
// one. Runs of tabs are not run together: an empty box between two columns is
// the thing that says which column the next number is in, and a row that loses
// its empty boxes is a row whose quantity is read as a rate.
const cut = s => s.indexOf('\t') >= 0 ? s.split('\t') : s.split(/ {2,}/);

const HEADINGS = [
  ['sku', /^(?:sku|code|item\s*(?:code|no\.?|#)|art(?:icle)?(?:\s*(?:no\.?|code|#))?|design(?:\s*no\.?)?|cat(?:alogue)?\s*(?:no\.?|#))\b/i],
  ['name', /^(?:description|particulars?|items?|products?|goods|details?|narration|material)\b/i],
  ['variant', /^(?:shade|colou?rs?|variants?|sizes?)\b/i],
  ['qty', /^(?:qty|quantity|pcs|pieces|nos\.?|units?|packs?|bales?|meters?|mtrs?)\b/i],
  ['rate', /^(?:rate|price|unit\s*(?:rate|price|cost)|cost|per)\b/i],
  ['amount', /^(?:amount|amt|total|value|net)\b/i]
];

// "Rs 1,234", "1234.50", "1,368/-", "288 pcs" - a number as a bill writes one.
const MONEY = /^(?:rs\.?|pkr|₨)?\s*-?\s*([\d][\d,]*(?:\.\d+)?)\s*(?:\/-|rs\.?|pcs?\.?|pieces?|nos?\.?|mtrs?\.?)?$/i;

// the foot of the table: their own totals, taxes and carriage, which are not
// lines on an order and must never become products
const FOOT = /^(?:sub\s*total|total|grand\s*total|net\s*(?:total|amount|payable)|tax|gst|sales\s*tax|s\.?tax|discount|freight|carriage|shipping|packing|labour|advance|balance|paid|less|add|round(?:ing)?|in\s*words|amount\s*in\s*words)\b/i;

// a code as a cell of its own, and a code sitting inside the description
const CODE_CELL = /^([0-9]{3,6})\s*[-–—]\s*([0-9]{2,5})$/;
const CODE_IN = /\b([0-9]{3,6})\s*[-–—]\s*([0-9]{2,5})\b/;

const looksNum = c => MONEY.test(tidy(c));
const cellNum = c => { const m = tidy(c).match(MONEY); return m ? num(m[1]) : 0; };

// Is this the heading row? It has to name something to call the line by and
// something to count or price it with. One word on its own line is a sentence.
function heading(cells) {
  const at = {};
  let hits = 0;

  cells.forEach((c, i) => {
    const t = tidy(c);
    if (!t || t.length > 24) return;
    for (const [field, re] of HEADINGS) {
      if (!re.test(t)) continue;
      if (at[field] == null) { at[field] = i; hits++; }
      break;
    }
  });

  if (hits < 2) return null;
  if (at.qty == null && at.rate == null && at.amount == null) return null;
  if (at.name == null && at.sku == null) return null;

  at.width = cells.length;
  return at;
}

// One row of the table, read against that heading row.
//
// A row with exactly as many cells as the heading is read column by column. A
// short row - a description that spilled over, a cell left empty, a merged box
// - is read from the right instead, because a table loses cells on its left far
// more often than it loses the amount off its end.
function tableLine(cells, cols) {
  const at = i => (i == null || i >= cells.length) ? '' : tidy(cells[i]);
  let qty = 0, rate = 0, amount = 0, name = '', variant = '', sku = '';

  if (cells.length === cols.width) {
    qty = cellNum(at(cols.qty));
    rate = cellNum(at(cols.rate));
    amount = cellNum(at(cols.amount));
    name = at(cols.name);
    variant = at(cols.variant);
    sku = at(cols.sku);
  } else {
    const body = cells.slice();

    // the serial number down the left of a printed bill counts the lines, it
    // does not count the pieces on one
    if (body.length > 2 && /^[0-9]{1,4}[.)]?$/.test(tidy(body[0])) &&
        cols.qty !== 0 && cols.rate !== 0 && cols.amount !== 0) body.shift();

    const words = [];
    const numbers = [];
    body.forEach(c => {
      const t = tidy(c);
      if (!t) return;
      (looksNum(t) ? numbers : words).push(t);
    });

    const order = [['qty', cols.qty], ['rate', cols.rate], ['amount', cols.amount]]
      .filter(o => o[1] != null)
      .sort((a, b) => a[1] - b[1])
      .map(o => o[0]);

    const keep = Math.min(order.length, numbers.length);
    const fields = order.slice(order.length - keep);
    const values = numbers.slice(numbers.length - keep);
    const got = {};
    fields.forEach((f, i) => { got[f] = cellNum(values[i]); });

    qty = got.qty || 0;
    rate = got.rate || 0;
    amount = got.amount || 0;

    // A line with no quantity is not a line. An empty box in the middle of a
    // printed row leaves no mark on the page - a PDF shows one wide gap where
    // there were two - so a row that came up short and lost its quantity is
    // read by shape instead: the first number on it is the quantity, which is
    // the one thing a line cannot do without, and the last is what the line
    // came to.
    if (!qty && numbers.length) {
      qty = cellNum(numbers[0]);
      amount = numbers.length > 1 ? cellNum(numbers[numbers.length - 1]) : 0;
      rate = numbers.length > 2 ? cellNum(numbers[numbers.length - 2]) : 0;
    }

    sku = words.filter(w => CODE_CELL.test(w))[0] || '';
    name = words.filter(w => !CODE_CELL.test(w)).join(' ');
  }

  const code = (sku.match(CODE_CELL) || sku.match(CODE_IN) ||
                (name + ' ' + at(cols.sku)).match(CODE_IN));
  sku = code ? code[1] + '-' + code[2] : tidy(sku);

  // where the paper priced the line but never said the rate, the rate is what
  // its own two numbers come to - and it is shown, so it can be checked
  if (!rate && amount && qty) rate = Math.round(amount / qty * 100) / 100;

  if (!(qty || rate)) return null;
  if (!name && !sku) return null;

  return { sku: sku, name: name, variant: variant, qty: qty, rate: rate, amount: amount };
}

/* ---------- the date on it ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DATED = /\b(?:date|dated|bill\s*date|invoice\s*date|order\s*date)\b\s*[:.]?\s*([0-9]{1,2})\s*[-\/.\s]\s*([0-9]{1,2}|[a-z]{3,9})\s*[-\/.\s]\s*([0-9]{2,4})\b/i;

// Day first, which is how a date is written here. A date is only taken when a
// paper actually called it one - a number that merely looks like a date, picked
// off a line that never said so, would be a bill dated by accident.
function whichDay(m) {
  const day = Number(m[1]);
  const mon = /^[0-9]+$/.test(m[2]) ? Number(m[2]) : MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  let year = Number(m[3]);
  if (year < 100) year += 2000;

  if (!(day >= 1 && day <= 31) || !(mon >= 1 && mon <= 12)) return '';
  if (!(year >= 2000 && year <= 2099)) return '';

  const two = n => (n < 10 ? '0' : '') + n;
  return year + '-' + two(mon) + '-' + two(day);
}

// A product stays open until the next rate line starts another one. That is the
// only thing that reliably marks a new product: blank lines fall wherever the
// photograph happened to break, and the reader puts them in the middle of a
// product as readily as between two.
export function parseSheet(text) {
  // Trailing white space goes, and so do spaces down the left of a line - but
  // not a tab down the left of one, which is an empty first column and not
  // nothing at all.
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/^ +|\s+$/g, ''));

  // The date the paper gave itself is looked for over the whole of it, once,
  // rather than line by line: it sits beside the bill number as often as it
  // sits on a line of its own, and either way it is the same date.
  const when = String(text || '').match(DATED);

  let doc = '';
  let billWanted = false;
  const date = when ? whichDay(when) : '';
  let total = 0;                   // the total it wrote at its own foot

  const out = [];
  let open = null;                 // the product being read
  let pendingName = '';            // a name written above the code and the rate
  let pendingShade = '';           // a shade named with no quantity yet
  let pendingQty = 0;              // "All 1728 pieces", waiting to be told which shades
  let pendingEvery = false;        // and that quantity meant every shade the code has
  let cols = null;                 // the heading row of a printed table, once seen
  const unsure = [];

  const shut = () => {
    if (!open) return;
    if (!open.any) {
      // A run of shades named here with its quantity named further down - "from
      // 629 to 663", then "All 240 pieces" - is still a run, and it becomes a
      // line each the same way as one written the other way round.
      if (pendingShade && pendingQty) add(pendingShade, pendingQty);
      // a product whose shades never arrived is still a line - the quantity is
      // left empty rather than the whole product being dropped. Where the paper
      // said "each" or "all" and named no shade, that is not a shade missing:
      // it is every shade the code has, and the item list is asked for them.
      else {
        out.push({
          sku: open.sku, name: open.name, variant: pendingShade,
          qty: pendingQty, rate: open.rate,
          every: pendingEvery && pendingQty > 0 && !pendingShade
        });
      }
    }
    open = null;
    pendingShade = '';
    pendingQty = 0;
    pendingEvery = false;
  };

  const one = (variant, qty) => {
    if (!open) { unsure.push('A quantity was read before any product: ' + variant + ' ' + qty); return; }
    out.push({ sku: open.sku, name: open.name, variant: tidy(variant), qty: qty, rate: open.rate });
    open.any = true;
  };

  // "1-12" with 1728 pieces is twelve shades of 1728 each, so it becomes twelve
  // lines - one per shade, which is what a bill needs, since each shade is its
  // own product in QuickBooks.
  const add = (variant, qty) => {
    const run = tidy(variant).match(RUN);
    if (!run) return one(variant, qty);

    const lead = tidy(run[1].replace(LEADIN, ''));
    const from = Number(run[2]);
    const to = Number(run[3]);
    const wide = Math.max(run[2].length, run[3].length);   // "01-12" stays 01, 02...

    // a misread that turns into hundreds of lines is worse than one line nobody
    // can place, so a run that is not a sane run is left exactly as it was read
    if (!(to > from) || to - from + 1 > MOST_SHADES) return one(variant, qty);

    for (let n = from; n <= to; n++) {
      let tag = String(n);
      while (tag.length < wide) tag = '0' + tag;
      one(lead ? lead + ' ' + tag : tag, qty);
    }
  };

  for (const raw of lines) {
    if (!raw || NOISE.test(raw)) continue;

    // A line of a printed table, kept as its columns; and the same line with
    // the columns flattened back to spaces, which is what the rules for a
    // typed-out message expect to be given.
    const cells = cut(raw);
    const plain = raw.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();

    // --- their number for the whole paper ---
    const billHere = plain.match(/\b(?:bill|invoice|inv|challan|chalan|order)\s*(?:no|number|#)\b\s*[:.#]?\s*([A-Za-z0-9][A-Za-z0-9\/-]{2,20})?/i);
    if (billHere) {
      if (billHere[1]) doc = billHere[1];
      else billWanted = true;          // it was written on the line below
      continue;
    }
    if (billWanted) {
      const n = plain.match(/^[^\d]{0,3}([0-9]{3,})\b/);
      billWanted = false;
      if (n) { doc = n[1]; continue; }
    }

    // --- a line that is nothing but the date, which has been read already ---
    if (plain.length <= 40 && DATED.test(plain)) continue;

    // --- the heading row of a printed table ---
    // This comes before everything else: a heading row is not a product, and a
    // table whose heading was missed is a table read by the wrong rules.
    if (cells.length >= 3) {
      const head = heading(cells);
      if (head) { shut(); cols = head; continue; }
    }

    // --- a rate starts a new product ---
    const rate = plain.match(RATE);
    if (rate) {
      shut();
      // A rate written into the line is how a message names a product, and a
      // message is not a table. Two papers read one after the other - a
      // printed bill and then a photograph of a message - must not have the
      // first one's columns read into the second.
      cols = null;

      // The name on the rate line, with the code taken off it first. A line
      // that reads "SKU : 7505-007   Rate: Rs. 390" names no product at all -
      // it carries the code and the rate, and the name was written on the line
      // above it. Calling the product "SKU : 7505-007" is how a line ends up
      // matching nothing: there is no product by that name anywhere.
      let said = tidy(plain.slice(0, rate.index).replace(SKU, ' ').replace(CODE_IN, ' '));
      const label = said.match(NAMED);
      if (label) said = tidy(label[1]);

      open = {
        name: /[a-z]{2}/i.test(said) ? said : pendingName,
        rate: num(rate[1]), sku: '', any: false
      };
      pendingName = '';

      // the code is sometimes on the same line as the rate
      const sameLine = plain.match(SKU);
      if (sameLine) open.sku = sameLine[1] + '-' + sameLine[2];
      continue;
    }

    // --- the name, written on its own line above the code ---
    const named = plain.match(NAMED);
    if (named) { pendingName = tidy(named[1]); continue; }

    // --- the code ---
    const sku = plain.match(SKU);
    if (sku) {
      if (open) open.sku = sku[1] + '-' + sku[2];
      else unsure.push('A code was read with no product above it: ' + sku[1] + '-' + sku[2]);
      continue;
    }

    // --- the whole quantity, before the shades are named ---
    // "All 240 pieces" with the shades named after it is that many of each of
    // them; with no shades named anywhere, it is that many of every shade the
    // code has, which comes to the same thing once the list is asked.
    const whole = plain.match(WHOLE);
    if (whole) { pendingQty = num(whole[1]); pendingEvery = true; continue; }

    // --- "Each variant 80 pieces" ---
    // Against a run already named, it is that many of each of those. On its
    // own, it is that many of every shade the code has.
    const each = plain.match(EACH);
    if (each) {
      if (pendingShade) { add(pendingShade, num(each[1])); pendingShade = ''; }
      else { pendingQty = num(each[1]); pendingEvery = true; }
      continue;
    }

    // --- a shade with its own quantity ---
    const body = plain.replace(VARWORD, '');
    const shade = body.match(SHADE);
    if (shade) { add(shade[1], num(shade[2])); pendingShade = ''; continue; }

    // --- a quantity on its own: it belongs to the shade named above ---
    const alone = body.match(ALONE);
    if (alone) {
      add(pendingShade, num(alone[1]));
      pendingShade = '';
      continue;
    }

    // --- the word "variants", with or without a shade after it ---
    if (VARWORD.test(plain)) {
      // "For variant 1-6 (pieces 192 each)" - the shades and how many of each,
      // on one line, with the quantity written behind the shades instead of in
      // front of them
      let done = false;
      for (const per of PER) {
        const both = body.match(per);
        if (both && tidy(both[1]) && num(both[2])) {
          add(tidy(both[1]), num(both[2]));
          pendingShade = '';
          done = true;
          break;
        }
      }
      if (done) continue;

      const after = tidy(body);
      if (after) {
        // "variants= 1-12" after "All 1728 pieces" is that whole quantity
        if (pendingQty) { add(after, pendingQty); pendingQty = 0; }
        else pendingShade = after;
      }
      continue;
    }

    // --- a row of a printed table ---
    // Only a line that actually has columns in it. A message typed shade by
    // shade has none, and it has already been given to the rules above.
    if (cols && cells.length >= 2) {
      // What the row calls itself: the first thing written on it that is not a
      // number. A total is written against the money it belongs to as often as
      // it is written down the left of the page, and either way that word is
      // the first word on the row.
      const label = cells.map(tidy).filter(c => c && !looksNum(c))[0] || '';

      if (FOOT.test(label)) {
        // their own total, kept to check the lines against, not made a line
        const numbers = cells.map(tidy).filter(looksNum).map(cellNum);
        if (/^(?:grand\s*total|total|net\s*(?:total|amount|payable))\b/i.test(label) && numbers.length) {
          total = Math.max(total, numbers[numbers.length - 1]);
        }
        continue;
      }

      const row = tableLine(cells, cols);
      if (row) { out.push(row); continue; }

      // a row of a table that is not a line of it - a column of headings
      // continued, a note written across the box - is left alone rather than
      // reported, because a printed bill is full of them
      continue;
    }

    // --- anything else ---
    // Before a rate has been seen, a line of words is the product's own name,
    // written above its code: it is kept, and used if the rate line turns out
    // to carry nothing but a code. After a rate, it is something the rules do
    // not know, and saying so is better than dropping it.
    const rest = tidy(plain);
    if (!open) {
      if (rest.length <= 80 && /[a-z]{2}/i.test(rest)) pendingName = rest;
      continue;
    }
    if (rest.length > 2) unsure.push('Not understood: ' + rest);
  }

  shut();

  return {
    doc: doc,
    date: date,
    // what the paper said it came to. The lines are what they are either way -
    // this is only ever shown next to them, so a bill whose lines do not add up
    // to its own total is seen before it is made.
    total: total,
    lines: out.filter(l => l.qty || l.rate).map(l => ({
      sku: l.sku, name: l.name, variant: l.variant,
      qty: l.qty, rate: l.rate, amount: l.amount || 0,
      // this quantity is each, of every shade the code has - the shades
      // themselves are filled in where the item list is
      every: !!l.every
    })),
    unsure: unsure
  };
}

/* ==================== which product it is ==================== */

// Codes are written with hyphens, spaces, or nothing at all between the two
// halves, and a register writes in capitals what QuickBooks holds in lower
// case. None of that is a different product.
const flat = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A shade is matched on its parts, not as one string: "Beige 2" in the message
// is "Beige-2", "Beige 02" or "BEIGE2" in the item list, and a plain substring
// test fails on all three.
// A number in a shade is compared as a number, never as text. Shade 1 is item
// "... 01" and it is NOT item "... 12", but "01" read as text is inside "12" on
// one side and misses "1" on the other - and that is a whole shade of stock
// booked against the wrong product.
function shadeFits(itemName, variant) {
  const bits = String(variant).toLowerCase().match(/[a-z]+|[0-9]+/g) || [];
  if (!bits.length) return false;

  const name = flat(itemName);
  const numbers = (String(itemName).match(/[0-9]+/g) || []).map(Number);

  return bits.every(b => /^[0-9]+$/.test(b)
    ? numbers.indexOf(Number(b)) >= 0
    : name.includes(b));
}

const hit = (it, how) => ({ itemId: it.id, itemName: it.name, desc: it.desc || '', how: how, choices: [] });
const miss = (choices) => ({ itemId: '', itemName: '', desc: '', how: '', choices: choices || [] });

// One code, several products under it: the shade is what tells them apart.
function narrow(cands, line, how) {
  if (cands.length === 1) return hit(cands[0], how);

  const fit = line.variant ? cands.filter(c => shadeFits(c.name, line.variant)) : [];
  if (fit.length === 1) return hit(fit[0], how + ' and shade');

  return miss((fit.length ? fit : cands).slice(0, 12));
}

// The shade as it might have been written onto the end of the code. "01" and
// "1" are the same shade, so both are tried; "Beige 2" is tried whole and never
// as its bare 2, because a 2 on the end of a code is not a promise of anything.
function shadeKeys(variant) {
  const whole = flat(variant);
  if (!whole) return [];

  const keys = [whole];
  const plain = String(variant).trim();
  if (/^0\d+$/.test(plain)) keys.push(String(Number(plain)));
  else if (/^\d+$/.test(plain)) keys.push('0' + plain);

  return keys;
}

// Every product under one code: the code written exactly, the code with
// something hung off the end of it, and the code written into the item's own
// name. The same three places a single line looks, asked to hand back all of
// them instead of one.
function family(code, items, bySku, byStart) {
  const seen = new Set();
  const all = [];

  const take = it => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    all.push(it);
  };

  (bySku.get(code) || []).forEach(take);
  byStart.filter(it => it.flatSku.indexOf(code) === 0).forEach(take);
  items.filter(it => {
    const at = it.flatName.indexOf(code);
    return at >= 0 && !(at > 0 && /[0-9]/.test(it.flatName[at - 1]));
  }).forEach(take);

  return all;
}

// What tells one product of a code apart from the next: whatever is written
// after the code in its own code or its own name. "7601-019/Beige3" is Beige3.
// It is read off the written form, not the flattened one, because this is shown
// to a person.
function tailOf(it, code) {
  const spaced = code.split('').join('[^A-Za-z0-9]*') + '[^A-Za-z0-9]*(.*)$';
  for (const where of [it.sku, it.name]) {
    const m = String(where || '').match(new RegExp(spaced, 'i'));
    if (m && tidy(m[1])) return tidy(m[1]);
  }
  return '';
}

function matchLine(line, items, bySku, byStart) {
  const code = flat(line.sku);

  if (code) {
    // The code with the shade on the end of it, as one whole code. This comes
    // first and it is the one that has to: a list can hold 7101-014/1 and also
    // 7101-014/1 L-17/1, which is a different product that merely begins the
    // same way. Asked for 7101-014 shade 1, only the first of those is it.
    for (const k of shadeKeys(line.variant)) {
      const joined = bySku.get(code + k) || [];
      if (joined.length) return narrow(joined, line, 'code and shade');
    }

    const exact = bySku.get(code) || [];
    if (exact.length) return narrow(exact, line, 'code');

    // Only now the loose reading: the paper carries the code of the group and
    // QuickBooks hangs something off the end of it. More than one family can
    // begin the same way, so whatever comes back still has to be told apart by
    // its shade before it is taken.
    const longer = byStart.filter(it => it.flatSku.indexOf(code) === 0);
    if (longer.length) return narrow(longer, line, 'code');

    // The code is written into the item's own name as often as it is put in the
    // code field - QuickBooks names a shade "Full Coverage Concealer
    // 7601-001/Fair" - and a company that never filled the code field in still
    // writes the code where a person can read it. That is the same code, so it
    // is looked for there too rather than reporting a product that is sitting
    // in the list as missing.
    // A digit in front of the code means this is the tail end of a longer code
    // and a different product. What hangs off the end of it is allowed: that is
    // QuickBooks' own way of naming the shades under one code, and the shade is
    // what tells those apart.
    const inName = items.filter(it => {
      const at = it.flatName.indexOf(code);
      return at >= 0 && !(at > 0 && /[0-9]/.test(it.flatName[at - 1]));
    });
    if (inName.length) return narrow(inName, line, 'code in the name');
  }

  // no code on the line, or a code this company does not use - the written name
  // is all that is left, and it has to land on exactly one product to be used
  const want = flat(line.name + line.variant);
  if (want.length >= 4) {
    const same = items.filter(it => it.flatName === want);
    if (same.length === 1) return hit(same[0], 'name');

    const near = items.filter(it => it.flatName.includes(want));
    if (near.length === 1) return hit(near[0], 'name');
    if (near.length > 1) return miss(near.slice(0, 12));
  }

  return miss([]);
}

// `items` is this company's own QuickBooks item list - the only list that may
// decide what a line is.
export function matchToItems(sheet, items) {
  // Every name and code is flattened once here, not once per line. A bill of
  // ninety lines against a list of several thousand products is ninety
  // thousand comparisons, and they should not each be rewriting a string.
  const live = (items || []).filter(it => it.active !== false)
    .map(it => Object.assign({ flatName: flat(it.name), flatSku: flat(it.sku) }, it));

  const bySku = new Map();
  const byStart = [];
  live.forEach(it => {
    const k = it.flatSku;
    if (!k) return;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(it);
    byStart.push(it);
  });

  const lines = [];

  sheet.lines.forEach(l => {
    // "Each variant 80 pieces" - eighty of every shade this code has. The paper
    // does not say which shades those are and does not have to: the supplier
    // means all of them, and all of them is a thing only the item list knows.
    // So one line on the paper becomes one line per shade here.
    const code = flat(l.sku);
    if (l.every && code) {
      const all = family(code, live, bySku, byStart);

      // A code that answers with half the catalogue was read wrong, or it is
      // the start of several families. Hundreds of lines nobody asked for are
      // worse than one line to be picked by hand, so that is left as it was.
      if (all.length > 1 && all.length <= MOST_SHADES) {
        all.forEach(it => lines.push(Object.assign({}, l, {
          variant: tailOf(it, code) || l.variant,
          every: false,
          itemId: it.id, itemName: it.name, how: 'every shade under the code',
          desc: it.desc || '', choices: []
        })));
        return;
      }
    }

    const m = matchLine(l, live, bySku, byStart);
    lines.push(Object.assign({}, l, {
      itemId: m.itemId, itemName: m.itemName, how: m.how,
      // QuickBooks' own wording for this product. Nothing about the description
      // should come off the photograph: the product already carries one, and
      // that is the one the bill ought to say.
      desc: m.desc || '',
      choices: m.choices.map(c => ({ id: c.id, name: c.name, sku: c.sku }))
    }));
  });

  return Object.assign({}, sheet, {
    lines: lines,
    matched: lines.filter(l => l.itemId).length
  });
}
