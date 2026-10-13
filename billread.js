// Reading the supplier's own paper, so an order or a bill does not have to be
// typed out line by line.
//
// The paper that arrives here is not a tidy invoice. It is a photograph of a
// hand-written register in Urdu, or a WhatsApp message a salesman forwarded, or
// a scan of a printed bill - and the same sheet mixes all three habits: a code
// written as "SKU 7601-069", a rate written as "Rate Rs. 195" or just "195/",
// and a quantity that is split across shades which each need their own line.
//
// So there are two separate jobs here, and keeping them apart is the whole
// design:
//
//   1. READING. What does the paper say? That is a question about ink, and it
//      is answered by a model that can look at the picture. It is told to copy
//      what is written and nothing else - it never guesses a product.
//
//   2. MATCHING. Which QuickBooks item is that? That is a question about this
//      company's own item list, and it is answered here, in code, against the
//      real list. A model is never asked to pick an item id.
//
// The second job stays out of the model's hands on purpose. A misread quantity
// is visible on the screen and gets corrected; an item quietly matched to the
// wrong product is a cost booked against the wrong thing, and nobody looks at
// it again.
//
// Nothing here writes to QuickBooks. It fills a form in, and a person still
// presses the button.

import Anthropic from '@anthropic-ai/sdk';

// Opus, not a cheaper model: the hard sheet here is hand-written Urdu with the
// rate and the amount in separate columns, and a rate read wrong is a bill
// entered wrong.
const MODEL = 'claude-opus-5-5';

const MAX_FILES = 10;
const MAX_BYTES = 8 * 1024 * 1024;        // one file
const MAX_TOTAL = 24 * 1024 * 1024;       // everything in one request

const IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function readingIsSetUp() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/* ==================== what the paper is asked for ==================== */

// Every field is required and every absence is an empty string or a zero. A
// schema that lets fields go missing turns every reader of this into a chain of
// guards, and one of them is always forgotten.
const SHEET = {
  type: 'object',
  additionalProperties: false,
  required: ['doc', 'date', 'vendor', 'lines', 'total', 'unsure'],
  properties: {
    doc: { type: 'string', description: 'The supplier\'s own number for this paper - "Bill no 09092026" is 09092026. Empty if there is none.' },
    date: { type: 'string', description: 'The date on the paper as YYYY-MM-DD. "11-9-26" written in Pakistan is 2026-09-11. Empty if there is no date.' },
    vendor: { type: 'string', description: 'The supplier or shop named on the paper, exactly as written. Empty if not named.' },
    total: { type: 'number', description: 'The grand total written at the foot of the paper, or 0 if none is written. Never add the lines up yourself to fill this in.' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'name', 'variant', 'qty', 'rate', 'amount'],
        properties: {
          sku: { type: 'string', description: 'The product code as written - 7601-069, 7101-014. Empty if the line carries no code.' },
          name: { type: 'string', description: 'The product as written - "New foundation", "Lip liner pencil". Translate an Urdu name into English.' },
          variant: { type: 'string', description: 'The shade, colour or number this quantity belongs to - "Ivory 6", "Fair", "N1", "1-12". Empty if the line names no variant.' },
          qty: { type: 'number', description: 'How many pieces, as a number.' },
          rate: { type: 'number', description: 'The price of one piece. "Rate Rs. 195" and "195/" are both 195.' },
          amount: { type: 'number', description: 'The line total if the paper writes one in its own column, otherwise 0. Never work it out yourself.' }
        }
      }
    },
    unsure: {
      type: 'array',
      description: 'One short plain sentence for anything that could not be read off with certainty, naming what and where.',
      items: { type: 'string' }
    }
  }
};

const BRIEF = [
  'You are reading a supplier\'s purchase paper for a cosmetics wholesaler in Pakistan,',
  'so that an order or a bill can be entered into QuickBooks from it.',
  '',
  'The paper is a photograph or a scan. It may be a printed invoice, a hand-written',
  'register in Urdu, or a screenshot of a WhatsApp message. Several pictures may be',
  'pages of one and the same paper - read them together and return one set of lines.',
  '',
  'Copy what is written. Do not improve it, complete it, or work anything out:',
  '',
  '- A product code is written as 7601-069, 7101-014, 7003-036. Keep the hyphen.',
  '- A rate may be written "Rate Rs. 195", "195/", or "195/-". All of those are 195.',
  '- A quantity may be written "288 p", "288 pieces", or just 288. All of those are 288.',
  '- In a hand-written register the columns run right to left: the product and its',
  '  quantity, then the rate, then the amount. The code is often above the line it',
  '  belongs to, not beside it.',
  '',
  'When one product code is written once but its quantity is split across shades',
  '("Ivory 6 = 288, Beige 1 = 144"), that is ONE LINE PER SHADE - each with the same',
  'code and the same rate, and its own quantity. When a quantity covers a range of',
  'shades at once ("All 1728 pieces, variants 1-12"), that is one line with 1728 on it',
  'and "1-12" as the variant.',
  '',
  'Never invent a code, a rate, or a quantity that is not on the paper. If something',
  'is written but cannot be made out, leave that field empty or zero and say so in',
  '"unsure" - a blank that a person fills in is right, and a plausible guess is not.'
].join('\n');

/* ==================== reading it ==================== */

function blockFor(f) {
  const mime = String(f.mimetype || '').toLowerCase();
  const data = f.buffer.toString('base64');

  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (IMAGES.includes(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }
  return null;
}

// `signal` is how Stop reaches the model: the browser drops the request, the
// route aborts this, and nothing is left running and still being charged for.
export async function readPaper(files, { signal } = {}) {
  if (!readingIsSetUp()) {
    throw new Error('Reading the paper is not set up yet — ANTHROPIC_API_KEY has not been put on the server.');
  }

  const taken = [];
  const left = [];
  let bytes = 0;

  for (const f of (files || [])) {
    const block = blockFor(f);
    if (!block) { left.push(f.originalname + ' — only photos and PDFs can be read'); continue; }
    if (f.size > MAX_BYTES) { left.push(f.originalname + ' — over 8 MB, too big to read'); continue; }
    if (taken.length >= MAX_FILES) { left.push(f.originalname + ' — more than ' + MAX_FILES + ' at once'); continue; }
    if (bytes + f.size > MAX_TOTAL) { left.push(f.originalname + ' — too much to read in one go'); continue; }
    bytes += f.size;
    taken.push({ name: f.originalname, block });
  }

  if (!taken.length) {
    throw new Error(left.length ? left[0] : 'Nothing came through that could be read');
  }

  const content = [];
  taken.forEach((t, i) => {
    // the file's own name beside its picture, so "unsure" can say which one
    content.push({ type: 'text', text: 'Picture ' + (i + 1) + ' of ' + taken.length + ' — ' + t.name });
    content.push(t.block);
  });
  content.push({ type: 'text', text: 'Read these and return what is written on them.' });

  const client = new Anthropic();

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: BRIEF,
    output_config: { format: { type: 'json_schema', schema: SHEET } },
    messages: [{ role: 'user', content }]
  }, signal ? { signal } : undefined);

  if (res.stop_reason === 'max_tokens') {
    throw new Error('That is more than can be read in one go — try fewer pages at a time');
  }
  if (res.stop_reason === 'refusal') {
    throw new Error('The reader would not read that picture');
  }

  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let sheet;
  try {
    sheet = JSON.parse(text);
  } catch (e) {
    throw new Error('What came back could not be made sense of — try the picture again');
  }

  return {
    doc: String(sheet.doc || ''),
    date: String(sheet.date || ''),
    vendor: String(sheet.vendor || ''),
    total: Number(sheet.total || 0) || 0,
    lines: (sheet.lines || []).map(l => ({
      sku: String(l.sku || '').trim(),
      name: String(l.name || '').trim(),
      variant: String(l.variant || '').trim(),
      qty: Number(l.qty || 0) || 0,
      rate: Number(l.rate || 0) || 0,
      amount: Number(l.amount || 0) || 0
    })).filter(l => l.sku || l.name || l.qty),
    unsure: (sheet.unsure || []).map(String).filter(Boolean),
    read: taken.map(t => t.name),
    skipped: left
  };
}

/* ==================== which product it is ==================== */

// Codes are written with hyphens, spaces, or nothing at all between the two
// halves, and a register writes in capitals what QuickBooks holds in lower
// case. None of that is a different product.
const flat = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A variant is matched on its parts, not as one string: "Beige 2" in the
// register is "Beige-2", "Beige 02" or "BEIGE2" in the item list, and a plain
// substring test fails on all three.
function variantFits(itemName, variant) {
  const bits = String(variant).toLowerCase().match(/[a-z]+|[0-9]+/g) || [];
  if (!bits.length) return false;
  const name = flat(itemName);
  return bits.every(b => name.includes(b));
}

// What a line was matched to, and - just as important - what it was not. An
// unmatched line comes back with its choices, so the page can say "two products
// carry that code" instead of silently picking the first one.
function matchLine(line, items, bySku) {
  const cands = bySku.get(flat(line.sku)) || [];

  if (cands.length === 1) {
    return { itemId: cands[0].id, itemName: cands[0].name, how: 'sku', choices: [] };
  }

  if (cands.length > 1) {
    // one code, several shades under it - the variant is what tells them apart
    const fit = line.variant ? cands.filter(c => variantFits(c.name, line.variant)) : [];
    if (fit.length === 1) {
      return { itemId: fit[0].id, itemName: fit[0].name, how: 'sku and shade', choices: [] };
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
    return {
      sku: l.sku,
      name: l.name,
      variant: l.variant,
      qty: l.qty,
      rate: l.rate,
      amount: l.amount,
      itemId: m.itemId,
      itemName: m.itemName,
      how: m.how,
      choices: m.choices.map(c => ({ id: c.id, name: c.name, sku: c.sku }))
    };
  });

  return Object.assign({}, sheet, {
    lines,
    matched: lines.filter(l => l.itemId).length
  });
}
