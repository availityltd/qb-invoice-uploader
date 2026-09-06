// A receipt as a workbook - one sheet, the courier's own columns in its own
// order, so the two files can be laid side by side. The single exception is
// the 4% deduction, which is split into the two 2% withholdings it is made of
// because they post to two different accounts in QuickBooks. Add the pair and
// you have the courier's figure back.

import XLSX from 'xlsx';

const money = v => Math.round(Number(v || 0) * 100) / 100;

export const COLUMNS = [
  'ORDER_REF_NUMBER', 'TRACKING_NUMBER', 'WEIGHT (Kg)', 'ORDER_PICKUP_DATE',
  'ORIGIN_CITY', 'DELIVERY_CITY', 'STATUS', 'COD_AMOUNT', 'UPFRONT_AMOUNT',
  'RESERVE_AMOUNT', 'D/R Date', 'SHIPPING_CHARGES', 'UPFRONT_CHARGES',
  'GST', 'WH Income Tax', 'WH Sale Tax', 'NET_AMOUNT'
];

export function rowOf(o) {
  return [
    o.orderRef, o.tracking, money(o.weight), o.pickedAt || o.pickedOn,
    o.originCity, o.city, o.status, money(o.amount), money(o.upfront),
    money(o.reserve), o.deliveredAt || o.deliveredOn, money(o.fee), money(o.upfrontCharges || 0),
    money(o.tax), money(o.whIncomeTax), money(o.whSalesTax), money(o.net)
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
