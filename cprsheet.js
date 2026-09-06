// A receipt as a workbook, shaped like the one the portal hands out: the
// totals on one sheet, every order on another. Anyone who wants to open it in
// Excel and work on it can, and nothing about the app is needed to read it.

import XLSX from 'xlsx';

const money = v => Math.round(Number(v || 0) * 100) / 100;

// A width per column, worked out from what is in it. Without this every
// column is the same narrow default and the file looks like a dump.
function widths(rows, headers) {
  return headers.map((h, i) => {
    let w = String(h).length;
    rows.forEach(r => {
      const v = r[i];
      const len = v === null || v === undefined ? 0 : String(v).length;
      if (len > w) w = len;
    });
    return { wch: Math.min(Math.max(w + 2, 9), 42) };
  });
}

function sheet(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = widths(rows, headers);
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

export function buildWorkbook(cpr, detail) {
  const wb = XLSX.utils.book_new();
  const s = detail.summary || {};

  /* ---------- the cover, as the portal shows it ---------- */

  const cover = [
    ['Cash payment receipt', cpr.cpr],
    ['Account', detail.account || ''],
    ['Status', cpr.status || ''],
    ['Created', cpr.createdOn || ''],
    ['Approved', cpr.approvedOn || ''],
    [],
    ['', 'Orders', 'Amount', 'Invoice amount']
  ];

  (s.lines || []).forEach(l => {
    cover.push([l.label, l.orders, money(l.amount), money(l.invoice)]);
  });

  cover.push([]);
  cover.push(['Grand total', '', money(s.grandTotal)]);
  cover.push([`COD charges (${s.codChargesCount || 0})`, '', money(s.codCharges)]);
  if (s.upfrontChargesCount) {
    cover.push([`Upfront charges (${s.upfrontChargesCount})`, '', money(s.upfrontCharges)]);
  }
  cover.push(['Sales tax', '', money(s.salesTax)]);
  cover.push(['Income tax', '', money(s.incomeTax)]);
  cover.push(['Tax', '', money(s.tax)]);
  if (s.miscellaneousCharges) cover.push(['Miscellaneous charges', '', money(s.miscellaneousCharges)]);
  if (s.carryForwardAmount)   cover.push(['Carried forward', '', money(s.carryForwardAmount)]);
  if (s.adjustmentAmount)     cover.push(['Adjustments', '', money(s.adjustmentAmount)]);
  cover.push([]);
  cover.push(['Net amount', '', money(s.netAmount)]);

  const ws1 = XLSX.utils.aoa_to_sheet(cover);
  ws1['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  /* ---------- every order ---------- */

  const headers = [
    'Order ref', 'Tracking', 'Customer', 'Phone', 'City', 'Status', 'Type',
    'Amount', 'Received', 'Fee', 'Tax', 'Net',
    'Booked', 'Picked', 'Delivered', 'Settled', 'Notes'
  ];

  const rows = (detail.orders || []).map(o => ([
    o.orderRef, o.tracking, o.customer, o.phone, o.city, o.status, o.type,
    money(o.amount), money(o.received), money(o.fee), money(o.tax), money(o.net),
    o.bookedOn, o.pickedOn, o.deliveredOn, o.settledOn, o.notes
  ]));

  XLSX.utils.book_append_sheet(wb, sheet(headers, rows), 'Orders');

  /* ---------- what each status is worth ---------- */

  const byStatus = (detail.counts || []).map(c =>
    ([c.status, c.orders, money(c.amount), money(c.fee), money(c.tax)]));

  XLSX.utils.book_append_sheet(
    wb,
    sheet(['Status', 'Orders', 'Amount', 'Fee', 'Tax'], byStatus),
    'By status'
  );

  /* ---------- adjustments, when there are any ---------- */

  if ((detail.adjustments || []).length) {
    const keys = Object.keys(detail.adjustments[0]);
    XLSX.utils.book_append_sheet(
      wb,
      sheet(keys, detail.adjustments.map(a => keys.map(k => a[k]))),
      'Adjustments'
    );
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// what the browser should call the file
export function fileName(cpr) {
  const safe = String(cpr.cpr || 'CPR').replace(/[^A-Za-z0-9_.-]/g, '');
  return `${safe}${cpr.createdOn ? ' ' + cpr.createdOn : ''}.xlsx`;
}
