// Whatever the supplier actually sent, opened and turned into text.
//
// A photograph is not the only thing that lands on this page. The same bill
// arrives as a PDF printed out of the supplier's own software, as a Word file
// somebody typed, as a spreadsheet, and as a photograph of a register. Only the
// photograph has to be read letter by letter, and only the photograph can be
// read wrong: every other kind of file carries its own text, and taking that
// text out of it is exact and instant.
//
// So a file is opened according to what it is:
//
//   PDF        the text it carries, page by page. A PDF that came out of a
//              scanner carries none - it is photographs in a wrapper - and then
//              the pictures inside it are handed back to be read instead, page
//              by page and top to bottom.
//   DOCX       the text of the document, which is XML inside a zip.
//   XLSX, CSV  the rows of the sheet.
//   picture    handed straight back; there is nothing to open.
//   DOC        the Word format from before 2007 is not text in a zip, it is a
//              database of records, and it is not read here. Saved as .docx, or
//              printed to PDF, the same file reads.
//
// Columns are kept. A printed bill is a table, and 288 under QTY and 195 under
// RATE only say anything once it is known which column each sat in - so a wide
// gap between two words comes back as a tab, and the rules that turn text into
// lines can split on it.
//
// Nothing is sent anywhere. All of this runs here, on this server, on files
// that are already in memory because they were going onto the transaction
// anyway.

import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import XLSX from 'xlsx';

// The biggest file worth opening. QuickBooks itself takes 25 MB, and a file
// over this is almost always a scan at a resolution nobody needed.
export const MAX_BYTES = 20 * 1024 * 1024;

const PICTURE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
const PICTURE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

const ext = s => {
  const m = String(s || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

// What a file is, decided on its name first. A browser hands up
// application/octet-stream often enough - from a phone, from a download, from a
// WhatsApp export - and the name is the thing the person can actually see.
export function kindOf(file) {
  const name = ext(file.originalname);
  const mime = String(file.mimetype || '').toLowerCase();

  if (name === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (name === 'docx' || mime.includes('wordprocessingml')) return 'docx';
  if (name === 'xlsx' || name === 'xlsm' || name === 'xls' || name === 'csv' ||
      mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel' ||
      mime === 'text/csv') return 'sheet';
  if (PICTURE_EXTS.includes(name) || PICTURE_MIMES.includes(mime)) return 'picture';
  if (name === 'txt' || name === 'text' || mime === 'text/plain') return 'text';
  if (name === 'doc') return 'doc';
  return '';
}

/* ==================== a zip, which is what a .docx is ==================== */

// A .docx is a zip holding word/document.xml. Node can already inflate - that
// is the whole of what reading one takes - so there is no library here for it.
// The central directory at the end of the file says where each thing inside it
// starts; the local header at that spot says how much of the name and the extra
// field to step over before the bytes themselves.
function unzipOne(buf, want) {
  let end = -1;
  // the end record is last in the file, after a comment that may be 64 KB long
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { end = i; break; }
  }
  if (end < 0) throw new Error('this does not look like a .docx');

  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);

  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const how = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const where = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);

    if (name === want) {
      if (packed === 0xffffffff || where === 0xffffffff) throw new Error('this .docx is too big to open here');
      if (how !== 0 && how !== 8) throw new Error('this .docx is packed in a way that cannot be opened here');
      const nLen = buf.readUInt16LE(where + 26);
      const eLen = buf.readUInt16LE(where + 28);
      const from = where + 30 + nLen + eLen;
      const raw = buf.subarray(from, from + packed);
      return how === 0 ? raw : zlib.inflateRawSync(raw);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const unxml = s => String(s)
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ENTITIES[n]);

// A paragraph ends a line. A cell ends a column, so it becomes a tab: a bill
// typed into a Word table is a table, and it has to come out as one.
function openDocx(file) {
  const xml = unzipOne(file.buffer, 'word/document.xml');
  if (!xml) throw new Error('there is no document inside this .docx');

  const text = unxml(xml.toString('utf8')
    .replace(/<w:tab\b[^>]*>/g, '\t')
    .replace(/<w:br\b[^>]*>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]*>/g, ''))
    .split(/\n/)
    .map(l => l.replace(/ {2,}/g, ' ').replace(/\t+$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  if (!/\w/.test(text)) throw new Error('there is no text in this .docx, only pictures');
  return { parts: [{ text: text }], how: 'read as text' };
}

/* ==================== a sheet ==================== */

// Every row of every sheet, columns kept as tabs. Reading a sheet costs nothing
// and gets nothing wrong, so all of it is read and the rules decide what counts.
function openSheet(file) {
  const wb = XLSX.read(file.buffer, { type: 'buffer', raw: false, cellDates: false });
  const out = [];

  wb.SheetNames.slice(0, 8).forEach(name => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    grid.forEach(row => {
      out.push((row || []).map(c => String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ').trim())
        .join('\t').replace(/\t+$/, ''));
    });
    out.push('');
  });

  const text = out.join('\n');
  if (!/\w/.test(text)) throw new Error('this sheet is empty');
  return { parts: [{ text: text }], how: 'read as rows' };
}

/* ==================== a PDF ==================== */

// Loaded the first time a PDF arrives, not when the server starts: a server
// that only ever sees photographs should not pay for this.
let pdfOnce = null;
function pdflib() {
  if (!pdfOnce) {
    pdfOnce = import('pdfjs-dist/legacy/build/pdf.mjs').catch(e => { pdfOnce = null; throw e; });
  }
  return pdfOnce;
}

// The fourteen fonts a PDF is allowed to name without carrying them, which ship
// inside the library itself. They are wanted for the widths of the letters, not
// to draw anything - and without them a PDF that names Helvetica fills the log
// with a warning for every page of it.
const fonts = (() => {
  try {
    const built = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const dir = path.join(path.dirname(built), '..', '..', 'standard_fonts') + path.sep;
    return fs.existsSync(dir) ? dir : undefined;
  } catch (e) {
    return undefined;
  }
})();

const PDF_PAGES = 30;        // pages whose text is taken, which is quick
const SCAN_PER_PAGE = 12;    // a scanner often cuts one page into strips
const ENOUGH = 40;           // letters on a page that count as the page having text

// A page read letter by letter takes the better part of a minute on the machine
// this runs on, and the browser is waiting on the answer the whole time. Four
// pages is a supplier's bill twice over; a sixty-page scan is a different job
// from the one this page is for, and it says so rather than hanging.
const SCAN_PAGES = 4;
const SCAN_PIXELS = 60e6;

// The text of a page, put back into lines.
//
// A PDF does not hold lines. It holds a few hundred runs of letters, each with
// the spot on the page it was drawn at, in whatever order the program that made
// it felt like. So the runs are gathered by how far up the page they sit, then
// sorted across it - and the gap between one run and the next is what says
// whether they are two words or two columns.
function pageText(items) {
  const rows = [];

  for (const it of items) {
    if (!it.str || !/\S/.test(it.str)) continue;
    const y = it.transform[5];
    const high = Math.abs(it.transform[3]) || it.height || 10;

    let row = null;
    for (const r of rows) if (Math.abs(r.y - y) <= Math.max(1.5, r.high * 0.4)) { row = r; break; }
    if (!row) { row = { y: y, high: high, runs: [] }; rows.push(row); }

    row.runs.push({ x: it.transform[4], wide: it.width || 0, s: it.str });
    row.high = Math.max(row.high, high);
  }

  // in a PDF the foot of the page is zero, so the top of it is the biggest y
  rows.sort((a, b) => b.y - a.y);

  return rows.map(r => {
    r.runs.sort((a, b) => a.x - b.x);
    let line = '';
    let endOfLast = null;

    for (const run of r.runs) {
      if (endOfLast !== null) {
        const gap = run.x - endOfLast;
        line += gap > r.high * 0.55 ? '\t' : gap > r.high * 0.08 ? ' ' : '';
      }
      line += run.s;
      endOfLast = run.x + run.wide;
    }
    return line.replace(/[ \t]+$/, '');
  });
}

/* --- the pictures inside a page, for a PDF that is really a scan --- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let r = -1;
  for (let i = 0; i < buf.length; i++) r = crcTable[(r ^ buf[i]) & 0xFF] ^ (r >>> 8);
  return (r ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// The reader takes a picture file, not a wall of pixels, so the pixels are
// wrapped into a PNG. Nothing is resized or thrown away on the way: a picture
// that is about to be read letter by letter wants every pixel it has.
//
// What comes out of a PDF is one of three shapes, and in the one-bit shape a
// set bit is white - which is what a PNG means by it too.
function toPng(width, height, kind, data) {
  const shape = kind === 3 ? { type: 6, depth: 8, stride: width * 4 }
              : kind === 2 ? { type: 2, depth: 8, stride: width * 3 }
              : kind === 1 ? { type: 0, depth: 1, stride: (width + 7) >> 3 }
              : null;
  if (!shape || !width || !height) return null;

  const pixels = Buffer.from(data.buffer || data, data.byteOffset || 0, data.length);
  const raw = Buffer.alloc((shape.stride + 1) * height, 0xff);

  for (let y = 0; y < height; y++) {
    raw[y * (shape.stride + 1)] = 0;                       // no filter on this row
    const from = y * shape.stride;
    if (from >= pixels.length) break;                      // a cut-short picture stays white below
    pixels.copy(raw, y * (shape.stride + 1) + 1, from, Math.min(from + shape.stride, pixels.length));
  }

  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = shape.depth;
  head[9] = shape.type;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Which pictures a page paints, and where down the page each one sits.
//
// The order matters, and it is not the order they happen to be listed in. A
// scan is often one page cut into six strips, and a rate read above the shades
// it belongs to is a different bill from the same strips shuffled. So the
// drawing is followed as the page itself would be drawn - every save, restore
// and transform - and the pictures come back in the order a person reads them.
function picturesOnPage(ops, OPS) {
  const times = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  const paints = [OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject]
    .filter(n => n != null);

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = times(ctm, ops.argsArray[i]);
    else if (paints.includes(fn)) {
      const name = ops.argsArray[i] && ops.argsArray[i][0];
      if (typeof name === 'string') found.push({ name: name, y: ctm[5], x: ctm[4] });
    }
  }

  found.sort((a, b) => b.y - a.y || a.x - b.x);
  return found;
}

// A picture is kept with the page that paints it, unless the same picture is
// used on several pages, in which case it is kept once for the whole document.
function pictureData(page, name) {
  const bags = [page.objs, page._transport && page._transport.commonObjs];
  for (const bag of bags) {
    if (!bag) continue;
    try {
      const got = bag.get(name);
      if (got && got.data && got.kind) return got;
    } catch (e) { /* not in this one, or not ready: try the other */ }
  }
  return null;
}

async function openPdf(file) {
  const { getDocument, OPS } = await pdflib();

  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(file.buffer),
      isEvalSupported: false,
      isOffscreenCanvasSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: fonts,
      // only real errors. A PDF written by a label printer or a bank is full of
      // things worth a warning to whoever wrote it and nothing to anybody here.
      verbosity: 0
    }).promise;
  } catch (e) {
    const why = String((e && e.name) || '');
    if (why === 'PasswordException') throw new Error('this PDF is locked with a password');
    if (why === 'InvalidPDFException') throw new Error('this PDF is damaged and cannot be opened');
    throw new Error('this PDF could not be opened');
  }

  const parts = [];
  const pages = Math.min(doc.numPages, PDF_PAGES);
  let typed = 0;                 // pages that carried their own text
  let scanned = 0;               // pages that had to be read letter by letter
  let pixels = 0;
  let over = false;              // a scan too long to read the whole of

  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const lines = pageText(content.items);
    const letters = lines.join(' ').replace(/[^A-Za-z0-9]/g, '').length;

    if (letters >= ENOUGH) {
      parts.push({ text: lines.join('\n') });
      typed++;
      page.cleanup();
      continue;
    }

    // No text on this page, so it is a photograph of one. The pictures it is
    // made of are read exactly as a photograph dropped on the page would be.
    if (scanned >= SCAN_PAGES) { over = true; page.cleanup(); continue; }

    const ops = await page.getOperatorList();
    const spots = picturesOnPage(ops, OPS).slice(0, SCAN_PER_PAGE);
    let put = 0;

    for (const spot of spots) {
      if (pixels >= SCAN_PIXELS) { over = true; break; }
      const got = pictureData(page, spot.name);
      if (!got) continue;
      const png = toPng(got.width, got.height, got.kind, got.data);
      if (!png) continue;
      pixels += got.width * got.height;
      parts.push({ picture: png, name: file.originalname + ', page ' + n });
      put++;
    }

    // a page with neither text nor a picture worth reading - whatever few
    // letters it had are still better than nothing
    if (put) scanned++;
    else if (lines.join('').trim()) { parts.push({ text: lines.join('\n') }); typed++; }

    page.cleanup();
  }

  if (!parts.length) {
    throw new Error('there is nothing readable in this PDF - no text and no picture');
  }

  const how = scanned && typed ? 'part text, part read letter by letter'
            : scanned ? 'a scan, read letter by letter'
            : 'read as text';

  return {
    parts: parts,
    how: how +
      (doc.numPages > pages ? ', first ' + pages + ' of ' + doc.numPages + ' pages' : '') +
      (over ? ' (a long scan: not all of it was read)' : '')
  };
}

/* ==================== one way in ==================== */

// Back comes the file in pieces, in the order a person reads it: a piece that
// is already text, or a picture for the reader to look at. Whoever calls this
// owns the reader, so nothing here knows or cares how a picture gets read.
export async function openPaper(file, kind) {
  const what = kind || kindOf(file);

  if (what === 'picture') {
    return { parts: [{ picture: file.buffer, name: file.originalname }], how: 'read letter by letter' };
  }
  if (what === 'pdf') return await openPdf(file);
  if (what === 'docx') return openDocx(file);
  if (what === 'sheet') return openSheet(file);
  if (what === 'text') {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    if (!/\w/.test(text)) throw new Error('there is nothing in this file');
    return { parts: [{ text: text }], how: 'read as text' };
  }
  if (what === 'doc') throw new Error('an old .doc cannot be read - save it as .docx, or print it to PDF');
  throw new Error('this kind of file cannot be read');
}
