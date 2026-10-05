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
| Convert | `convert.html` | Shopify CSV → QB invoice rows, SKU matched against QB items directly (product-list CSV optional), gap check; a product not in QB can be held, which keeps every order carrying it out of the upload and in the not-uploaded report |
| Upload | `upload.html`, `jobs.js`, `jobstore.js` | Creates the invoices in QuickBooks |
| Receive payments | `payments.html`, `cpr.js` | Matches a courier CPR sheet against QB, records payment |
| Merge payments | `merge.html`, `merges.js`, `mergeqb.js` | Groups one customer's orders against a CPR and takes the extra shipping off |
| — Shipping off pasted invoices | `merge.html`, `shipfix.js` | Standalone: paste invoice numbers, see the shipping line on each, take it off. No CPR, no arithmetic |
| — Check list | `checklist.html`, `checklist.js` | The third tab of Receive payments: reads a CPR back out of QuickBooks and lists, order by order, what its payments actually paid for — orders the CPR never carried, money taken over the amount owed, an order paid twice, an order of this CPR paid under another number, and payments dated or banked wrongly. A wrong order is taken off by rewriting that payment without its line (its total comes down with it), never by deleting a payment other orders sit on; an over-received amount is set to the exact figure, which is how an advance taken as 1,000 goes back to 500. The whole CPR can be deleted and received again in one run, and a pasted list of order numbers can be checked the same way |
| Advance payments | `advance.html`, `advance.js`, `advjobs.js` | Part payments taken before delivery |
| Delivery charges | `journal.js`, `traxsheet.js` | Courier fees and taxes as journal entries |
| Find orders | `find.html`, `finder.js` | Searches every CPR sheet for pasted order numbers |
| Open invoice audit | `audit.html`, `audit.js` | Why an invoice is still open. CPR, advance and return sheets are read the way their own pages read them - the CPR month folders as Find orders does (`cpr:root`, `find:cols`, `loadSheet`), the advance workbooks and tabs as Advance payments does (`adv:root`, `adv:cols`, `loadAdvance`), the return sheet as Void invoices does (`void:root`, `readDateColumns`, a date range); what to search this time is each person's own choice, kept in the browser. Issue and blogger sheets have no page of their own, so the admin links each to a Drive folder or Google Sheet (`audit:links`: workbooks, tabs and the order/amount/note column names, matched by name on every tab and read live); the page ticks which places to search each time; linking, changing and removing a link and its columns is admin-only; which workbooks or tabs to search is everyone's own choice (in no `RIGHT_GROUPS` entry, so it cannot be handed out); the open invoices come from QuickBooks by date range, pasted with amounts, or a CSV. Each is looked up by its digits in every sheet and placed under its strongest reason (return > CPR > advance > issue > blogger); the others it is in are listed beside it, and an amount more than 10 off the sheet's is flagged. A read run (`reads.js`, name `audit`) with Stop / Carry on / Clear log; the result downloads as CSV. Writes nothing to QuickBooks |
| Courier dashboard | `courierlive.js`, `dashdata.js`, `postex.js` | Live courier data |
| Product health | `products.html`, `products.js` | One read of items + ItemSales + InventoryValuationSummary + bill item lines, then tabs over it: cost missing, stock put right by inventory adjustment, untouched items, duplicate items (twins only within the same shade - see `variantsOf`, and matched on the name with the SKU and shade stripped off it too (`baseName`), which is how "BB Cream Fair" meets "Bb Cream 7601-162/Fair"; each twin lists its bill/expense/PO/vendor-credit numbers; a merge moves those documents onto the kept item first, then the stock left, then the cost, and puts the old item away only when nothing is left on it), and the reports - selling at no cost, sold never bought, bought never sold, stock below zero |
| Purchases | `purchases.html`, `purchases.js` | The purchase orders and bills already in QuickBooks, with what went onto products and what went onto an account instead; and making another - every line carrying an item, because a line on an account brings no stock in; the supplier's paper is dropped on and attached in QuickBooks (`/upload`, one file per request), and files can be added to documents already there |
| Fix duplicates | `fix.html` | Bulk rename / delete of duplicate invoices |
| Void invoices | `voidjobs.js`, `voidsheet.js` | Voids returned orders |
| Changes (Product / Category / Description) | `replace.html`, `swap.html`, `recat.html`, `desc.html` | One rail entry, three tabs — a new kind of change is a new tab, not a new nav line. Product has two sub-tabs: every kind of transaction (`replace.html`) and invoices pasted by number (`swap.html`) |
| — Replace product | `replace.html`, `replaceitem.js` | Pasted pairs of items (old beside new, matched whole on name or SKU) swapped on every line carrying them across bills, expenses, vendor credits, purchase orders, invoices, sales receipts and credit memos in a date range; qty, rate, amount and description untouched. Invoices are read a day at a time where a month passes the 9,000 cap. Journal entries and deposits carry no item |
| — Change category | `recat.html`, `recat.js`, `recatstore.js` | Moves transactions from one P&L heading to another, nothing else touched; every move is recorded |
| — Change by description / name | `desc.html`, `redesc.js` | Reads a date range once and lists it by description, by payee or by the heading it is under; moves the lines under the ticked ones to another heading (a row under several categories can be narrowed to some of them by ticking the category itself); recorded alongside the category change |

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

**QuickBooks reports**

- Qty and cost of sales are not in any query. `ItemSales` (Sales by Product/
  Service) carries both; its column titles come back empty, so the cell order is
  name, qty, amount, % of sales, avg price, COGS, gross profit, margin.
- `PurchasesByVendorDetail` answers an app with `Permission Denied (5020)`. Read
  `Bill` and `Purchase` item lines instead - that is what `readPurchases` does.
- `InventoryAdjustment` **is** open to an app, whatever its absence from the docs
  suggests: an empty POST comes back with "add at least one inventory item",
  which is a validation error, not an unsupported one. Negative stock can be put
  right from here.
- `PurchaseOrder` and `Bill` both read and write, lines carrying
  `ItemBasedExpenseLineDetail` with `ItemRef`, `UnitPrice`, `Qty`; a PO also
  carries `Received` per line and a `LinkedTxn` to the bill made from it.
- An item's `PurchaseCost` is not its cost of sales. QBO is FIFO: cost comes from
  bills and from opening quantity, and filling `PurchaseCost` in later changes
  nothing that already sold.

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

**A run belongs to a desk, not to the company.** A desk is the company and the
person signed in, together (`desk.js`: `deskKey`, `realmOf`, `userOf`), and
`requireCompany` works it out once as `req.desk`. Every job map and every
half-finished run written to Postgres is keyed by it - `upload_jobs`,
`void_runs`, `recat_state` and `replace_state` all key on `(realm_id, user_sub)`
(`keyRunsByDesk` in `db.js` widens a table that was keyed on the company alone).
So two people signed in to the same books work side by side, the way they do in
QuickBooks itself: neither sees, stops or clears the other's run, and both can
run the same kind of job at once. When that load makes QuickBooks time one of
them out, the run's own retry takes it again a moment later. The company is
still what QuickBooks is asked about and what the books are written to - that
never goes through the desk.

**Every read of QuickBooks can be stopped, from any computer.** A read or a run
lives on the server, one per desk, and every computer that person signs in on
sees the same one. So its Stop button is drawn from the server's state on every
poll (`scan.running`, `job.running`) - never shown only by the click that started
it - and a stopped read reports `stopped` rather than an empty result. A page
added later that reads QuickBooks follows this, or it strands a read nobody can
stop.

**A search is a run too.** A read that takes a while - a span of invoices, a
pasted list of numbers, a walk of the courier or advance sheets - is not a
request to be waited out but a run on the server, because a search started by
mistake is exactly what somebody wants to stop at once. `reads.js` is the small
engine for the simple ones: hand it `plan`, `step` and `finish`, and it gives
back Stop, Carry on and Clear log, drawn from the run's own state. The longer
walks have their own modules the same shape (`voidscan.js`, `voidcheck.js`,
`advfind.js`, `finder.js`). Two reads are still single-shot and owe this:
`/api/cpr/match` with `/api/cpr/trace`, and `/api/adv/match`; and the two paste
boxes on Merge payments.

**Every run has Stop, Carry on and Clear log.** On every page and tab that runs
something on the server. Stop is drawn from the server's state; Carry on (with the
count left) shows once the run has stopped or part failed and takes only what is not
yet done, never twice what is (void, advance, receive payments, delete, swap, replace,
recat, desc, shipping off, product health, find, backfill, upload); Clear log shows only
once the run is over, wipes that run's history on the server for that person's every computer, and
leaves what was read so a new run shows only itself. A new kind of run brings all three.

**One admin; everyone else reads.** Many people sign in to one company with their
own QuickBooks address. Only an address named in `ADMIN_EMAILS` on the server is the
admin - never a column in the database - and only an admin's refresh token is written
to `companies`, so a second sign-in can neither take the company over nor stop the
app for everyone by disconnecting later. A user reads and downloads everything. Every
POST is refused to them unless it is named in `USER_MAY_POST` (the reads: scan, plan,
preview, paste, find) or it is a Stop, so a route added later is closed until it is
opened on purpose. The admin hands out whole jobs, not routes: `RIGHT_GROUPS` names
them, `/users.html` ticks them, a button carries `data-need="<job>"` and `nav.js`
hides the jobs that person was not given. Courier accounts and their keys are never
in `RIGHT_GROUPS` - they stay with the admin.

**Long runs survive a deploy.** Upload (`jobstore.js`), the category change
(`recatstore.js`) and product replacement (`replacestore.js`) are written to
Postgres as they go and carried on after a restart. The others - description
change, product health cost/stock/merge runs, swap by pasted invoices - still live
in memory only, and a deploy stops them.

**A read of a year of invoices outlives an access token.** Tokens last an hour
and such a read takes longer. `tokenKeeper` in `replaceitem.js` fetches a fresh
one before it runs out and again on a 401; `askPatiently` asks again after a pause
on 429, 5xx, timeouts and dropped connections. A read that still fails keeps what
it found and how far each kind got, and carries on from there on request. Once a
kind has shown it needs day windows, later months go straight to days, read four
at a time.

**Replacing a product on an invoice is slow in QuickBooks itself.** The write makes
QuickBooks work the stock cost of the product out again for everything dated
after it - tens of seconds an invoice on a busy product. Runs go newest first so
each change has the least left to redo, and each log line shows the write time.
Moving the few bills onto the item the invoices use gives the same cost of sales
as moving hundreds of invoices onto the item the bills use, in minutes.

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
- Move off Render's free tier eventually (a small VPS at $5–7/month was the
  preferred option over Render paid at $25).
- Intuit App Store submission, once multi-company is solid.
