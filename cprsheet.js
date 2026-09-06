// A receipt as a workbook - one sheet, the same sixteen columns the courier's
// own download has, in the same order and under the same names. Anything
// extra would mean the two files could not simply be laid side by side, which
// is the only reason this file exists.

import XLSX from 'xlsx';

const money = v => Math.round(Number(v || 0) * 100) / 100;

export const COLUMNS = [
  'ORDER_REF_NUMBER', 'TRACKING_NUMBER', 'WEIGHT (Kg)', 'ORDER_PICKUP_DATE',
  'ORIGIN_CITY', 'DELIVERY_CITY', 'STATUS', 'COD_AMOUNT', 'UPFRONT_AMOUNT',
  'RESERVE_AMOUNT', 'D/R Date', 'SHIPPING_CHARGES', 'UPFRONT_CHARGES',
  'GST', 'DEDUCTION (4%)', 'NET_AMOUNT'
];

export function rowOf(o) {
  return [
    o.orderRef, o.tracking, money(o.weight), o.pickedOn,
    o.originCity, o.city, o.status, money(o.amount), money(o.upfront),
    money(o.reserve), o.deliveredOn, money(o.fee), money(o.upfrontCharges || 0),
    money(o.tax), money(o.deduction), money(o.net)
  ];
}

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

export function buildWorkbook(cpr, detail) {
  const rows = (detail.orders || []).map(rowOf);

  const ws = XLSX.utils.aoa_to_sheet([COLUMNS, ...rows]);
  ws['!cols'] = widths(rows, COLUMNS);
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// what the browser should call the file
export function fileName(cpr) {
  const safe = String(cpr.cpr || 'CPR').replace(/[^A-Za-z0-9_.-]/g, '');
  return `${safe}${cpr.createdOn ? ' ' + cpr.createdOn : ''}.xlsx`;
}
