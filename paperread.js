// Reading the supplier's own paper, so an order or a bill does not have to be
// typed out line by line.
//
// What arrives is a photograph of a message the supplier sent - a product, a
// rate, a code, and then the pieces broken down by shade. It is typed text, and
// typed text can be read by a reader that lives inside this app and costs
// nothing to run, every day, for ever. Nothing is sent anywhere. There is no
// account, no key, and no meter.
//
// Three steps, and they are deliberately separate:
//
//   1. OCR. Dots to letters. Tesseract, running here on this server.
//   2. PARSING. Letters to lines, by rule. "Rate Rs. 195" is 195 because the
//      rule says so, not because something judged it - so the same picture
//      gives the same answer today and next year.
//   3. MATCHING. Which QuickBooks item that is, decided against this company's
//      own item list.
//
// The reader will get some characters wrong - it read "Beige 3= 72" as
// "Beige 3-72", and "pieces" as "pIeCes". The rules are written loose enough to
// take that, and whatever still cannot be read is handed back as it was read,
// for a person to put right. Nothing here writes to QuickBooks.

import { createWorker } from 'tesseract.js';
import path from 'path';
import { fileURLToPath } from 'url';

// The language data sits in this repository, not on somebody's CDN: a server
// that has just restarted should be able to read a picture without first being
// able to reach the internet.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESSDATA = path.join(HERE, 'tessdata');

const MAX_FILES = 10;
const MAX_BYTES = 12 * 1024 * 1024;

const PICTURES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

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

export async function readPictures(files) {
  const taken = [];
  const left = [];

  for (const f of (files || [])) {
    const mime = String(f.mimetype || '').toLowerCase();
    if (mime === 'application/pdf') {
      left.push(f.originalname + ' — a PDF cannot be read, only a photo');
      continue;
    }
    if (!PICTURES.includes(mime)) {
      left.push(f.originalname + ' — only photos can be read');
      continue;
    }
    if (f.size > MAX_BYTES) { left.push(f.originalname + ' — over 12 MB'); continue; }
    if (taken.length >= MAX_FILES) { left.push(f.originalname + ' — more than ' + MAX_FILES + ' at once'); continue; }
    taken.push(f);
  }

  if (!taken.length) throw new Error(left.length ? left[0] : 'No photo came through');

  const w = await worker();
  const parts = [];
  let worst = 100;

  for (const f of taken) {
    const { data } = await w.recognize(f.buffer);
    parts.push(data.text || '');
    worst = Math.min(worst, Number(data.confidence || 0));
  }

  return {
    text: parts.join('\n\n'),
    read: taken.map(f => f.originalname),
    skipped: left,
    // how sure the reader was of its own characters - low means the photo was
    // blurred or at an angle, and that is worth saying before the numbers are
    // trusted
    sure: Math.round(worst)
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

const VARWORD = /^variants?\b\s*[:=]?\s*/i;

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

// A product stays open until the next rate line starts another one. That is the
// only thing that reliably marks a new product: blank lines fall wherever the
// photograph happened to break, and the reader puts them in the middle of a
// product as readily as between two.
export function parseSheet(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());

  let doc = '';
  let billWanted = false;

  const out = [];
  let open = null;                 // the product being read
  let pendingShade = '';           // a shade named with no quantity yet
  let pendingQty = 0;              // "All 1728 pieces", waiting to be told which shades
  const unsure = [];

  const shut = () => {
    if (!open) return;
    // a product whose shades never arrived is still a line - the quantity is
    // left empty rather than the whole product being dropped
    if (!open.any) {
      out.push({ sku: open.sku, name: open.name, variant: pendingShade, qty: pendingQty, rate: open.rate });
    }
    open = null;
    pendingShade = '';
    pendingQty = 0;
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

    const lead = tidy(run[1]);
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

    // --- their number for the whole paper ---
    const billHere = raw.match(/\bbill\s*(?:no|number|#)\b\s*[:.#]?\s*([0-9]{3,})?/i);
    if (billHere) {
      if (billHere[1]) doc = billHere[1];
      else billWanted = true;          // it was written on the line below
      continue;
    }
    if (billWanted) {
      const n = raw.match(/^[^\d]{0,3}([0-9]{3,})\b/);
      billWanted = false;
      if (n) { doc = n[1]; continue; }
    }

    // --- a rate starts a new product ---
    const rate = raw.match(RATE);
    if (rate) {
      shut();
      const name = tidy(raw.slice(0, rate.index));
      open = { name: name, rate: num(rate[1]), sku: '', any: false };

      // the code is sometimes on the same line as the rate
      const sameLine = raw.match(SKU);
      if (sameLine) open.sku = sameLine[1] + '-' + sameLine[2];
      continue;
    }

    // --- the code ---
    const sku = raw.match(SKU);
    if (sku) {
      if (open) open.sku = sku[1] + '-' + sku[2];
      else unsure.push('A code was read with no product above it: ' + sku[1] + '-' + sku[2]);
      continue;
    }

    // --- the whole quantity, before the shades are named ---
    const whole = raw.match(WHOLE);
    if (whole) { pendingQty = num(whole[1]); continue; }

    // --- a shade with its own quantity ---
    const body = raw.replace(VARWORD, '');
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
    if (VARWORD.test(raw)) {
      const after = tidy(body);
      if (after) {
        // "variants= 1-12" after "All 1728 pieces" is that whole quantity
        if (pendingQty) { add(after, pendingQty); pendingQty = 0; }
        else pendingShade = after;
      }
      continue;
    }

    // --- anything else ---
    // Before a rate has been seen this is the product's own name running onto a
    // second line. After one, it is something the rules do not know, and saying
    // so is better than dropping it.
    if (!open) continue;
    if (tidy(raw).length > 2) unsure.push('Not understood: ' + tidy(raw));
  }

  shut();

  return {
    doc: doc,
    lines: out.filter(l => l.qty || l.rate).map(l => ({
      sku: l.sku, name: l.name, variant: l.variant,
      qty: l.qty, rate: l.rate, amount: 0
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

function matchLine(line, items, bySku) {
  const cands = bySku.get(flat(line.sku)) || [];

  if (cands.length === 1) {
    return { itemId: cands[0].id, itemName: cands[0].name, how: 'code', choices: [] };
  }

  if (cands.length > 1) {
    const fit = line.variant ? cands.filter(c => shadeFits(c.name, line.variant)) : [];
    if (fit.length === 1) {
      return { itemId: fit[0].id, itemName: fit[0].name, how: 'code and shade', choices: [] };
    }
    return { itemId: '', itemName: '', how: '', choices: cands.slice(0, 12) };
  }

  // no code on the line, or a code this company does not use - the written name
  // is all that is left, and it has to land on exactly one product to be used
  const want = flat(line.name + line.variant);
  if (want.length >= 4) {
    const hit = items.filter(it => flat(it.name) === want);
    if (hit.length === 1) return { itemId: hit[0].id, itemName: hit[0].name, how: 'name', choices: [] };

    const near = items.filter(it => flat(it.name).includes(want));
    if (near.length === 1) return { itemId: near[0].id, itemName: near[0].name, how: 'name', choices: [] };
    if (near.length > 1) return { itemId: '', itemName: '', how: '', choices: near.slice(0, 12) };
  }

  return { itemId: '', itemName: '', how: '', choices: [] };
}

// `items` is this company's own QuickBooks item list - the only list that may
// decide what a line is.
export function matchToItems(sheet, items) {
  const live = (items || []).filter(it => it.active !== false);

  const bySku = new Map();
  live.forEach(it => {
    const k = flat(it.sku);
    if (!k) return;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(it);
  });

  const lines = sheet.lines.map(l => {
    const m = matchLine(l, live, bySku);
    return Object.assign({}, l, {
      itemId: m.itemId, itemName: m.itemName, how: m.how,
      choices: m.choices.map(c => ({ id: c.id, name: c.name, sku: c.sku }))
    });
  });

  return Object.assign({}, sheet, {
    lines: lines,
    matched: lines.filter(l => l.itemId).length
  });
}
