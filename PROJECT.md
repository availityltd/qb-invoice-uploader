# Shopify → QuickBooks: project brief

Read this first. It describes what the app does today, the constraints that
have already cost us time, and where it is going.

---

## What it is

A multi-tenant web app that runs the whole order-to-payment pipeline for
Pakistani Shopify sellers who ship cash-on-delivery through local couriers:

Shopify export → QuickBooks invoices → courier dispatch → CPR payment
reconciliation → delivery charges journalled.

Users are accounting staff, not developers. Nothing should require them to
understand what is happening underneath.

---

## Stack

- Node.js / Express, ES modules
- Neon Postgres
- Plain HTML + vanilla JS front end (no build step, no framework)
- Hosted on Render, auto-deploy from GitHub (`availityltd/qb-invoice-uploader`)
- QuickBooks Online API, Google Drive + Sheets API (service account),
  PostEx courier API
- A cron-job.org ping every 5 minutes keeps Render's free tier awake

---

## The pages

| Page | File | What it does |
|---|---|---|
| Convert | `convert.html` | Shopify CSV → QB invoice rows, SKU matching, gap check |
| Upload | `upload.html`, `jobs.js`, `jobstore.js` | Creates the invoices in QuickBooks |
| Receive payments | `payments.html`, `cpr.js` | Matches a courier CPR sheet against QB, records payment |
| Advance payments | `advance.html`, `advance.js`, `advjobs.js` | Part payments taken before delivery |
| Delivery charges | `journal.js`, `traxsheet.js` | Courier fees and taxes as journal entries |
| Find orders | `find.html`, `finder.js` | Searches every CPR sheet for pasted order numbers |
| Courier dashboard | `courierlive.js`, `dashdata.js`, `postex.js` | Live courier data |
| Fix duplicates | `fix.html` | Bulk rename / delete of duplicate invoices |
| Void invoices | `voidjobs.js`, `voidsheet.js` | Voids returned orders |

---

## Hard-won constraints — do not relearn these

**QuickBooks**

- The batch API times out under load. Inventory locks mean ten invoices in one
  request can exceed the gateway's 30-second limit, and the whole batch fails
  with `stream timeout`. **Send one invoice per request.** It is slower and it
  does not stop. This was tried the other way and reverted.
- `STARTPOSITION` caps around 9,000 rows. Large date ranges need windowed
  queries that bisect when they hit the cap.
- `#91306999` and `91306999` are two different invoices. Keep the `#`.
- A payment can cover many invoices. Changing its bank changes it for all of
  them — never "fix" one row by editing a shared payment.
- QB will not accept the same DocNumber twice. A parcel settled under two CPRs
  needs a `-D` copy.
- Nested field filters like `Line.LinkedTxn.TxnId IN (...)` do not work. Read
  the invoice's own `LinkedTxn` and query payments by `Id` instead.

**Google Sheets**

- 60 write requests per minute per user. Writing rows one at a time fails after
  the first sixty. Use `values.batchUpdate` — see `stampRows` in `sheets.js`.
- The Sheets API cannot write into an `.xlsx` on Drive. Those need
  download → edit → re-upload, which loses charts, conditional formatting and
  column widths. Prefer real Google Sheets.
- Formatting a few thousand rows means joining adjacent same-colour rows into
  bands, not one request per row.

**Render free tier**

- Spins down after 15 minutes with no request. The cron ping handles this.
- Deploys restart the process. Long jobs must survive that — see below.

**Data**

- SKUs like `7102-001/7` are read as dates by XLSX parsers. Force
  `raw:true, cellDates:false`.
- Shopify line-item rows carry the order number only on the first row of a
  multi-line order. Fill down.
- Courier sheets merge parcels: one cell can hold
  `91302583 , 91302588` with the COD being both added together.
- An advance leaves a balance on the invoice, so balance alone cannot tell you
  whether it was already taken. The sheet is stamped `Posted by Rani` instead,
  and a stamped row is skipped.

---

## Patterns already established — follow them

**Long work runs as a server-side job.** Upload, receive payments, void and
delete all work this way: the browser starts it, then polls every 2 seconds.
Closing the page changes nothing. `jobs.js` is the reference implementation and
`jobstore.js` writes its position to Postgres after every batch, so a deploy
mid-run picks up where it stopped (`resumeUnfinished`).

**Ask once, then remember.** Column choices per courier, bank name → QB account
mappings, SKU mappings — all saved in `settings.js` and never asked again unless
something new appears.

**Show the evidence, then offer the fix.** The recheck panel reads QuickBooks
back and shows what is actually there, with a button to correct it. Never
silently "repair" anything.

**One meaning per colour.** In sheets: green received, yellow amount differs,
orange paid under another CPR, red not in QuickBooks.

---

## Working style

- Complete files, not diffs, unless the change is a couple of lines
- One change at a time, confirmed before the next
- Syntax check before handing anything over — a failed deploy costs more than
  the check
- When diagnosing, ask for the actual response or log line. Do not guess.
- Comments explain why, not what

---

## Where this is going

The goal is a SaaS product several companies can use at once. In order:

**1. Multi-company foundation**
Everything else rests on this. Today one signed-in user maps to one QB realm.
Needs: proper company switching, per-company settings isolation, and a check
that nothing leaks across tenants. Do this before anything else is built on top.

**2. All couriers in one place**
PostEx has a live API adapter. Trax and Daewoo/MSA are still sheet-only.
One `courier_orders` table already exists — bring the other two into it so
bookings, delivered, returned and in-transit read the same for all three.

**3. Load sheets and airway bills**
Printable, per courier account, generated from the data in step 2. The offline
"Dispatch — Courier Router" tool already does city-based routing, service-area
matching and booking-sheet export; that logic should move in rather than be
rewritten.

**4. Shopify orders**
Pull orders directly instead of CSV exports. Needs a Shopify app, tokens per
store, and duplicate protection. Biggest piece — leave it last.

**Also outstanding**

- PostEx `payment-status` returns empty `cprNumber_1` / `cprNumber_2` fields
  although the portal shows them. Either their support provides an endpoint or
  we import downloaded CPR CSVs.
- Roughly 1,700 PostEx orders land in the `other` / `unknown` status bucket;
  `GROUPS` in `postex.js` needs to cover them.
- Convert still asks for a QB product-list CSV every run. QB already returns
  `Sku` on `/api/qb-products` — use it and drop the upload.
- Move off Render's free tier eventually (a small VPS at $5–7/month was the
  preferred option over Render paid at $25).
- Intuit App Store submission, once multi-company is solid.
