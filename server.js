import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import XLSX from 'xlsx';
import crypto from 'crypto';
import {
  pool, initDb, saveCompany, getCompany, renameCompany, logUpload,
  getNegativeItems, setNegativeItems
} from './db.js';

import { initMappings, getMappings, saveMapping } from './mappings.js';
import { listCompanies } from './companies.js';
import { listSheets, listTabs, readTab, paintRows, testConnection } from './sheets.js';
import {
  initUsers, upsertUser, getUser, linkCompany, userOwns,
  listUsers, setUserAccess, setUserCompanies, realmsForUser, usersByEmails,
  askAgain, stopAsking, resumeAsking
} from './users.js';
import {
  initNotify, notify, listFor, unreadCount, markAllRead, clearFor, sendMail
} from './notify.js';
import { initPush, publicKey, addSub, dropSub, hasSub, pushTo } from './push.js';
import {
  getAccessToken, getCompanyInfo, loadItems, loadTerms,
  getOrCreateCustomer, postInvoice, qbQuery, qbReport
} from './qb.js';
import {
  readItems, readItemSales, readValuation, readPurchases,
  buildRows as buildProductRows, summarise as summariseProducts,
  updateItem as updateProductItem,
  listAdjustAccounts, adjustStock, looseName as productKey
} from './products.js';
import {
  initProdStore, logProductChange, listProductChanges, clearProductChanges
} from './prodstore.js';
import {
  KINDS as REPLACE_KINDS, parsePairs as parseReplacePairs, resolvePairs as resolveReplacePairs,
  scanReplace, replaceOne as replaceItemOn, itemById as replaceItemById,
  shopifyVariants, pairsFromShopify, tokenKeeper, newScanState
} from './replaceitem.js';
import {
  initReplaceStore, saveReplace, clearReplace, unfinishedReplace
} from './replacestore.js';
import { sameVariant, twinKeys } from './products.js';
import {
  listVendors, listPayables, readDocs, readOne, createDoc,
  attachFile, listAttachments
} from './purchases.js';
import { readPictures, parseSheet, matchToItems } from './paperread.js';
import { initSettings, getSetting, setSetting, recordRun, listRuns, runsSummary,
         initCache, getCache, setCache } from './settings.js';
import {
  listFolders, listSheetsIn, loadSheet, groupByCpr, isDelivered,
  findInvoices, listAccounts, listPaymentMethods, postPayment, digitsOf as cprDigits,
        paymentsByCpr, paymentsByIds, copyInvoice,
        matchCpr, colourPlan, colourCpr, statusColumnOf,
        strayPayments, paymentsWithRef, deletePayment
} from './cpr.js';
import { inspectExcel, writeStatusSheet, writeStatusExcel, fileInfo, peekImages,
         readCell, writeCell, stampRows } from './sheets.js';
import { clean as cprClean } from './cpr.js';
import {
  startJob, stopJob, pauseJob, resumeJob, clearJob, endJob,
    retryFailed, snapshot, remainingInvoices, resumeUnfinished
} from './jobs.js';
import { startVoidJob, stopVoidJob, clearVoidJob, endVoidJob, resumeVoidJob, voidSnapshot, initVoidStore, resumeVoidRuns } from './voidjobs.js';
import {
  startCheckJob as startSheetCheck, stopCheckJob as stopSheetCheck,
  clearCheckJob as clearSheetCheck, endCheckJob as endSheetCheck,
  resumeCheckJob as resumeSheetCheck,
  checkSnapshot as sheetCheckSnapshot
} from './voidcheck.js';
import { readDateColumns } from './voidsheet.js';
import { startDelJob, stopDelJob, clearDelJob, endDelJob, resumeDelJob, delSnapshot } from './deljobs.js';
import { loadAdvance, findForAdvance, spanLabel } from './advance.js';
import { startAdvJob, stopAdvJob, clearAdvJob, endAdvJob, resumeAdvJob, advSnapshot } from './advjobs.js';
import {
  initCouriers, listAccounts as listCourierAccounts, getAccount as getCourierAccount,
  addAccount as addCourierAccount, removeAccount as removeCourierAccount,
  markSync, saveOrders,
  listCprs, cprOrders, cprProgress
} from './couriers.js';
import { adapter as postexAdapter } from './postex.js';
import {
  liveStats, liveOrders, trackOne, peekRaw, chaseCpr, forget as forgetLive
} from './courierlive.js';
import {
  loadCharges, listAllAccounts, findJournal, postJournal
} from './journal.js';
import { loadTraxSummaries, applyLines } from './traxsheet.js';
import { startPayJob, stopPayJob, clearPayJob, endPayJob, resumePayJob, paySnapshot } from './payjobs.js';
import {
  startCheck, stopCheck, resumeCheck, clearCheck, endCheck, checkSnapshot,
  startFix, stopFix, resumeFix, clearFix, endFix, fixSnapshot
} from './checklist.js';
import {
  startFindJob, resumeFindJob, stopFindJob, clearFindJob, endFindJob, findSnapshot,
  listTree, sheetsIn, peekHeader
} from './finder.js';
import {
  startBackfill, resumeBackfill, stopBackfill, clearBackfill, endBackfill, backfillSnapshot
} from './backfill.js';
import {
  openFile as openMergeFile, buildOrders, groupOrders, parsePasted, placeGroups
} from './merges.js';
import {
  invoicesWithLines, planGroup, remarkFor, stripShipping, planStrip, round as money2
} from './mergeqb.js';
import {
  parseNumbers as parseShipNumbers, buildPlan as buildShipPlan
} from './shipfix.js';
import {
  parseNumbers as parseSwapNumbers, buildPlan as buildSwapPlan, swapOnInvoice
} from './swapitem.js';
import {
  KINDS as RECAT_KINDS, listAccounts as listRecatAccounts,
  scanAccount as scanRecatAccount, recatOne
} from './recat.js';
import {
  initRecatStore, saveRecatState, saveRecatProgress, loadRecatState,
  clearRecatState, unfinishedRecat, logMove as logRecatMove, listMoves as listRecatMoves,
  clearMoves as clearRecatMoves
} from './recatstore.js';
import {
  scanDescriptions, groupRows as groupDescRows, linesFor, wantOf as descWantOf, descKey, redescOne,
  WAYS as DESC_WAYS, wayOf as descWayOf
} from './redesc.js';
import { startKeeper, keeperState, sweepNow } from './keeper.js';
import {
  dashboard as dashData, recentCprs, pickups, pickupOrders, ordersBy, eachOrder
} from './dashdata.js';
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
// a whole month of Shopify orders, several files at once, runs bigger than that
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 15 }
});

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
// Which build is running. Render hands over the commit being deployed; anywhere
// else, the moment the process started stands in for it. Every open page asks
// for this now and then, and a different answer means a deploy has landed.
const BUILD = process.env.RENDER_GIT_COMMIT || ('boot-' + Date.now());
const BUILD_AT = new Date().toISOString();

app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: BUILD, at: BUILD_AT });
});

// Which page this person should be looking at - decided here, before a line of
// HTML is sent.
//
// It used to be decided in the browser: every page drew itself, asked the server
// who was looking, and then took itself away again. That is what the flash was -
// the rail, the dashboard, the gate, each one appearing for a moment on its way
// out. A page the browser never receives cannot flash. So a request for a page
// of the app from somebody who is not all the way in is answered with a redirect
// to the one screen that is theirs, and nothing else is ever sent.
//
// Three screens, in order: the door, the waiting-or-choosing screen, the app.
app.get(/(^\/$)|\.html$/, async (req, res, next) => {
  const here = req.path === '/' ? '/index.html' : req.path;

  try {
    const sub = currentUser(req);

    if (!sub) {
      return here === '/signin.html' ? next() : res.redirect('/signin.html');
    }
    if (here === '/signin.html') return res.redirect('/');

    const who = await whoIs(sub);
    const letIn = !!(who && (who.admin || (who.allowed && who.role !== 'none')));

    const realmId = req.cookies.realm_id;
    const settled = letIn && realmId && await isSettled(sub, realmId);

    if (!settled) {
      return here === '/choose.html' ? next() : res.redirect('/choose.html');
    }
    if (here === '/choose.html') return res.redirect('/');

    // A page that belongs to an area this person was not given is not theirs to
    // open. Only a limited user is held to this - everybody else was given the
    // whole of the books, or the whole of them to read.
    if (who && who.role === 'custom' && !who.admin) {
      const need = PAGE_NEED.get(here);
      if (need && who.rights.indexOf(need) < 0) return res.redirect('/');
    }

    return next();
  } catch (e) {
    console.error('page guard:', e.message);
    return next();
  }
});

// The company's list of people belongs to the admin. Anyone else who reaches for
// it - by typing the address, or from a link they kept - is sent back to the
// dashboard, so the page is never served rather than merely hidden in the rail.
app.get(['/users.html', '/users'], async (req, res, next) => {
  try {
    const who = await whoIs(currentUser(req));
    if (who && who.admin) return next();
  } catch (e) { /* fall through to the dashboard */ }
  res.redirect('/');
});

// Pages, scripts and styles are asked for again on every load rather than served
// from a copy the browser or the installed app kept - so what was deployed is what
// every computer runs, the moment it reloads.
app.use(express.static('public', {
  setHeaders(res, file) {
    if (/\.(html|js|css|json)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const API = 'https://quickbooks.api.intuit.com';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const USERINFO_URL = 'https://accounts.platform.intuit.com/v1/openid_connect/userinfo';

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.QB_CLIENT_SECRET || 'dev-secret';

// ==================== session helpers ====================
function sign(sub) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(sub).digest('hex');
  return sub + '.' + mac;
}
function verify(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const sub = token.slice(0, i), mac = token.slice(i + 1);
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(sub).digest('hex');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  return sub;
}
function currentUser(req) {
  return verify(req.cookies.uid);
}

// ==================== who is an admin ====================
// One company, many QuickBooks sign-ins. Only the addresses named here run the app
// as its admin; everyone else signs in and works as a user. The list lives in the
// server's settings, never in the database, so reaching the database is not a way
// to become an admin.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || 'sohailsaim6@gmail.com')
    .split(/[,; ]+/)
    .map(x => x.trim().toLowerCase().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
);

// The roles, said the way QuickBooks says them on its own Manage users page, so
// nobody has to learn a second vocabulary. QuickBooks does not hand a person's role
// out through its API - there is no User to ask for - so the app keeps its own, and
// the admin sets them here.
const ROLES = [
  { key: 'admin',    label: 'Company admin',
    what: 'Everything, plus people and couriers' },
  { key: 'standard', label: 'Standard user (all access)',
    what: 'Every area of the books' },
  { key: 'custom',   label: 'Standard user (limited)',
    what: 'Only the areas ticked below' },
  { key: 'viewer',   label: 'Reports only',
    what: 'Reads everything, changes nothing' },
  { key: 'none',     label: 'No access',
    what: 'Signed in, and no further' }
];

// The three areas of the books these jobs fall into, said the way an accountant
// would and the way QuickBooks itself divides a limited user: what goes out to a
// customer, what comes in from a supplier, and what sits on the shelf.
const AREAS = [
  { key: 'sales',     label: 'Customers and sales',
    what: 'What is invoiced, collected and credited back' },
  { key: 'purchases', label: 'Vendors and purchases',
    what: 'What is ordered, billed and paid out' },
  { key: 'items',     label: 'Products and stock',
    what: 'What items cost, what is on hand, how they are named' }
];
const ROLE_KEYS = new Set(ROLES.map(r => r.key));

const whoCache = new Map();          // sub -> what they are, for half a minute
const WHO_LIFE = 30 * 1000;

async function whoIs(sub) {
  if (!sub) return null;
  const kept = whoCache.get(sub);
  if (kept && Date.now() - kept.at < WHO_LIFE) return kept;

  const u = await getUser(sub);
  const who = {
    email: (u && u.email) ? String(u.email).toLowerCase() : '',
    name: u ? (u.name || u.email) : null,
    allowed: u ? u.allowed !== false : true,
    rights: (u && Array.isArray(u.rights)) ? u.rights : [],
    role: (u && u.role) ? u.role : 'viewer',
    at: Date.now()
  };
  who.admin = !!who.email && ADMIN_EMAILS.has(who.email);
  if (who.admin) who.role = 'admin';
  whoCache.set(sub, who);
  return who;
}

// may this person do this job, whatever their role says
function mayDo(who, job) {
  if (!who || !job) return false;
  if (who.admin || who.role === 'admin') return true;
  if (who.role === 'standard') return true;
  if (who.role === 'custom') return who.rights.indexOf(job) > -1;
  return false;                        // reports only, or no access
}

function forgetWho(sub) { whoCache.delete(sub); }

// The admin, and nobody else. What only the admin may touch - the courier accounts
// and their keys above all - asks for this instead of requireCompany.
async function requireAdmin(req, res) {
  const realmId = await requireCompany(req, res);
  if (!realmId) return null;
  const who = await whoIs(currentUser(req));
  if (!who || !who.admin) {
    res.status(403).json({ error: 'Only the admin can do this. You are signed in as a user.' });
    return null;
  }
  return realmId;
}

async function requireCompany(req, res) {
  const sub = currentUser(req);
  if (!sub) { res.status(401).json({ error: 'Not signed in' }); return null; }
  const realmId = req.cookies.realm_id;
  if (!realmId) { res.status(401).json({ error: 'No company selected' }); return null; }
  if (!(await userOwns(sub, realmId))) {
    res.status(403).json({ error: 'This company is not linked to your account' });
    return null;
  }
  // someone the admin has turned off is signed in, and no further
  const who = await whoIs(sub);
  if (who && !who.admin && (!who.allowed || who.role === 'none')) {
    res.status(403).json({ error: 'The admin has turned your access to this app off.' });
    return null;
  }
  // Whose desk this is. The company is what QuickBooks is asked about and what
  // the books are written to; the desk is what a run belongs to, so two people
  // in the same company work side by side without seeing one another's runs -
  // the same way they would in QuickBooks itself.
  req.desk = deskKey(realmId, sub);
  return realmId;
}

// ==================== the people who use it ====================
// Everyone who has ever signed in, what they are, and what the admin has let them
// change. Only the admin sees this and only the admin changes it.
// the jobs that can be handed out, for the admin's page to draw
app.get('/api/admin/rights', async (req, res) => {
  const realmId = await requireAdmin(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    roles: ROLES,
    areas: AREAS,
    groups: RIGHT_GROUPS.map(g => ({
      key: g.key, area: g.area || 'sales', label: g.label, what: g.what
    }))
  });
});

app.get('/api/admin/users', async (req, res) => {
  const realmId = await requireAdmin(req, res);
  if (!realmId) return;
  try {
    const rows = await listUsers();
    const byUser = new Map();
    for (const u of rows) byUser.set(u.sub, await realmsForUser(u.sub));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      admins: [...ADMIN_EMAILS],
      users: rows.map(u => ({
        sub: u.sub,
        email: u.email || '',
        name: u.name || '',
        admin: !!u.email && ADMIN_EMAILS.has(String(u.email).toLowerCase()),
        allowed: u.allowed !== false,
        role: (!!u.email && ADMIN_EMAILS.has(String(u.email).toLowerCase()))
          ? 'admin' : (u.role || 'viewer'),
        rights: Array.isArray(u.rights) ? u.rights : [],
        realms: byUser.get(u.sub) || [],
        decided: !!u.decided_at,
        asking: u.asked !== false,
        lastIn: u.last_in,
        since: u.created_at
      })),
      // the shelf to tick from, so the page need not ask twice
      companies: await listCompanies()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users/access', async (req, res) => {
  const realmId = await requireAdmin(req, res);
  if (!realmId) return;

  const { sub, allowed, rights, role } = req.body || {};
  if (!sub) return res.status(400).json({ error: 'Which person?' });
  if (role !== undefined && !ROLE_KEYS.has(String(role))) {
    return res.status(400).json({ error: 'There is no such role' });
  }
  if (role === 'admin') {
    return res.status(400).json({ error: 'An admin is named by ADMIN_EMAILS on the server, not here.' });
  }

  try {
    const u = await getUser(sub);
    if (u && u.email && ADMIN_EMAILS.has(String(u.email).toLowerCase())) {
      return res.status(400).json({ error: 'That address is an admin - change ADMIN_EMAILS on the server instead.' });
    }
    const before = u || {};
    await setUserAccess(sub, { allowed, rights, role });
    forgetWho(sub);

    // Told that something changed, never what the role is. Which role a person
    // holds, and what it carries, is the admin's to know; the person finds out by
    // what opens in front of them, which is the same thing said more usefully.
    const wasOn = before.allowed !== false && String(before.role || '') !== 'none';
    const nowOn = (allowed === undefined ? before.allowed !== false : !!allowed) &&
                  String(role === undefined ? before.role : role) !== 'none';

    const wasDecided = !!before.decided_at;

    if (!wasDecided && !nowOn) {
      await tell(sub, {
        kind: 'access',
        title: 'Your access has been turned down',
        body: 'The admin has not given you access to this app. Speak to them if ' +
              'you think that is a mistake.',
        link: '/'
      });
    } else if (!wasOn && nowOn) {
      await tell(sub, {
        kind: 'access',
        title: 'You have been let in',
        body: 'The admin has given you access to the app.',
        link: '/'
      });
    } else if (wasOn && !nowOn) {
      await tell(sub, {
        kind: 'access',
        title: 'Your access to the app has been turned off',
        body: 'Nothing opens until the admin turns it back on.',
        link: '/'
      });
    } else if (nowOn && role !== undefined && String(role) !== String(before.role || '')) {
      await tell(sub, {
        kind: 'access',
        title: 'What you may do in the app has changed',
        body: 'The admin has changed your access.',
        link: '/'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Which companies a person may work in. Said here because QuickBooks will not say
// it, and said by the admin because connecting a company was the admin's doing.
app.post('/api/admin/users/companies', async (req, res) => {
  const realmId = await requireAdmin(req, res);
  if (!realmId) return;

  const { sub, realms } = req.body || {};
  if (!sub) return res.status(400).json({ error: 'Which person?' });
  if (!Array.isArray(realms)) return res.status(400).json({ error: 'Which companies?' });

  try {
    const u = await getUser(sub);
    if (u && u.email && ADMIN_EMAILS.has(String(u.email).toLowerCase())) {
      return res.status(400).json({ error: 'An admin has every company the app is connected to.' });
    }
    // only companies the app actually holds, whatever was sent
    const all = await listCompanies();
    const connected = new Set(all.map(c => c.realmId));
    const want = realms.map(String).filter(r => connected.has(r));

    const had = new Set(await realmsForUser(sub));
    await setUserCompanies(sub, want);
    forgetSettled(sub);

    const added = all.filter(c => want.indexOf(c.realmId) > -1 && !had.has(c.realmId));
    const gone  = all.filter(c => want.indexOf(c.realmId) < 0 && had.has(c.realmId));

    if (added.length) {
      await tell(sub, {
        kind: 'company',
        title: added.length === 1
          ? 'You can now work in ' + added[0].name
          : 'You can now work in ' + added.length + ' more companies',
        body: added.map(c => c.name).join(', ') +
              ' - choose it from the name at the foot of the rail.',
        link: '/choose.html'
      });
      const person = u || await getUser(sub);
      if (person && person.email) {
        sendMail(person.email,
          'You have been given ' + added.map(c => c.name).join(', ') +
          ' - Shopify to QuickBooks',
          ['The admin has given you ' + added.map(c => c.name).join(', ') + ' in the app.',
           'Sign in and choose the company from the name at the foot of the rail.',
           BASE_URL + '/']
        ).catch(() => {});
      }
    }
    if (gone.length) {
      await tell(sub, {
        kind: 'company',
        title: gone.length === 1
          ? 'You no longer work in ' + gone[0].name
          : gone.length + ' companies have been taken back',
        body: gone.map(c => c.name).join(', ') + ' is no longer yours to open.',
        link: '/choose.html'
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== the bell ====================
// Everybody's own, and nobody else's: the person is taken from the session, never
// from what the page sent, so there is no address to ask for somebody else's.
app.get('/api/notifications', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.json({ items: [], unread: 0 });
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: await listFor(sub), unread: await unreadCount(sub) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The count alone. Opening a page asked for fifty rows to find one number, and a
// window left open asked again every twenty seconds - which by itself kept the
// database awake all day. One number, rarely, and the phone carries the rest.
app.get('/api/notifications/count', async (req, res) => {
  const sub = currentUser(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!sub) return res.json({ unread: 0 });
  try {
    res.json({ unread: await unreadCount(sub) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });
  try {
    await markAllRead(sub);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications/clear', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });
  try {
    await clearFor(sub);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Turned away, and asking again. Nothing here lets anybody in: it puts the
// address back on the admin's list as one nobody has answered, and tells them.
app.post('/api/access/request', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });

  try {
    const who = await whoIs(sub);
    if (who && (who.admin || (who.allowed && who.role !== 'none'))) {
      return res.json({ ok: true, already: true });
    }

    const moved = await askAgain(sub);
    forgetWho(sub);
    if (!moved) return res.json({ ok: true });

    const u = await getUser(sub);
    const label = (u && (u.name || u.email)) || 'Somebody';
    await tellAdmins({
      kind: 'signin',
      title: label + ' is asking again',
      body: (u && u.email ? u.email : 'no address') + ' was turned down and has ' +
            'asked to be let in. Choose their companies and what they may do, or ' +
            'turn them down again.',
      link: '/users.html?who=' + encodeURIComponent(sub),
      subject: label + ' is asking again - Shopify to QuickBooks',
      lines: [
        label + ' (' + (u && u.email ? u.email : 'no address') + ') was turned ' +
        'down and has asked again.',
        'Open the link below on any phone: it lands on them, with the companies ' +
        'to tick and what they may do.',
        BASE_URL + '/users.html?who=' + encodeURIComponent(sub)
      ]
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Withdrawing, which is not the same as being turned down. The admin has not
// answered and is no longer being asked to.
app.post('/api/access/cancel', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });

  try {
    const moved = await stopAsking(sub);
    forgetWho(sub);
    if (moved) {
      const u = await getUser(sub);
      const label = (u && (u.name || u.email)) || 'Somebody';
      await tellAdmins({
        kind: 'signin',
        title: label + ' has withdrawn',
        body: 'They are no longer asking to be let in. Nothing to do.',
        link: '/users.html?who=' + encodeURIComponent(sub),
        subject: label + ' has withdrawn - Shopify to QuickBooks',
        lines: [label + ' is no longer asking to be let in to the app.',
                'Nothing to do. They can ask again at any time.']
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== this phone ====================
// The public half of the app's own keypair. There is nothing secret in it - the
// phone needs it to check that a notice really came from here.
app.get('/api/push/key', async (req, res) => {
  const sub = currentUser(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    key: publicKey(),
    on: sub ? await hasSub(sub) : false
  });
});

app.post('/api/push/subscribe', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });
  try {
    await addSub(sub, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });
  try {
    await dropSub((req.body || {}).endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== what a user may not do ====================
// A user reads everything and downloads everything; nothing they press changes
// QuickBooks, the sheets, or the courier accounts. Reading is asked for with GET,
// but a good deal of the reading here is asked for with POST as well - a pasted
// list of numbers, a date range, a scan. Those are named below. Everything else
// sent with POST is taken to be a change, so one added later is closed to users
// until it is opened on purpose.
const USER_MAY_POST = new Set([
  '/auth/signout', '/auth/switch', '/auth/disconnect',
  // a person's own bell: reading it and emptying it are their own business
  '/api/notifications/read', '/api/notifications/clear',
  // signing this phone up for notices, and off again
  '/api/push/subscribe', '/api/push/unsubscribe',
  // asking the admin, and withdrawing the asking
  '/api/access/request', '/api/access/cancel',
  // reading QuickBooks
  '/api/preview', '/api/gap-check', '/api/negative-items',
  '/api/qb-invoice-file', '/api/invoice-delete',
  '/api/invoice-find-start', '/api/invoice-find-stop', '/api/invoice-find-resume',
  '/api/invoice-find-clear',
  '/api/invoice-details-start', '/api/invoice-details-stop',
  '/api/invoice-details-resume', '/api/invoice-details-clear',
  '/api/adv/recheck', '/api/charges/preview', '/api/charges/scan',
  // finding pasted orders in the advance sheet - a read, and the sorting of it
  '/api/adv/find-start', '/api/adv/find-stop', '/api/adv/find-resume',
  '/api/adv/find-clear', '/api/adv/find-match',
  '/api/void/scan-start', '/api/void/scan-stop', '/api/void/scan-resume',
  '/api/void/scan-clear',
  // reading the return sheet back - looking pasted numbers up in it changes nothing
  '/api/void/check-start', '/api/void/check-stop',
  '/api/void/check-resume', '/api/void/check-clear',
  // finding orders in the courier sheets - a read from end to end
  '/api/find/start', '/api/find/resume', '/api/find/clear',
  '/api/find/sheets', '/api/find/columns',
  // matching a CPR against QuickBooks, before anything is posted
  '/api/merge/upload', '/api/merge/scan', '/api/merge/paste', '/api/merge/clear',
  // reading a CPR back out of QuickBooks - the check list changes nothing
  '/api/check/scan', '/api/check/invoices', '/api/check/resume', '/api/check/clear',
  // the check list's own walk of the courier sheets - a read from end to end
  '/api/check/find-start', '/api/check/find-stop', '/api/check/find-resume',
  '/api/check/find-clear', '/api/check/find-ready',
  '/api/shipfix/plan', '/api/shipfix/clear', '/api/shipfix/clear-log',
  // the CPR's own two questions: which shipping would have to come off, and
  // which payments are sitting there applying to nothing. Both only look.
  '/api/cpr/ship-plan', '/api/cpr/stray',
  // reading the books, and narrowing what was read
  '/api/products/scan', '/api/products/paste',
  '/api/products/clear', '/api/products/clear-log',
  '/api/recat/scan', '/api/recat/clear', '/api/recat/clear-log',
  '/api/desc/scan', '/api/desc/clear', '/api/desc/clear-log',
  '/api/replace/scan', '/api/replace/pairs', '/api/replace/pairs-keep',
  '/api/replace/pick', '/api/replace/shopify', '/api/replace/target',
  '/api/replace/clear', '/api/replace/clear-log',
  '/api/swap/plan', '/api/swap/clear', '/api/swap/clear-log',
  // why invoices are still open - looked up in the attached sheets, nothing written
  '/api/audit/start', '/api/audit/resume', '/api/audit/clear'
]);

// What the admin can hand out, by the name of the job rather than the route behind
// it. A person is given whole jobs - "may receive payments" - not a list of
// addresses. The courier accounts and their keys are not here on purpose: those
// stay with the admin whatever else is given away.
const RIGHT_GROUPS = [
  { key: 'upload', area: 'sales', label: 'Create invoices',
    what: 'Post invoices to QuickBooks',
    paths: ['/api/upload/start', '/api/upload/retry', '/api/upload/resume',
            '/api/upload/handover', '/api/upload/clear'] },

  { key: 'payments', area: 'sales', label: 'Receive payments',
    what: 'Apply collections to open invoices',
    paths: ['/api/cpr/receive', '/api/cpr/receive-clear', '/api/cpr/receive-resume',
            '/api/cpr/bank', '/api/cpr/settled', '/api/cpr/colour',
            '/api/cpr/duplicate', '/api/cpr/fix-payment', '/api/cpr/columns',
            '/api/cpr/root', '/api/sheets/paint',
            '/api/cpr/ship-apply', '/api/cpr/stray-remove',
            '/api/check/fix', '/api/check/fix-resume', '/api/check/fix-clear',
            '/api/receipts/receive', '/api/receipts/mark', '/api/receipts/bank',
            '/api/receipts/duplicate'] },

  { key: 'advance', area: 'sales', label: 'Advance payments',
    what: 'Part payment taken before delivery',
    paths: ['/api/adv/receive', '/api/adv/receive-one', '/api/adv/receive-clear',
            '/api/adv/receive-resume', '/api/adv/banks', '/api/adv/columns',
            '/api/adv/columns-reset', '/api/adv/root', '/api/adv/mark-posted',
            '/api/adv/fix-payment', '/api/adv/delete-payment'] },

  { key: 'charges', area: 'purchases', label: 'Delivery charges',
    what: 'Courier fees as journal entries',
    paths: ['/api/charges/post', '/api/charges/post-lines', '/api/charges/lines',
            '/api/charges/accounts', '/api/charges/columns', '/api/charges/dc-root'] },

  { key: 'void', area: 'sales', label: 'Void invoices',
    what: 'Zero a returned order, keep its number',
    paths: ['/api/void/start', '/api/void/resume', '/api/void/clear',
            '/api/void/sheet-root'] },

  { key: 'merge', area: 'sales', label: 'Merge receipts, adjust shipping',
    what: 'One receipt against many orders',
    paths: ['/api/merge/strip', '/api/merge/strip-clear-log', '/api/merge/columns',
            '/api/shipfix/run'] },

  { key: 'changes', area: 'items', label: 'Reclassify transactions',
    what: 'Move to another item or account',
    paths: ['/api/replace/run', '/api/swap/run', '/api/recat/run', '/api/desc/run',
            '/api/recat/history/clear'] },

  { key: 'products', area: 'items', label: 'Costs, stock and merges',
    what: 'Costs, stock on hand, merges',
    paths: ['/api/products/apply', '/api/products/record/clear'] },

  { key: 'purchases', area: 'purchases', label: 'Purchase orders and bills',
    what: 'Raise purchase orders and bills',
    paths: ['/api/purchases/create', '/api/purchases/attach', '/api/purchases/read'] },

  { key: 'delete', area: 'sales', label: 'Delete invoices',
    what: 'Remove invoices for good — no undo',
    paths: ['/api/invoice-delete-start', '/api/invoice-delete-clear',
            '/api/invoice-delete-resume', '/api/invoice-rename'] },

  { key: 'couriersync', area: 'purchases', label: 'Bring courier data in',
    what: 'Pull courier orders and receipts in',
    paths: ['/api/courier/sync', '/api/courier/backfill', '/api/courier/cpr-chase',
            '/api/courier/keeper-now', '/api/courier/backfill-clear',
            '/api/courier/backfill-resume', '/api/receipts/login', '/api/receipts/logout'] },

  // The links to the audit's sheets (/api/audit/link, /link-remove, /pick) are in no group on purpose: only the admin attaches, changes or
  // removes them, and it cannot be handed out.

  { key: 'settings', area: 'items', label: 'SKU mappings',
    what: 'Remembered SKU-to-item matches',
    paths: ['/api/mappings'] }
];

// Which page belongs to which job.
//
// A limited user is given areas of the books, not a list of buttons, so a page
// whose whole purpose is an area they were not given has no reason to be in
// front of them - not in the rail, and not at its own address either, because a
// rail that hides a page while the page still answers is only half a rule.
//
// Everything not named here is open to anybody who is let in: the dashboard, the
// searches, the settings. Reading was never what was being handed out.
const PAGE_NEED = new Map(Object.entries({
  '/convert.html': 'upload',
  '/upload.html': 'upload',
  '/payments.html': 'payments',
  '/merge.html': 'merge',
  '/checklist.html': 'payments',
  '/advance.html': 'advance',
  '/charges.html': 'charges',
  '/void.html': 'void',
  '/purchases.html': 'purchases',
  '/products.html': 'products',
  '/fix.html': 'products',
  '/replace.html': 'changes',
  '/swap.html': 'changes',
  '/recat.html': 'changes',
  '/desc.html': 'changes',
  '/couriers.html': 'couriersync',
  '/courier-dash.html': 'couriersync',
  '/receipts.html': 'couriersync',
  '/cprs.html': 'couriersync'
}));

// route -> the job it belongs to, worked out once
const RIGHT_OF_PATH = new Map();
RIGHT_GROUPS.forEach(g => g.paths.forEach(p => RIGHT_OF_PATH.set(p, g.key)));

// Stopping is always allowed, whoever started it. A run belongs to the company and
// is watched from every computer, so anyone seeing one go wrong must be able to end
// it - that is the safe direction. Ending is the same door: it only puts a finished
// run away, and a desk left holding one it may not close is a desk nobody can use.
const isStop = p => /-(stop|end)$/.test(p) ||
  p.endsWith("/stop") || p.endsWith("/end") || p.endsWith("/pause");

app.use(async (req, res, next) => {
  if (req.method !== 'POST') return next();
  const path = req.path;
  if (path.indexOf("/api/") !== 0 && path.indexOf("/auth/") !== 0) return next();
  if (USER_MAY_POST.has(path) || isStop(path)) return next();

  const sub = currentUser(req);
  if (!sub) return next();               // not signed in - the route says so itself

  try {
    const who = await whoIs(sub);
    if (who && who.admin) return next();
    // their role, or the jobs the admin ticked for them
    if (mayDo(who, RIGHT_OF_PATH.get(path))) return next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.status(403).json({
    error: 'This change is not one of the jobs you were given, so it is ' +
           'read-only for you. Ask the admin to make it, or to give you the right to it.'
  });
});

// ==================== OAuth ====================
// The company's own door, and the only place its key comes from. There is no
// button for it any more: an admin is walked here by the sign-in below, and
// anyone else who types the address is turned away, so a user can neither take
// the company over nor, by disconnecting later, stop the app for everyone.
app.get('/auth/connect', async (req, res) => {
  const who = await whoIs(currentUser(req));
  if (!who || !who.admin) {
    return res.redirect('/auth/signin');
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 600000, sameSite: 'lax' });

  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting openid profile email',
    redirect_uri: `${BASE_URL}/auth/callback`,
    state
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

// The door everybody comes through. It asks Intuit only who the person is.
//
// It cannot ask for the company as well, and this is Intuit's rule rather than a
// choice made here: only a listed admin of a QuickBooks company may connect an
// app to it. Everybody else is stopped at Intuit's own screen with "You're not a
// listed admin for this company" - however many companies they work in, and
// whatever the admin has let them do inside those companies.
//
// So the company is asked for here instead, on the app's own Choose your company
// screen, out of the ones an admin has already connected. Connecting is done once
// per company, by an admin; choosing between them is everyone's, every day.
app.get('/auth/signin', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 600000, sameSite: 'lax' });
  res.cookie('oauth_door', 'user', { httpOnly: true, maxAge: 600000, sameSite: 'lax' });

  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: `${BASE_URL}/auth/callback`,
    state
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, realmId, state } = req.query;

    if (!state || state !== req.cookies.oauth_state) {
      return res.status(400).send('Invalid state. Please try connecting again.');
    }
    res.clearCookie('oauth_state');
    if (!code) return res.status(400).send('Missing authorization code');

    const basic = Buffer.from(
      `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BASE_URL}/auth/callback`
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokens).slice(0, 300));
    }

    let sub = null, email = null, name = null;
    try {
      const ui = await fetch(USERINFO_URL, {
        headers: { 'Authorization': 'Bearer ' + tokens.access_token, 'Accept': 'application/json' }
      });
      if (ui.ok) {
        const info = await ui.json();
        sub = info.sub;
        email = info.email || null;
        name = [info.givenName, info.familyName].filter(Boolean).join(' ') || null;
      }
    } catch (e) {
      console.error('userinfo error:', e.message);
    }

    if (!sub) {
      return res.status(400).send('Could not identify your Intuit account. Please try signing in again.');
    }

    const firstTime = await upsertUser(sub, email, name);
    forgetWho(sub);

    // Somebody who withdrew and has come back is asking again by being here. An
    // address already answered is untouched - signing in rubs out no answer.
    if (!firstTime) await resumeAsking(sub).catch(() => {});

    if (firstTime) {
      const label = name || email || 'Somebody';
      await tellAdmins({
        kind: 'signin',
        title: label + ' is waiting to be let in',
        body: (email || 'no address') + ' signed in for the first time and has no ' +
              'access yet. Choose their companies and their role on Manage users.',
        link: '/users.html?who=' + encodeURIComponent(sub),
        subject: label + ' is waiting to be let in - Shopify to QuickBooks',
        lines: [
          label + ' (' + (email || 'no address') + ') has signed in to the app for ' +
          'the first time.',
          'They have no access and no company until you say so. Open the link below ' +
          'on any phone: it lands on them, with the companies to tick and what they ' +
          'may do. Saving is all it takes - their screen opens by itself.',
          BASE_URL + '/users.html?who=' + encodeURIComponent(sub)
        ]
      });
    }
    res.cookie('uid', sign(sub), { httpOnly: true, maxAge: 60 * 24 * 3600 * 1000, sameSite: 'lax' });

    const isAdmin = ADMIN_EMAILS.has(String(email || '').toLowerCase());
    res.clearCookie('oauth_door');

    // Coming back from the admin's own connect door, Intuit says which company was
    // connected. Coming back from the plain sign-in it says nothing, because only
    // an admin may connect one - so the company is chosen afterwards, on the app's
    // own screen, out of the ones already connected. One of them and there is
    // nothing to choose; several and the chooser is where they land.
    let joinTo = realmId;
    if (!joinTo) {
      const mine = await companiesFor(sub);
      if (mine.length === 1) joinTo = mine[0].realmId;
      else if (mine.length > 1) return res.redirect('/choose.html');
      else if (isAdmin) return res.redirect('/auth/connect');
      else return res.redirect('/choose.html');
    }

    const known = await getCompany(joinTo);

    if (isAdmin) {
      // The key every page in the app works through, and the admin is the only
      // one who ever writes it. The company's name is read with it, so the rail
      // has something to say other than a number.
      if (tokens.refresh_token) {
        await saveCompany(joinTo, known ? known.company_name : null, tokens.refresh_token);
        try {
          const info = await getCompanyInfo(joinTo, tokens.access_token);
          if (info && info.CompanyName) {
            await saveCompany(joinTo, info.CompanyName, tokens.refresh_token);
          }
        } catch (e) {
          console.error('CompanyInfo error:', e.message);
        }
      }
    } else if (!known) {
      // A company the app has never been connected to. Connecting one is an
      // admin's, so the chooser says so rather than leaving them at a dead end.
      return res.redirect('/choose.html');
    }
    // a user's key is read once, for the name and address above, and kept nowhere

    await linkCompany(sub, joinTo);
    forgetSettled(sub);
    res.cookie('realm_id', joinTo, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
    inside(res, true);

    res.redirect('/?connected=1');

  } catch (err) {
    console.error(err);
    res.status(500).send('Connection failed: ' + err.message);
  }
});

// The one fact the pages need before they have asked anything: is this browser
// all the way in - signed in, let in, and in a company - or not?
//
// It has to be a cookie, and it has to mean exactly that. The rail, the toolbar
// and the whole frame are drawn on the strength of it at the first line of
// nav.js, before any round trip. A cookie that meant only "has a session" drew
// the frame for somebody the server was about to send back to the door, and the
// frame flashed past on its way out. So it is set when they land in a company
// and cleared the moment they are anywhere else.
// Whether this person is settled in a company, remembered for a minute. Every page
// asked the database twice to find out, and a person clicking about the app asks
// the same question over and over with the same answer.
const settledCache = new Map();            // sub|realm -> { ok, at }
const SETTLED_LIFE = 60 * 1000;

async function isSettled(sub, realmId) {
  const key = sub + '|' + realmId;
  const kept = settledCache.get(key);
  if (kept && Date.now() - kept.at < SETTLED_LIFE) return kept.ok;

  const ok = await userOwns(sub, realmId) && !!(await getCompany(realmId));
  settledCache.set(key, { ok, at: Date.now() });
  if (settledCache.size > 500) settledCache.clear();
  return ok;
}

function forgetSettled(sub) {
  for (const k of settledCache.keys()) if (k.startsWith(sub + '|')) settledCache.delete(k);
}

function inside(res, yes) {
  if (yes) res.cookie('signed', '1', { maxAge: 60 * 24 * 3600 * 1000, sameSite: 'lax' });
  else res.clearCookie('signed');
}

// Which companies this person may work in.
//
// QuickBooks cannot be asked. It has no endpoint that lists a user's companies,
// and the person cannot be sent to Intuit's own chooser to pick one either,
// because Intuit lets only a listed admin of a company connect an app to it. So
// the admin says it, on the Manage users page, and everyone is shown that and
// nothing else - never the whole shelf of companies the app happens to hold.
//
// The admin is the exception, because connecting them is the admin's own doing.
async function companiesFor(sub) {
  const connected = await listCompanies();
  const who = await whoIs(sub);
  if (who && who.admin) return connected;

  const mine = new Set(await realmsForUser(sub));
  return connected.filter(c => mine.has(c.realmId));
}

// A notice kept, and the same notice put on the person's phone. Everything that
// tells anybody anything goes through here, so there is one place that decides
// what a notice is and one place that sends it.
async function tell(sub, n) {
  await notify(sub, n);
  pushTo(sub, n).catch(() => {});
}

// Telling the admins something, in the app and by email both. An address named in
// ADMIN_EMAILS that has never signed in has no row to hang a notification on, so
// it gets the email alone.
async function tellAdmins({ kind, title, body, link, subject, lines }) {
  const emails = [...ADMIN_EMAILS];
  try {
    const rows = await usersByEmails(emails);
    for (const a of rows) await tell(a.sub, { kind, title, body, link });
  } catch (e) {
    console.error('admin notice failed:', e.message);
  }
  for (const to of emails) {
    sendMail(to, subject || title, lines || [title, body || '']).catch(() => {});
  }
}

// What to call a company on screen. A row saved before its name could be read
// carries nothing, or the word "null" written where a name should have been, and
// either one has been showing up in the rail as if it were the company's name.
// So the name is asked of QuickBooks once, the answer is kept, and a company that
// still will not say is shown by its number rather than by a word.
function realName(n) {
  const s = String(n == null ? '' : n).trim();
  return (!s || s === 'null' || s === 'undefined') ? '' : s;
}

async function companyLabel(company) {
  const kept = realName(company.company_name);
  if (kept) return kept;

  try {
    const token = await getAccessToken(company.realm_id);
    const info = await getCompanyInfo(company.realm_id, token);
    const got = realName(info && info.CompanyName);
    if (got) {
      await renameCompany(company.realm_id, got);
      return got;
    }
  } catch (e) {
    console.error('company name lookup:', e.message);
  }
  return company.realm_id;
}

app.get('/auth/status', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) { inside(res, false); return res.json({ signedIn: false, connected: false }); }

  const user = await getUser(sub);
  const who = await whoIs(sub);
  const realmId = req.cookies.realm_id;

  // May they come in at all, and is there anywhere for them to go? Both, because
  // an account the admin has allowed but given no company to has nowhere to land.
  const letIn = !!(who && (who.admin || (who.allowed && who.role !== 'none')));
  const mine = letIn ? await companiesFor(sub) : [];

  if (!realmId || !(await userOwns(sub, realmId))) {
    inside(res, false);
    return res.json({
      signedIn: true,
      connected: false,
      letIn,
      // an address nobody has decided about yet is waiting; one that was decided
      // about and still may not come in was turned away, which reads differently
      decided: !!(user && user.decided_at),
      asking: !(user && user.asked === false),
      limited: !!(who && !who.admin && who.role === 'custom'),
      companyCount: mine.length,
      admin: !!(who && who.admin),
      email: (who && who.email) || null,
      adminCount: ADMIN_EMAILS.size,
      user: user ? (user.name || user.email) : null
    });
  }

  const company = await getCompany(realmId);
  inside(res, letIn && !!company);
  res.json({
    signedIn: true,
    connected: !!company,
    decided: !!(user && user.decided_at),
    asking: !(user && user.asked === false),
    companyName: company ? await companyLabel(company) : null,
    realmId,
    // the pages read these to put away every button the person may not press
    admin: !!(who && who.admin),
    letIn,
    // given areas rather than the whole of the books - the rail is cut to them
    limited: !!(who && !who.admin && who.role === 'custom'),
    companyCount: mine.length,
    // what the server knows you by, and how many addresses it holds as admin -
    // the two things worth seeing when a sign-in is not the admin it should be
    email: (who && who.email) || null,
    adminCount: ADMIN_EMAILS.size,
    // The role itself is not sent. The pages have no use for its name, and the
    // person it belongs to is not told it - what they may do shows in what opens.
    // a standard user has every job; anyone else has what was ticked
    rights: (who && who.role === 'standard')
      ? RIGHT_GROUPS.map(g => g.key)
      : ((who && who.rights) || []),
    jobs: RIGHT_GROUPS.map(g => g.key),
    user: user ? (user.name || user.email) : null
  });
});

app.post('/auth/disconnect', (req, res) => {
  res.clearCookie('realm_id');
  inside(res, false);
  res.json({ ok: true });
});

app.post('/auth/signout', (req, res) => {
  res.clearCookie('realm_id');
  res.clearCookie('uid');
  inside(res, false);
  res.json({ ok: true });
});

app.get('/auth/companies', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.json({ companies: [], current: null });
  try {
    const list = await companiesFor(sub);
    const who = await whoIs(sub);
    res.json({
      companies: list,
      current: req.cookies.realm_id || null,
      admin: !!(who && who.admin)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/switch', async (req, res) => {
  const sub = currentUser(req);
  if (!sub) return res.status(401).json({ error: 'Not signed in' });

  const { realmId } = req.body;
  if (!realmId) return res.status(400).json({ error: 'realmId required' });

  const who = await whoIs(sub);
  if (!who || who.allowed === false) {
    return res.status(403).json({ error: 'The admin has not let this account in.' });
  }

  // The chooser only offered what this person may enter; asked for anything else -
  // by another window, or an address kept from before - the answer is the same.
  const mine = await companiesFor(sub);
  if (!mine.some(c => c.realmId === String(realmId))) {
    return res.status(403).json({ error: 'That company was not given to you. Ask the admin.' });
  }

  const company = await getCompany(realmId);
  if (!company) return res.status(404).json({ error: 'Company not connected' });

  forgetSettled(sub);
  res.cookie('realm_id', realmId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  inside(res, true);
  res.json({ ok: true, companyName: await companyLabel(company) });
});

// ==================== Helpers ====================
function clean(s) {
  return String(s ?? '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
}

function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = clean(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normInv(v) {
  let s = String(v ?? '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  if (!s) return '';
  s = s.replace(/(\d),(\d)/g, '$1$2').replace(/^(\d+)\.0+$/, '$1');
  s = s.replace(/^[#\s]+/, '').replace(/\s+/g, ' ').toLowerCase();
  return s.replace(/^0+(?=[0-9])/, '').replace(/([^0-9])0+([0-9])/g, '$1$2');
}

function digitsOf(v) {
  return String(v ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=[0-9])/, '');
}

function shiftDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ==================== Excel preview ====================
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (!rows.length) throw new Error('File is empty');

  const header = rows[0].map(h => clean(h).replace(/^\*/, '').toLowerCase());
  const col = n => header.indexOf(n.toLowerCase());

  const cInv = col('invoiceno');
  const cCust = col('customer');
  const cDate = col('invoicedate');
  const cDue = col('duedate');
  const cTerms = col('terms');
  const cMemo = col('memo');
  const cItem = header.findIndex(h => h.startsWith('item(product'));
  const cDesc = col('itemdescription');
  const cQty = col('itemquantity');
  const cRate = col('itemrate');
  const cAmt = col('itemamount');
  const cSvc = col('service date');

  if (cInv < 0 || cItem < 0 || cAmt < 0) {
    throw new Error('Required columns not found: *InvoiceNo, Item(Product/Service), *ItemAmount');
  }

  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const docNo = clean(r[cInv]);
    if (!docNo) continue;

    if (!map.has(docNo)) {
      map.set(docNo, {
        docNumber: docNo,
        customer: cCust >= 0 ? clean(r[cCust]) : '',
        txnDate: cDate >= 0 ? toISODate(r[cDate]) : null,
        dueDate: cDue >= 0 ? toISODate(r[cDue]) : null,
        terms: cTerms >= 0 ? clean(r[cTerms]) : '',
        memo: cMemo >= 0 ? clean(r[cMemo]) : '',
        lines: []
      });
    }

    map.get(docNo).lines.push({
      item: clean(r[cItem]),
      desc: cDesc >= 0 ? clean(r[cDesc]) : '',
      qty: cQty >= 0 ? (num(r[cQty]) || 1) : 1,
      rate: cRate >= 0 ? num(r[cRate]) : 0,
      amt: num(r[cAmt]),
      svc: cSvc >= 0 ? toISODate(r[cSvc]) : null
    });
  }

  return Array.from(map.values());
}

app.post('/api/preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const invoices = parseWorkbook(req.file.buffer);
    const totalLines = invoices.reduce((s, i) => s + i.lines.length, 0);
    const customers = [...new Set(invoices.map(i => i.customer).filter(Boolean))];
    const items = [...new Set(invoices.flatMap(i => i.lines.map(l => l.item)).filter(Boolean))].sort();
    res.json({ count: invoices.length, totalLines, customers, items, invoices });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== QB invoice list from an uploaded file ====================
app.post('/api/qb-invoice-file', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: true, cellDates: false });
    const numbers = [];

    for (const sheetName of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
        header: 1, raw: false, defval: '', blankrows: false
      });
      if (!grid.length) continue;

      let headerRow = -1, col = -1;
      for (let r = 0; r < Math.min(grid.length, 15) && headerRow < 0; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) {
          const h = clean(row[c]).toLowerCase();
          if (/^(ref no\.?|reference number|invoice no\.?|invoice number|doc number|docnumber|num|number|no\.?|invoice)$/.test(h)) {
            headerRow = r; col = c; break;
          }
        }
      }

      if (headerRow < 0) {
        const probe = grid.slice(0, 40);
        let best = -1, bestScore = 0;
        const width = Math.max(...probe.map(r => r.length));
        for (let c = 0; c < width; c++) {
          let score = 0;
          probe.forEach(r => {
            const v = clean(r[c]);
            if (v && /^[#]?\d[\d\-\/]*$/.test(v)) score++;
          });
          if (score > bestScore) { bestScore = score; best = c; }
        }
        if (best < 0 || bestScore < 3) continue;
        headerRow = -1; col = best;
      }

      for (let r = headerRow + 1; r < grid.length; r++) {
        const v = clean((grid[r] || [])[col]);
        if (!v) continue;
        if (/^total$/i.test(v)) continue;
        numbers.push(v);
      }
    }

    const unique = [...new Set(numbers)];
    if (!unique.length) {
      return res.status(400).json({
        error: 'No invoice numbers found. Make sure the file has a column named "Ref no." or "Invoice number".'
      });
    }

    res.json({ count: unique.length, numbers: unique });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== Negative items ====================
app.get('/api/negative-items', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ items: await getNegativeItems(realmId) });
});

app.post('/api/negative-items', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  await setNegativeItems(realmId, req.body.items || []);
  res.json({ ok: true });
});

// ==================== QB products ====================
app.get('/api/qb-products', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const products = [];
    let start = 1;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Item || [];
      arr.forEach(it => {
        products.push({ id: it.Id, name: it.Name, sku: it.Sku || '', active: it.Active !== false, type: it.Type || '',
          // the wording QuickBooks keeps for this product, so a line picked by
          // hand says what a line matched by its code says
          desc: it.PurchaseDesc || it.Description || '' });
      });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) break;
    }

    res.json({ count: products.length, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A QuickBooks report, read as it comes. What a sale cost and what stock is
// worth are not in any query - they are only in the reports - so this is the way
// in for the product work. Only the reports named here can be asked for, and
// nothing is written.
const QB_REPORTS = [
  'ItemSales',                  // Sales by Product/Service Summary - has COGS
  'InventoryValuationSummary',
  'InventoryValuationDetail',
  'PurchasesByVendorDetail',
  'ProfitAndLoss'
];

app.get('/api/qb-report', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const name = String(req.query.name || '');
    if (!QB_REPORTS.includes(name)) {
      throw new Error('Unknown report. One of: ' + QB_REPORTS.join(', '));
    }

    const token = await getAccessToken(realmId);
    const out = await qbReport(realmId, token, name, {
      start_date: req.query.from,
      end_date: req.query.to,
      summarize_column_by: req.query.summarize,
      accounting_method: req.query.method
    });

    // the whole report is heavy, so what comes back first is its shape: the
    // columns it carries and how many rows - enough to see whether it is the
    // report the work needs
    const cols = ((out.Columns || {}).Column || []).map(c => c.ColTitle || c.ColType || '');
    const rows = ((out.Rows || {}).Row || []);
    if (req.query.full === '1') return res.json(out);

    res.json({
      report: (out.Header || {}).ReportName || name,
      time: (out.Header || {}).Time || '',
      from: (out.Header || {}).StartPeriod || '',
      to: (out.Header || {}).EndPeriod || '',
      columns: cols,
      topRows: rows.length,
      sample: rows.slice(0, 3)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Whether this company can be written to in a particular way is not a thing to
// guess at. This asks QuickBooks for one row of an entity and says what came
// back - an inventory adjustment cannot be made through the API at all, and a
// purchase order can, and the difference decides what the products work is able
// to offer. Read-only, and only the entities named here.
const QB_ENTITIES = [
  'InventoryAdjustment', 'PurchaseOrder', 'Bill', 'Purchase', 'Item', 'Vendor'
];

app.get('/api/qb-entity', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const name = String(req.query.name || '');
    if (!QB_ENTITIES.includes(name)) {
      throw new Error('Unknown entity. One of: ' + QB_ENTITIES.join(', '));
    }

    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM ${name} MAXRESULTS 1`);
    const one = (q[name] || [])[0] || null;

    res.json({
      entity: name,
      supported: true,
      found: (q[name] || []).length,
      fields: one ? Object.keys(one) : [],
      sample: one
    });
  } catch (e) {
    res.status(400).json({ entity: String(req.query.name || ''), supported: false, error: e.message });
  }
});

// Reading an entity back tells us it can be asked for, not that it can be made.
// An empty query answers the same either way, and the one thing that settles it -
// whether stock can be put right from here at all - is what QuickBooks says when
// something is posted to it.
//
// So a deliberately empty body is posted. Nothing can be created from nothing:
// either QuickBooks says the entity is not there to post to, or it complains
// about the missing fields, and that complaint is the yes. Writes nothing.
app.get('/api/qb-can-write', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const name = String(req.query.name || '');
    if (!QB_ENTITIES.includes(name)) {
      throw new Error('Unknown entity. One of: ' + QB_ENTITIES.join(', '));
    }

    const token = await getAccessToken(realmId);
    const r = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realmId}/${name.toLowerCase()}?minorversion=70`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: '{}'
      });

    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { /* left as it came */ }
    const fault = (((data.Fault || {}).Error || [])[0]) || null;

    res.json({
      entity: name,
      status: r.status,
      // a complaint about what is missing means the door is open; being told the
      // operation is not supported means it is not
      verdict: r.status === 404 ? 'no such endpoint'
             : (fault && /unsupported|not supported/i.test(fault.Message || '')) ? 'not open to an app'
             : fault ? 'open - it asked for the fields'
             : 'open',
      message: fault ? (fault.Message + (fault.Detail ? ' - ' + fault.Detail : '')) : text.slice(0, 300)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== Item mappings ====================
app.get('/api/mappings', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ mappings: await getMappings(realmId) });
});

app.post('/api/mappings', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = req.body.mappings || [];
  try {
    for (const m of list) {
      if (!m.key) continue;
      await saveMapping(realmId, m.key, m.sku, m.name, m.qbItem, m.skip);
    }
    res.json({ ok: true, saved: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== QB invoice numbers (windowed) ====================
app.get('/api/qb-invoices', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  async function fetchWindow(token, a, b, depth) {
    const out = [];
    let start = 1;
    let hitCap = false;

    while (true) {
      const q = await qbQuery(realmId, token,
        `SELECT DocNumber, TxnDate FROM Invoice ` +
        `WHERE TxnDate >= '${a}' AND TxnDate <= '${b}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Invoice || [];
      arr.forEach(inv => { if (inv.DocNumber) out.push(inv.DocNumber); });
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) { hitCap = true; break; }
    }

    if (hitCap && depth < 8 && a !== b) {
      const days = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
      if (days >= 1) {
        const mid = shiftDays(a, Math.floor(days / 2));
        const left = await fetchWindow(token, a, mid, depth + 1);
        const right = await fetchWindow(token, shiftDays(mid, 1), b, depth + 1);
        return left.concat(right);
      }
    }
    return out;
  }

  try {
    const token = await getAccessToken(realmId);
    const all = [];
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 400) {
      let end = shiftDays(cursor, 6);
      if (end > to) end = to;
      all.push(...await fetchWindow(token, cursor, end, 0));
      cursor = shiftDays(end, 1);
      windows++;
    }

    const numbers = [...new Set(all)];
    res.json({ count: numbers.length, numbers, windows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gap-check', (req, res) => {
  const { qbNumbers = [], shopifyNumbers = [] } = req.body;

  const qbSet = new Set();
  const qbDigits = new Set();
  qbNumbers.forEach(n => {
    const k = normInv(n);
    if (k) qbSet.add(k);
    const d = digitsOf(n);
    if (d) qbDigits.add(d);
  });

  const missing = [];
  const present = [];
  const seen = new Set();

  shopifyNumbers.forEach(raw => {
    const k = normInv(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (qbSet.has(k) || qbDigits.has(digitsOf(raw))) present.push(String(raw).trim());
    else missing.push(String(raw).trim());
  });

  res.json({
    inQb: qbNumbers.length,
    inShopify: seen.size,
    present: present.length,
    missing
  });
});

// ==================== Duplicate finder ====================
// Reading a span of invoices to find the ones that exist twice.
//
// A week at a time, as a run that can be stopped: a year picked by mistake is
// taken back at the end of the week in flight instead of being waited out, and
// what was read up to then is still sorted and shown.
function invoiceDetailsRead(realmId, from, to) {
  if (!from || !to) throw new Error('Choose both dates first');
  if (from > to) throw new Error('The first date is after the last one');

  // the week-long windows the span falls into
  const windows = [];
  let at = from;
  while (at <= to && windows.length < 400) {
    let end = shiftDays(at, 6);
    if (end > to) end = to;
    windows.push([at, end]);
    at = shiftDays(end, 1);
  }

  async function fetchWindow(token, a, b, depth) {
    const out = [];
    let begin = 1;
    let hitCap = false;

    while (true) {
      const q = await qbQuery(realmId, token,
        'SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, SyncToken FROM Invoice ' +
        "WHERE TxnDate >= '" + a + "' AND TxnDate <= '" + b + "' " +
        'STARTPOSITION ' + begin + ' MAXRESULTS 1000');
      const arr = q.Invoice || [];
      arr.forEach(inv => {
        const total = Number(inv.TotalAmt || 0);
        const bal = Number(inv.Balance === undefined ? total : inv.Balance);
        out.push({
          id: inv.Id,
          doc: inv.DocNumber || '',
          date: inv.TxnDate || '',
          total: total,
          balance: bal,
          paid: total > 0 && bal <= 0.005,
          partial: bal > 0.005 && bal < total - 0.005,
          syncToken: inv.SyncToken
        });
      });
      if (arr.length < 1000) break;
      begin += 1000;
      if (begin > 9000) { hitCap = true; break; }
    }

    // too many for one window to carry - split it and read the halves
    if (hitCap && depth < 8 && a !== b) {
      const days = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
      if (days >= 1) {
        const mid = shiftDays(a, Math.floor(days / 2));
        const left = await fetchWindow(token, a, mid, depth + 1);
        const right = await fetchWindow(token, shiftDays(mid, 1), b, depth + 1);
        return left.concat(right);
      }
    }
    return out;
  }

  return {
    label: from + ' to ' + to,
    steps: windows.length,

    async plan(run) {
      run.data.token = await getAccessToken(realmId);
      run.data.all = [];
    },

    async step(run) {
      const w = windows[run.cursor];
      if (!w) { run.ended = true; return { done: true }; }

      const got = await fetchWindow(run.data.token, w[0], w[1], 0);
      run.data.all.push(...got);

      return {
        count: got.length,
        found: got.length > 0,
        msg: w[0] + ' to ' + w[1] + ': ' + got.length + ' invoices' +
             ' (' + (run.cursor + 1) + ' of ' + windows.length + ' weeks)'
      };
    },

    endLine(run) {
      return '--- ' + run.data.all.length + ' invoices read ---';
    },

    async finish(run) {
      const all = run.data.all;

      const groups = new Map();
      all.forEach(inv => {
        const k = digitsOf(inv.doc);
        if (!k) return;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(inv);
      });

      const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
      const isPaid = x => x.paid || x.partial;

      const cat = {
        bothUnpaid: [],
        hashPaid: [],
        plainPaid: [],
        bothPaid: [],
        amountDiffers: [],
        dupOnePaid: [],
        dupAllUnpaid: [],
        dupAllPaid: [],
        plainOnly: []
      };

      groups.forEach((list, k) => {
        const withHash = list.filter(x => x.doc.charAt(0) === '#');
        const plain = list.filter(x => x.doc.charAt(0) !== '#');

        [['hash', withHash], ['plain', plain]].forEach(pair => {
          const style = pair[0], copies = pair[1];
          if (copies.length < 2) return;
          const paidOnes = copies.filter(isPaid);
          const unpaidOnes = copies.filter(x => !isPaid(x));
          const entry = { digits: k, style, copies, paidOnes, unpaidOnes };
          if (!paidOnes.length) cat.dupAllUnpaid.push(entry);
          else if (!unpaidOnes.length) cat.dupAllPaid.push(entry);
          else cat.dupOnePaid.push(entry);
        });

        if (withHash.length === 1 && plain.length === 1) {
          const h = withHash[0], pl = plain[0];
          const entry = { digits: k, hash: h, plain: pl };
          if (!near(h.total, pl.total)) cat.amountDiffers.push(entry);
          else if (!isPaid(h) && !isPaid(pl)) cat.bothUnpaid.push(entry);
          else if (isPaid(h) && !isPaid(pl)) cat.hashPaid.push(entry);
          else if (!isPaid(h) && isPaid(pl)) cat.plainPaid.push(entry);
          else cat.bothPaid.push(entry);
        }

        if (plain.length === 1 && !withHash.length) cat.plainOnly.push(plain[0]);
      });

      return { total: all.length, from, to, cat };
    }
  };
}

app.post('/api/invoice-details-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const id = startRead(req.desk, 'invoice-details',
      invoiceDetailsRead(realmId, req.body.from, req.body.to));
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/invoice-details-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = readSnapshot(req.desk, 'invoice-details', req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/invoice-details-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopRead(req.desk, 'invoice-details') });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/invoice-details-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endRead(req.desk, 'invoice-details') });
});


app.post('/api/invoice-details-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeRead(req.desk, 'invoice-details');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/invoice-details-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearRead(req.desk, 'invoice-details');
  if (!ok) return res.status(409).json({ error: 'The read is still going' });
  res.json({ ok: true });
});

app.post('/api/invoice-rename', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id, newDoc } = req.body;
  if (!id || !newDoc) return res.status(400).json({ error: 'id and newDoc required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${id}'`);
    const inv = (q.Invoice || [])[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const r = await fetch(`${API}/v3/company/${realmId}/invoice?minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        Id: inv.Id,
        SyncToken: inv.SyncToken,
        sparse: true,
        DocNumber: newDoc
      })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true, id: inv.Id, newDoc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invoice-delete', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Invoice WHERE Id = '${id}'`);
    const inv = (q.Invoice || [])[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const r = await fetch(`${API}/v3/company/${realmId}/invoice?operation=delete&minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    await logUpload(realmId, inv.DocNumber, 'deleted', `QB Id ${inv.Id} removed as a duplicate`, null);
    res.json({ ok: true, id: inv.Id, doc: inv.DocNumber });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Deleting invoices in bulk ====================
// The page shows the whole list first; this only runs on what it is handed.

// Looking a pasted list of invoice numbers up, forty at a time, as a run that
// can be stopped. The same read as before - what changed is the waiting: a
// request nobody could take back is now a run with a Stop on it.
function invoiceFindRead(realmId, numbers) {
  const list = (Array.isArray(numbers) ? numbers : String(numbers || '').split(/[\s,;]+/))
    .map(x => String(x).trim())
    .filter(Boolean);
  if (!list.length) throw new Error('Paste some invoice numbers first');

  const wanted = [];
  const seen = new Set();
  const asWritten = new Map();
  list.forEach(n => {
    const d = digitsOf(n);
    if (!d) return;
    if (!asWritten.has(d)) asWritten.set(d, n);
    if (seen.has(d)) return;
    seen.add(d);
    wanted.push(d);
  });
  if (!wanted.length) throw new Error('None of those lines holds an invoice number');

  return {
    label: wanted.length + ' invoice numbers',
    steps: Math.ceil(wanted.length / 40),

    async plan(run) {
      run.data.token = await getAccessToken(realmId);
      run.data.found = new Map();
      run.data.asked = list.length;
    },

    async step(run) {
      const at = run.cursor * 40;
      if (at >= wanted.length) { run.ended = true; return { done: true }; }

      const chunk = wanted.slice(at, at + 40);
      const variants = [];
      chunk.forEach(d => variants.push("'#" + d + "'", "'" + d + "'"));

      const q = await qbQuery(realmId, run.data.token,
        'SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, LinkedTxn ' +
        'FROM Invoice WHERE DocNumber IN (' + variants.join(',') + ') MAXRESULTS 1000');

      let here = 0;
      (q.Invoice || []).forEach(inv => {
        const d = digitsOf(inv.DocNumber);
        if (!d) return;
        if (!run.data.found.has(d)) run.data.found.set(d, []);
        run.data.found.get(d).push(inv);
        here++;
      });

      return {
        count: here,
        found: here > 0,
        msg: Math.min(at + chunk.length, wanted.length) + ' of ' + wanted.length +
             ' looked up - ' + here + ' found in this batch.'
      };
    },

    endLine(run) {
      const r = run.result || {};
      return '--- ' + (r.ready || []).length + ' with no payment, ' +
             (r.paid || []).length + ' paid, ' +
             (r.notFound || []).length + ' not in QuickBooks ---';
    },

    async finish(run, stopped) {
      const token = run.data.token;
      const found = run.data.found;
      // a stopped read has only reached so far down the list
      const read = stopped ? wanted.slice(0, run.cursor * 40) : wanted;

      const ready = [], paid = [], notFound = [];
      const payIds = new Set();
      const ourInvoiceIds = new Set();

      read.forEach(d => {
        const copies = found.get(d);
        if (!copies || !copies.length) { notFound.push(asWritten.get(d) || d); return; }

        copies.forEach(inv => {
          ourInvoiceIds.add(String(inv.Id));

          const total = Number(inv.TotalAmt || 0);
          const linked = (inv.LinkedTxn || [])
            .filter(t => t.TxnType === 'Payment')
            .map(t => String(t.TxnId));

          const entry = {
            id: inv.Id,
            doc: inv.DocNumber || '',
            hash: (inv.DocNumber || '').charAt(0) === '#',
            date: inv.TxnDate || '',
            total,
            balance: Number(inv.Balance === undefined ? total : inv.Balance),
            customer: inv.CustomerRef ? (inv.CustomerRef.name || '') : '',
            paymentIds: linked
          };

          if (linked.length || entry.balance <= 0.005) {
            linked.forEach(id => payIds.add(id));
            paid.push(entry);
          } else {
            ready.push(entry);
          }
        });
      });

      // what each of those payments is, and whether it touches anything else
      const payments = {};
      if (payIds.size) {
        const ids = [...payIds];
        for (let i = 0; i < ids.length; i += 40) {
          const chunk = ids.slice(i, i + 40).map(x => "'" + x + "'").join(',');
          let q;
          try {
            q = await qbQuery(realmId, token,
              'SELECT Id, TxnDate, TotalAmt, PaymentRefNum, DepositToAccountRef, Line ' +
              'FROM Payment WHERE Id IN (' + chunk + ') MAXRESULTS 1000');
          } catch (e) { continue; }

          (q.Payment || []).forEach(pay => {
            const touches = [];
            (pay.Line || []).forEach(l => {
              (l.LinkedTxn || []).forEach(t => {
                if (t.TxnType === 'Invoice') touches.push(String(t.TxnId));
              });
            });

            const outside = touches.filter(id => !ourInvoiceIds.has(id));

            payments[String(pay.Id)] = {
              id: String(pay.Id),
              date: pay.TxnDate || '',
              amount: Number(pay.TotalAmt || 0),
              ref: String(pay.PaymentRefNum || '').trim(),
              bank: pay.DepositToAccountRef ? (pay.DepositToAccountRef.name || '') : '',
              invoices: touches.length,
              outside: outside.length
            };
          });
        }
      }

      // a payment that also covers an invoice we are not touching is a warning
      paid.forEach(x => {
        x.payments = (x.paymentIds || []).map(id => payments[id]).filter(Boolean);
        x.shared = x.payments.some(pay => pay.outside > 0);
        x.paidAmount = x.payments.reduce((t, pay) => t + pay.amount, 0);
      });

      return {
        asked: run.data.asked,
        unique: wanted.length,
        read: read.length,
        ready, paid, notFound
      };
    }
  };
}

app.post('/api/invoice-find-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const id = startRead(req.desk, 'invoice-find', invoiceFindRead(realmId, req.body.numbers));
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/invoice-find-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = readSnapshot(req.desk, 'invoice-find', req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/invoice-find-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopRead(req.desk, 'invoice-find') });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/invoice-find-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endRead(req.desk, 'invoice-find') });
});


app.post('/api/invoice-find-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeRead(req.desk, 'invoice-find');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/invoice-find-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearRead(req.desk, 'invoice-find');
  if (!ok) return res.status(409).json({ error: 'The look-up is still going' });
  res.json({ ok: true });
});

app.post('/api/invoice-delete-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startDelJob(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/invoice-delete-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = delSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/invoice-delete-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopDelJob(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/invoice-delete-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endDelJob(req.desk) });
});


app.post('/api/invoice-delete-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeDelJob(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/invoice-delete-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearDelJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The delete run is still going' });
  res.json({ ok: true });
});
// ==================== Dashboard ====================
app.get('/api/dashboard', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || (today.slice(0, 8) + '01');
  const to   = req.query.to   || today;
  const fresh = req.query.fresh === '1';
  const cacheKey = `dash:${from}:${to}`;

  // served straight from the last snapshot unless a refresh was asked for
  if (!fresh) {
    try {
      const hit = await getCache(realmId, cacheKey, 900);
      if (hit) {
        return res.json(Object.assign({}, hit.value, {
          cached: true,
          ageSeconds: hit.ageSeconds
        }));
      }
    } catch (e) { /* fall through and rebuild */ }
  }

  const last30 = shiftDays(to, -29);

  try {
    const token = await getAccessToken(realmId);

    // one window per month keeps the round trips down
    function monthEnd(iso) {
      const d = new Date(iso + 'T00:00:00Z');
      const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      return e.toISOString().slice(0, 10);
    }

    const invoices = [];
    let cursor = from, windows = 0;

    while (cursor <= to && windows < 40) {
      let end = monthEnd(cursor);
      if (end > to) end = to;

      let start = 1;
      let hitCap = false;
      while (true) {
        const q = await qbQuery(realmId, token,
          `SELECT DocNumber, TxnDate, TotalAmt, Balance FROM Invoice ` +
          `WHERE TxnDate >= '${cursor}' AND TxnDate <= '${end}' ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`);
        const arr = q.Invoice || [];
        arr.forEach(i => invoices.push({
          doc: i.DocNumber || '',
          date: i.TxnDate,
          total: Number(i.TotalAmt || 0),
          balance: Number(i.Balance === undefined ? i.TotalAmt : i.Balance)
        }));
        if (arr.length < 1000) break;
        start += 1000;
        if (start > 9000) { hitCap = true; break; }
      }

      // that month was too busy — walk it a week at a time instead
      if (hitCap) {
        let sub = cursor;
        while (sub <= end) {
          let subEnd = shiftDays(sub, 6);
          if (subEnd > end) subEnd = end;
          let s = 1;
          while (true) {
            const q = await qbQuery(realmId, token,
              `SELECT DocNumber, TxnDate, TotalAmt, Balance FROM Invoice ` +
              `WHERE TxnDate >= '${sub}' AND TxnDate <= '${subEnd}' ` +
              `STARTPOSITION ${s} MAXRESULTS 1000`);
            const arr = q.Invoice || [];
            arr.forEach(i => invoices.push({
              doc: i.DocNumber || '',
              date: i.TxnDate,
              total: Number(i.TotalAmt || 0),
              balance: Number(i.Balance === undefined ? i.TotalAmt : i.Balance)
            }));
            if (arr.length < 1000) break;
            s += 1000;
            if (s > 9000) break;
          }
          sub = shiftDays(subEnd, 1);
        }
      }

      cursor = shiftDays(end, 1);
      windows++;
    }

    // drop anything the month walk picked up twice
    const seen = new Set();
    const clean = [];
    invoices.forEach(i => {
      const k = i.doc + '|' + i.date + '|' + i.total;
      if (seen.has(k)) return;
      seen.add(k);
      clean.push(i);
    });

    let invoiced = 0, outstanding = 0, paidCount = 0, plainCount = 0;
    const byDay = new Map();

    clean.forEach(i => {
      invoiced += i.total;
      outstanding += i.balance;
      if (i.balance <= 0.005 && i.total > 0) paidCount++;
      if (i.doc && i.doc.charAt(0) !== '#') plainCount++;
      if (i.date) byDay.set(i.date, (byDay.get(i.date) || 0) + i.total);
    });

    const daily = [];
    let d = from, guard = 0;
    while (d <= to && guard < 400) {
      daily.push({ date: d, amount: Math.round((byDay.get(d) || 0) * 100) / 100 });
      d = shiftDays(d, 1);
      guard++;
    }

    let received = 0, paymentCount = 0;
    try {
      let s = 1;
      while (true) {
        const q = await qbQuery(realmId, token,
          `SELECT TotalAmt, TxnDate FROM Payment ` +
          `WHERE TxnDate >= '${last30}' AND TxnDate <= '${to}' ` +
          `STARTPOSITION ${s} MAXRESULTS 1000`);
        const arr = q.Payment || [];
        arr.forEach(p => { received += Number(p.TotalAmt || 0); paymentCount++; });
        if (arr.length < 1000) break;
        s += 1000;
        if (s > 9000) break;
      }
    } catch (e) { /* payments are optional here */ }

    let runs = [];
    try { runs = await listRuns(realmId, 8); } catch (e) {}

    let couriers = [];
    try { couriers = await runsSummary(realmId); } catch (e) {}

    const payload = {
      period: { from, to },
      invoiceCount: clean.length,
      invoiced, outstanding, paidCount, plainCount,
      received, paymentCount,
      daily, runs, couriers
    };

    try { await setCache(realmId, cacheKey, payload); } catch (e) {}

    res.json(Object.assign({}, payload, { cached: false, ageSeconds: 0 }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Google Sheets ====================
app.get('/api/sheets/test', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const user = await testConnection();
    res.json({ ok: true, account: user.emailAddress || user.displayName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/list', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const folderId = req.query.folderId;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });

  try {
    const files = await listSheets(folderId);
    res.json({ count: files.length, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/tabs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const sheetId = req.query.sheetId;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.json({ tabs: await listTabs(sheetId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sheets/read', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab } = req.query;
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    const rows = await readTab(sheetId, tab);
    res.json({ rowCount: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sheets/paint', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tabId, colours, width } = req.body;
  if (!sheetId || tabId === undefined || !Array.isArray(colours)) {
    return res.status(400).json({ error: 'sheetId, tabId and colours required' });
  }

  try {
    await paintRows(sheetId, tabId, colours, width);
    res.json({ ok: true, painted: colours.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== CPR / Receive payments ====================

// the root Drive folder, saved once per company
app.get('/api/cpr/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ folderId: await getSetting(realmId, 'cpr:root', '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cpr/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let id = String(req.body.folderId || '').trim();
  // people paste the whole Drive URL — pull the id out of it
  const m = id.match(/[-\w]{25,}/);
  if (m) id = m[0];
  if (!id) return res.status(400).json({ error: 'Folder ID or link required' });

  try {
    await setSetting(realmId, 'cpr:root', id);
    res.json({ ok: true, folderId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// couriers = the folders sitting in the root
app.get('/api/cpr/couriers', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const root = await getSetting(realmId, 'cpr:root', '');
    if (!root) return res.status(400).json({ error: 'Set the Drive folder first' });
    res.json({ folders: await listFolders(root) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// months = the folders inside a courier, sheets = what is inside a month
app.get('/api/cpr/folder', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const [folders, sheets] = await Promise.all([listFolders(id), listSheetsIn(id)]);
    res.json({ folders, sheets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// remember this courier's column choices
app.post('/api/cpr/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, cols } = req.body;
  if (!courier || !cols) return res.status(400).json({ error: 'courier and cols required' });

  try {
    await setSetting(realmId, `cpr:cols:${courier}`, cols);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QB dropdowns
app.get('/api/cpr/qb-options', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const token = await getAccessToken(realmId);
    const [accounts, methods] = await Promise.all([
      listAccounts(realmId, token),
      listPaymentMethods(realmId, token)
    ]);
    const prefs = await getSetting(realmId, 'cpr:prefs', {}) || {};
    res.json({ accounts, methods, prefs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// CPRs that have been settled, remembered per sheet so the green stays
app.get('/api/cpr/settled', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const sheetId = req.query.sheetId;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const done = await getSetting(realmId, `cpr:done:${sheetId}`, {}) || {};
    res.json({ done });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cpr/settled', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, cpr, count, amount } = req.body;
  if (!sheetId || !cpr) return res.status(400).json({ error: 'sheetId and cpr required' });

  try {
    const key = `cpr:done:${sheetId}`;
    const done = await getSetting(realmId, key, {}) || {};
    done[cpr] = {
      count: Number(count) || 0,
      amount: Number(amount) || 0,
      at: new Date().toISOString().slice(0, 10)
    };
    await setSetting(realmId, key, done);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// One sweep of QuickBooks payments tells us where every CPR in the sheet stands.
// Fast, because it looks at payments - not at thousands of invoices.
app.get('/api/cpr/sheet-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;
    const tabs = await listTabs(sheetId, excel);
    const useTab = tab || (tabs[0] && tabs[0].title);

    const data = await loadSheet(sheetId, useTab, excel, saved);
    const hasStatus = data.cols.status >= 0;
    const groups = groupByCpr(data.rows, hasStatus);

    // ask QB only for the window the sheet covers, plus a couple of months either side
    const dates = groups.map(g => g.cprDate).filter(Boolean).sort();
    let from = null, to = null;
    if (dates.length) {
      from = shiftDays(dates[0], -60);
      to = shiftDays(dates[dates.length - 1], 60);
    }

    const token = await getAccessToken(realmId);
    const byRef = await paymentsByCpr(realmId, token, from, to);

    const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
    const bank = courier ? (prefs[courier] || null) : null;

    const out = groups.map(g => {
      const key = g.cprNumber || 'All rows';
      const sheetAmount = Math.round(g.amount * 100) / 100;
      const hit = byRef[g.cprNumber] || null;

      if (!hit) {
        return {
          cpr: key,
          cprDate: g.cprDate,
          delivered: g.delivered,
          sheetAmount,
          state: 'unknown',
          notes: []
        };
      }

      const notes = [];
      const gap = Math.round((hit.amount - sheetAmount) * 100) / 100;
      if (Math.abs(gap) > 100) {
        notes.push({
          kind: 'amount',
          text: `QuickBooks has ${hit.amount.toFixed(2)}, the sheet says ${sheetAmount.toFixed(2)}`
        });
      }

      if (g.cprDate && hit.dates.length && hit.dates.indexOf(g.cprDate) < 0) {
        notes.push({
          kind: 'date',
          text: `Dated ${hit.dates.join(', ')} in QuickBooks, ${g.cprDate} in the sheet`
        });
      }

      if (bank && bank.accountId && hit.accounts.length) {
        const wrong = hit.accounts.filter(a => a.id !== String(bank.accountId));
        if (wrong.length) {
          notes.push({
            kind: 'bank',
            text: `Deposited to ${wrong.map(a => a.name || a.id).join(', ')}, not this courier's usual account`
          });
        }
      }

      return {
        cpr: key,
        cprDate: g.cprDate,
        delivered: g.delivered,
        sheetAmount,
        state: notes.length ? 'off' : 'done',
        qbAmount: hit.amount,
        qbPayments: hit.count,
        qbDates: hit.dates,
        qbAccounts: hit.accounts,
        paymentIds: hit.ids,
        notes
      };
    });

    res.json({
      tab: useTab,
      bank,
      checked: !!dates.length,
      cprs: out
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// where the QB Status column sits - reuse it if the sheet already has one
const QB_STATUS_HEADER = 'QB Status';

// open a sheet: work out the columns, list the CPRs inside it
app.get('/api/cpr/open', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, courier } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    const tabs = await listTabs(sheetId, excel);
    if (!tabs.length) return res.status(400).json({ error: 'That file has no tabs' });

    const tab = req.query.tab || tabs[0].title;
    const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;

    const data = await loadSheet(sheetId, tab, excel, saved);
    const hasStatus = data.cols.status >= 0;
    const groups = groupByCpr(data.rows, hasStatus);

   // only Excel files are at risk - Google Sheets are edited cell by cell.
    // the page asks for this once and remembers it, so skip it on repeat calls
    let inspect = null;
    if (excel && req.query.inspect !== '0') {
      try { inspect = await inspectExcel(sheetId); }
      catch (e) { inspect = { hasMacros: false, risks: [], note: e.message }; }
    }

    res.json({
      tabs, tab,
      header: data.header,
      cols: data.cols,
      hasStatus,
      remembered: !!saved,
      rowCount: data.rows.length,
      headerRow: data.headerRow,
      statusCol: statusColumnOf(data.header),
      statusExists: statusColumnOf(data.header) < data.header.length,
      excel,
      inspect,
      groups: groups.map(g => ({
        cprNumber: g.cprNumber,
        cprDate: g.cprDate,
        rows: g.rows.length,
        delivered: g.delivered,
        amount: Math.round(g.amount * 100) / 100
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// match one CPR against QuickBooks
app.get('/api/cpr/match', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier, cpr } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    const token = await getAccessToken(realmId);
    res.json(await matchCpr(realmId, token, { sheetId, tab, courier, cpr, excel }));
  } catch (e) {
    res.status(e.soft ? 400 : 500).json({ error: e.message });
  }
});
// What actually happened to one CPR: which payments sit behind its invoices,
// and whether the CPR number, date and bank on them are right.
app.get('/api/cpr/trace', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier, cpr } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const saved = courier ? await getSetting(realmId, `cpr:cols:${courier}`, null) : null;
    const data = await loadSheet(sheetId, tab, excel, saved);
    const hasStatus = data.cols.status >= 0;

    let rows = data.rows;
    if (cpr) rows = rows.filter(r => (r.cprNumber || '(no CPR number)') === cpr);
    if (!rows.length) return res.status(400).json({ error: 'No rows for that CPR' });

    const delivered = rows.filter(r => isDelivered(r, hasStatus));
    const token = await getAccessToken(realmId);
    const found = await findInvoices(realmId, token, delivered.map(r => r.invoice));

    // gather every payment id hanging off these invoices
    const ids = [];
    found.forEach(inv => (inv.paymentIds || []).forEach(id => ids.push(id)));
    const payments = await paymentsByIds(realmId, token, [...new Set(ids)]);

    const sheetCpr = rows[0].cprNumber || '';
    const sheetDate = rows[0].cprDate || null;
    const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
    const bank = courier ? (prefs[courier] || null) : null;

    const right = [], wrongRef = [], noRef = [];
    payments.forEach(p => {
      if (!p.ref) noRef.push(p);
      else if (sheetCpr && p.ref !== sheetCpr) wrongRef.push(p);
      else right.push(p);
    });

    // this CPR's own money, and money on the same orders that is not its own
    const own = sheetCpr ? right : noRef;
    const other = payments.filter(p => own.indexOf(p) < 0);

    const notes = [];
    if (noRef.length) {
      notes.push({
        kind: 'noref',
                       text: `${noRef.length} payment${noRef.length === 1 ? '' : 's'} on these invoices ` +
              `carry no CPR number \u2014 ` +
              noRef.map(p => Number(p.amount || 0).toFixed(2) +
                             (p.date ? ' on ' + p.date : '') +
                             (p.accountName || p.accountId
                               ? ' in ' + (p.accountName || p.accountId) : '')).join(', ')
      });
    }
    if (wrongRef.length) {
      const refs = [...new Set(wrongRef.map(p => p.ref))];
      notes.push({
        kind: 'wrongref',
                       text: `Received under ${refs.join(', ')} instead of ${sheetCpr} \u2014 ` +
              wrongRef.map(p => Number(p.amount || 0).toFixed(2) +
                                (p.accountName || p.accountId
                                  ? ' in ' + (p.accountName || p.accountId) : '')).join(', ')
      });
    }

    const allDates = [...new Set(payments.map(p => p.date).filter(Boolean))];
    if (sheetDate && allDates.length && allDates.indexOf(sheetDate) < 0) {
      notes.push({
        kind: 'date',
        text: `Dated ${allDates.join(', ')} in QuickBooks, ${sheetDate} in the sheet`
      });
    }

    if (bank && bank.accountId) {
      const wrongBank = [...new Set(payments
        .filter(p => p.accountId && p.accountId !== String(bank.accountId))
        .map(p => p.accountName || p.accountId))];
      if (wrongBank.length) {
        notes.push({
          kind: 'bank',
          text: `Deposited to ${wrongBank.join(', ')}, not this courier's usual account`
        });
      }
    }

    let paidCount = 0, openCount = 0, missing = 0;
    delivered.forEach(r => {
      const inv = found.get(cprDigits(r.invoice));
      if (!inv) { missing++; return; }
      if (inv.balance <= 0.005) paidCount++; else openCount++;
    });

    res.json({
      cpr: sheetCpr || '(no CPR number)',
      cprDate: sheetDate,
      sheetRows: rows.length,
      delivered: delivered.length,
      sheetAmount: Math.round(delivered.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      paidCount, openCount, missing,
      payments,
      // What this CPR brought in - its own payments only.
      //
      // An order can carry money that has nothing to do with this receipt: half
      // of it taken in advance, into another bank, under another number. Adding
      // that in made the CPR look bigger than the courier ever sent, and the
      // card then reported a difference against the sheet that was not real. So
      // the total is the payments that carry this CPR's number (or, where the
      // sheet has no number, the ones carrying none), and everything else is
      // counted separately and said so in the notes above.
      qbAmount: Math.round(own.reduce((s, p) => s + p.amount, 0) * 100) / 100,
      otherAmount: Math.round(other.reduce((s, p) => s + p.amount, 0) * 100) / 100,
      otherCount: other.length,
      right: right.length,
      wrongRef, noRef,
      bank,
      notes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fix a payment that went in with the wrong CPR number, date or bank
app.post('/api/cpr/fix-payment', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { paymentId, cprNumber, cprDate, accountId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Payment WHERE Id = '${paymentId}'`);
    const pay = (q.Payment || [])[0];
    if (!pay) return res.status(404).json({ error: 'That payment is not in QuickBooks any more' });

    const body = { Id: pay.Id, SyncToken: pay.SyncToken, sparse: true };
    if (cprNumber !== undefined) body.PaymentRefNum = String(cprNumber).slice(0, 21);
    if (cprDate) body.TxnDate = cprDate;
    if (accountId) body.DepositToAccountRef = { value: String(accountId) };

    const r = await fetch(`${API}/v3/company/${realmId}/payment?minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true, id: pay.Id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The bank this courier's money lands in - asked once, then remembered
app.post('/api/cpr/bank', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, accountId, methodId } = req.body;
  if (!courier || !accountId) return res.status(400).json({ error: 'courier and accountId required' });

  try {
    const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
    prefs[courier] = { accountId: String(accountId), methodId: methodId || null };
    await setSetting(realmId, 'cpr:prefs', prefs);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Colour one CPR's rows in the sheet. The page works out which row is which
// and hands the list over, so the colours always agree with what it shows.
app.post('/api/cpr/colour', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, plan } = req.body;
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });
  if (!Array.isArray(plan) || !plan.length) {
    return res.status(400).json({ error: 'Nothing to colour' });
  }

  try {
    const done = await colourCpr(sheetId, tab, plan);
    res.json({ ok: true, painted: done.painted, tally: done.tally });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Money sitting against nothing.
//
// A payment that applies to no invoice at all is not a payment anybody made -
// it is what was left behind when the same money was sent twice, and it shows
// on the customer as an unapplied amount. This finds those, under one CPR, so
// they can be looked at and taken off.
app.get('/api/cpr/stray', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const cpr = String(req.query.cpr || '').trim();
  if (!cpr) return res.status(400).json({ error: 'Which CPR?' });

  try {
    const token = await getAccessToken(realmId);
    const all = await paymentsWithRef(realmId, token, cpr);
    const stray = all.filter(p => p.total > 0 && Math.abs(p.unapplied - p.total) < 0.015);

    res.json({
      cpr,
      payments: all.length,
      amount: Math.round(all.reduce((s, p) => s + p.total, 0) * 100) / 100,
      stray: stray.map(p => ({
        id: p.id, date: p.date, amount: p.total,
        customer: p.customerName, account: p.accountName, createdAt: p.createdAt
      })),
      strayAmount: Math.round(stray.reduce((s, p) => s + p.total, 0) * 100) / 100
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Take those off the books. Each one is read again first and only removed if
// it still applies to nothing - a payment that has found its invoice in the
// meantime is left where it is.
app.post('/api/cpr/stray-remove', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { cpr, ids } = req.body;
  if (!cpr || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Which payments?' });
  }

  try {
    const token = await getAccessToken(realmId);
    const live = await paymentsWithRef(realmId, token, cpr);
    const want = new Set(ids.map(String));

    const removed = [], left = [];
    for (const p of live) {
      if (!want.has(p.id)) continue;
      if (!(p.total > 0 && Math.abs(p.unapplied - p.total) < 0.015)) {
        left.push({ id: p.id, why: 'it applies to an invoice now' });
        continue;
      }
      const r = await deletePayment(realmId, token, p.id, p.syncToken);
      if (r.ok) removed.push({ id: p.id, amount: p.total });
      else left.push({ id: p.id, why: r.msg });
    }

    res.json({ ok: true, removed, left });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// The shipping charged once, on a row that holds more than one order.
//
// Two orders that went in one parcel are written in one cell, and the courier
// charged shipping once - but both invoices carry a shipping line, so
// QuickBooks comes to more than the sheet collected and the row sits in
// "Amount differs" with nobody able to receive it. Merge payments has worked
// this out for years: the difference is some number of shipping charges, and
// taking them off makes the invoices agree with the sheet. This is the same
// arithmetic, on the CPR page, for the rows that are already in front of you.
//
// Nothing is changed here. This only says what would have to come off.
app.post('/api/cpr/ship-plan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to work out' });

  try {
    const token = await getAccessToken(realmId);

    // every order number on every row, read once
    const wanted = [];
    rows.forEach(r => (r.numbers || []).forEach(n => wanted.push(n)));
    const found = await invoicesWithLines(realmId, token, wanted);

    const out = rows.map(r => {
      const parts = (r.numbers || []).map(n => ({ number: n, inv: found.get(cprDigits(n)) || null }));
      const missing = parts.filter(p => !p.inv).map(p => p.number);
      const here = parts.filter(p => p.inv);

      const base = {
        sheetRow: r.sheetRow,
        invoice: r.invoice,
        sheetAmount: money2(r.sheetAmount),
        numbers: r.numbers || []
      };

      if (missing.length) {
        return Object.assign(base, {
          state: 'missing',
          note: missing.join(', ') + ' is not in QuickBooks'
        });
      }

      const open = here.filter(p => p.inv.balance > 0.005);
      if (!open.length) {
        return Object.assign(base, { state: 'paid', note: 'These invoices are already paid' });
      }

      const owed = money2(open.reduce((s, p) => s + p.inv.balance, 0));
      const diff = money2(owed - money2(r.sheetAmount));

      const shipping = [];
      open.forEach(p => (p.inv.shipping || []).forEach(l => shipping.push({
        invoiceId: p.inv.id, doc: p.inv.doc, order: p.number,
        lineId: l.id, item: l.item, amount: money2(l.amount)
      })));

      const plan = planStrip(diff, shipping);
      const common = Object.assign(base, {
        owed, diff,
        invoices: open.map(p => ({ order: p.number, doc: p.inv.doc, qbId: p.inv.id, balance: p.inv.balance })),
        shippingLines: shipping.length
      });

      if (!plan) {
        return Object.assign(common, {
          state: 'stuck',
          note: diff < 0
            ? 'The sheet collected ' + Math.abs(diff) + ' more than the invoices come to'
            : 'No number of shipping charges adds up to ' + diff +
              (shipping.length ? '' : ' - there is no shipping line on these invoices')
        });
      }
      if (!plan.need) {
        return Object.assign(common, {
          state: 'agrees',
          strip: [],
          note: 'These already agree with the sheet'
        });
      }

      return Object.assign(common, {
        state: 'fix',
        strip: plan.strip,
        stripTotal: money2(plan.strip.reduce((s, l) => s + l.amount, 0)),
        note: 'Taking the shipping off ' + plan.need + ' of ' + open.length +
              ' invoices clears ' + diff
      });
    });

    res.json({ rows: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Take those lines off. The invoice is read again inside stripShipping, so a
// line somebody removed in the meantime is reported, not removed twice.
app.post('/api/cpr/ship-apply', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const strip = Array.isArray(req.body.strip) ? req.body.strip : [];
  if (!strip.length) return res.status(400).json({ error: 'Nothing to take off' });

  try {
    const token = await getAccessToken(realmId);

    // one call per invoice, however many of its lines are going
    const byInvoice = new Map();
    strip.forEach(l => {
      const id = String(l.invoiceId || '');
      if (!id || !l.lineId) return;
      if (!byInvoice.has(id)) byInvoice.set(id, { doc: l.doc || '', lineIds: [] });
      byInvoice.get(id).lineIds.push(String(l.lineId));
    });

    const done = [], failed = [];
    for (const [id, x] of byInvoice) {
      try {
        const r = await stripShipping(realmId, token, id, x.lineIds);
        done.push({ invoiceId: id, doc: x.doc, total: r && r.total !== undefined ? r.total : null });
      } catch (e) {
        failed.push({ invoiceId: id, doc: x.doc, msg: e.message });
      }
    }

    res.json({ ok: true, done, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// A replaced parcel comes back under a second CPR, so the same order has to be
// settled twice. QuickBooks will not take the number twice, so a copy is made
// under "-D" - and the sheet row is renamed to match, which is what stops the
// same copy being made again on the next look.
app.post('/api/cpr/duplicate', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { invoiceId, sheetId, tab, sheetRow, invoiceCol, oldNumber } = req.body;
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
  if (!sheetId || !tab || !sheetRow) {
    return res.status(400).json({ error: 'The sheet row is needed so it can be renamed' });
  }

  try {
    const token = await getAccessToken(realmId);
    const made = await copyInvoice(realmId, token, invoiceId, '-D');

    // rename the number in the sheet, so this row now points at the copy
    let renamed = false;
    try {
          // the sheet is read here so the invoice column is found the same way the
      // rest of the page finds it - no need for the browser to say where it is
          // whichever column holds the number we are replacing - found by looking
      // for it in the row itself, so nothing has to be passed in
      const want = String(oldNumber).trim();
      const grid = await readTab(sheetId, tab, false);
      const rowCells = grid[Number(sheetRow) - 1] || [];

      let col = -1;
      for (let i = 0; i < rowCells.length; i++) {
        const cellText = String(rowCells[i] == null ? '' : rowCells[i]).trim();
        if (cellText === want) { col = i; break; }
        if (cellText.split(/[\s,;]+/).some(p => p.trim() === want)) { col = i; break; }
      }
      if (col < 0) {
        throw new Error(`"${want}" is not anywhere in row ${sheetRow} of that tab`);
      }

      const cell = await readCell(sheetId, tab, Number(sheetRow), col);

      // a plain cell is replaced whole; a merged one has just its own number
      // swapped, so the other orders in the same parcel stay as they are
      const before = String(cell || '').trim();
    
      let next;
      if (before === want) {
        next = made.doc;
      } else {
        const parts = before.split(/([\s,;]+)/);
        let hit = false;
        next = parts.map(p => {
          if (!hit && p.trim() === want) { hit = true; return made.doc; }
          return p;
        }).join('');
        if (!hit) throw new Error(`"${want}" is not in row ${sheetRow} (it reads "${before}")`);
      }

      await writeCell(sheetId, tab, Number(sheetRow), col, next);
      renamed = true;
    } catch (e) {
      // the copy exists either way - the page is told the rename failed
      return res.json({ ok: true, invoice: made, renamed: false, renameError: e.message });
    }

    res.json({ ok: true, invoice: made, renamed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// post the payments in the background, then stamp the sheet
app.post('/api/cpr/receive', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startPayJob(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/cpr/receive-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = paySnapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/cpr/receive-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopPayJob(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/cpr/receive-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endPayJob(req.desk) });
});


app.post('/api/cpr/receive-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumePayJob(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/cpr/receive-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearPayJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The payment run is still going' });
  res.json({ ok: true });
});
// ==================== Check list ====================
// The CPR read back out of QuickBooks: which orders its payments actually paid
// for, which of them the CPR never carried, and what was taken over the amount
// owed. The reads start a job so they can be stopped from any computer; the
// changes start a second one, so a run of them can be stopped and carried on.

app.post('/api/check/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startCheck(req.desk, Object.assign({ kind: 'cpr' }, req.body));
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// the same read for a handful of order numbers pasted by hand
app.post('/api/check/invoices', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const numbers = String(req.body.text || '')
    .split(/[\s,;/|]+/)
    .map(s => s.trim())
    .filter(s => s.replace(/[^0-9]/g, '').length >= 4);

  if (!numbers.length) return res.status(400).json({ error: 'No order numbers in that' });
  if (numbers.length > 500) return res.status(400).json({ error: 'That is more than 500 numbers' });

  try {
    const id = startCheck(req.desk, { kind: 'invoices', numbers });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/check/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = checkSnapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/check/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopCheck(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/check/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endCheck(req.desk) });
});


app.post('/api/check/resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeCheck(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/check/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearCheck(req.desk);
  if (!ok) return res.status(409).json({ error: 'The check is still going' });
  res.json({ ok: true });
});

// the changes themselves - taking an order off a CPR, correcting what was
// taken, moving a payment onto the right CPR, or deleting the CPR outright
app.post('/api/check/fix', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startFix(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/check/fix-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = fixSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/check/fix-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopFix(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/check/fix-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endFix(req.desk) });
});


app.post('/api/check/fix-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeFix(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/check/fix-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearFix(req.desk);
  if (!ok) return res.status(409).json({ error: 'The fix is still going' });
  res.json({ ok: true });
});

// ---- the check list's own walk of the courier sheets ----
//
// The Order numbers tab asks QuickBooks what paid for a list of orders. This
// asks the sheets the same question from the other side: which CPR, in which
// month, was each of these orders written on - so an order that QuickBooks has
// never been told about can still be found, and then received under the very
// CPR it was written on.
//
// It runs in the person's own second lane of the search engine, so starting one
// here does not take the Find orders page's search away from them.
function sheetLane(req) { return req.desk + '|checklist'; }

app.post('/api/check/find-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const cols = (await getSetting(realmId, 'find:cols', {})) || {};
    const id = startFindJob(sheetLane(req), {
      numbers: req.body.numbers,
      folderIds: req.body.folderIds || [],
      cols,
      skipCpr: false
    });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/check/find-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = findSnapshot(sheetLane(req), req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/check/find-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopFindJob(sheetLane(req)) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/check/find-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endFindJob(sheetLane(req)) });
});


app.post('/api/check/find-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeFindJob(sheetLane(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/check/find-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearFindJob(sheetLane(req));
  if (!ok) return res.status(409).json({ error: 'The search is still running' });
  res.json({ ok: true });
});

// What one CPR's found orders look like in QuickBooks, before a penny moves.
//
// The page hands over the orders it found under one CPR, with what the sheet
// says each was worth. Each is looked up and sorted the same way the Receive
// payments page sorts a whole CPR: ready to receive, already paid, the sheet
// and QuickBooks disagreeing by more than ten, and not in QuickBooks at all.
// Only the ready ones are handed on to be received.
app.post('/api/check/find-ready', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to look up' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const token = await getAccessToken(realmId);
    const found = await findInvoices(realmId, token, rows.map(r => r.invoice));

    const matched = [], alreadyPaid = [], amountOff = [], notInQb = [];

    rows.forEach(r => {
      const asIs = String(r.invoice || '').trim().replace(/^#/, '');
      const inv = found.get(asIs) || found.get(cprDigits(r.invoice));
      const sheetAmount = Number(r.amount || 0);

      if (!inv) { notInQb.push({ invoice: r.invoice, sheetAmount }); return; }

      const entry = {
        invoice: r.invoice,
        qbDoc: inv.doc,
        qbId: inv.id,
        qbTotal: inv.total,
        qbBalance: Math.round(inv.balance * 100) / 100,
        customerId: inv.customerId,
        customerName: inv.customerName,
        date: inv.date,
        sheetAmount
      };

      if (inv.balance <= 0.005) { alreadyPaid.push(entry); return; }
      // the same ten rupees of slack the CPR page allows
      if (sheetAmount > 0 && Math.abs(sheetAmount - inv.balance) > 10) {
        amountOff.push(entry);
        return;
      }
      matched.push(entry);
    });

    const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
    const bank = req.body.courier ? (prefs[req.body.courier] || null) : null;

    res.json({
      cpr: req.body.cpr || '',
      cprDate: req.body.cprDate || null,
      courier: req.body.courier || '',
      bank,
      matched, alreadyPaid, amountOff, notInQb,
      totals: {
        asked: rows.length,
        matched: matched.length,
        alreadyPaid: alreadyPaid.length,
        amountOff: amountOff.length,
        notInQb: notInQb.length,
        amount: Math.round(matched.reduce((t, m) => t + m.qbBalance, 0) * 100) / 100
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Find orders in the courier sheets ====================
// Paste order numbers, and every CPR sheet is walked looking for them. What is
// still missing afterwards is looked for in the return sheet.

// every company folder and the month folders inside it
app.get('/api/find/tree', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ companies: await listTree(realmId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// the sheets sitting in the folders the page picked
app.post('/api/find/sheets', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.json({ sheets: await sheetsIn(realmId, req.body.folderIds) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// the column names of one sheet, so the page can ask which is which
app.get('/api/find/header', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await peekHeader(sheetId, req.query.excel === '1'));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// the column choices, remembered per company
app.get('/api/find/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ cols: await getSetting(realmId, 'find:cols', {}) || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/find/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { company, cols } = req.body;
  if (!company || !cols) return res.status(400).json({ error: 'company and cols required' });

  try {
    const all = (await getSetting(realmId, 'find:cols', {})) || {};
    all[company] = cols;
    await setSetting(realmId, 'find:cols', all);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// the return workbook and its tabs, for the second tab of the page
app.get('/api/find/return-sheets', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const id = await getSetting(realmId, 'void:root', '');
    if (!id) return res.status(400).json({ error: 'Set the return sheet folder in Void invoices first' });

    let folders = [], sheets = [];
    try {
      [folders, sheets] = await Promise.all([listFolders(id), listSheetsIn(id)]);
    } catch (e) { /* not a folder, then */ }

    if (!sheets.length && !folders.length) {
      const info = await fileInfo(id);
      if (info && info.mimeType !== 'application/vnd.google-apps.folder') {
        sheets = [{
          id: info.id,
          name: info.name,
          excel: info.mimeType !== 'application/vnd.google-apps.spreadsheet'
        }];
      }
    }

    res.json({ folders, sheets });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/find/start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startFindJob(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/find/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = findSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/find/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopFindJob(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/find/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endFindJob(req.desk) });
});


app.post('/api/find/resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeFindJob(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/find/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearFindJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The search is still running' });
  res.json({ ok: true });
});

// The answer, in whatever slice was asked for. Six of them: overview, the
// companies, the CPRs, every order, the misses, and all of it in one file.
app.get('/api/find/file', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const snap = findSnapshot(req.desk, 0);
  if (!snap || !snap.result) return res.status(404).json({ error: 'Nothing to download yet' });

  const r = snap.result;
  const want = String(req.query.part || 'all').toLowerCase();
  const r2 = v => Math.round(Number(v || 0) * 100) / 100;

  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const line = arr => arr.map(cell).join(',');

  /* ---------- the pieces ---------- */

  function overview() {
    const out = [];
    out.push(line(['ORDER SEARCH']));
    out.push(line(['Run at', new Date(snap.startedAt).toLocaleString()]));
    out.push('');
    out.push(line(['Asked about', r.asked]));
    out.push(line(['Found', r.found]));
    out.push(line(['Not found', r.missing.length]));

    let delivered = 0, returned = 0, amount = 0;
    r.couriers.forEach(c => {
      delivered += c.delivered; returned += c.returned; amount += c.amount;
    });
    out.push(line(['Delivered', delivered]));
    out.push(line(['Returned', returned]));
    out.push(line(['Amount', r2(amount)]));
    out.push(line(['Companies', r.couriers.length]));
    return out;
  }

  function companies() {
    const out = [];
    out.push(line(['Company', 'Orders', 'Delivered', 'Returned', 'In transit',
                   'Cancelled', 'Other', 'Amount']));

    const t = { total:0, delivered:0, returned:0, transit:0, cancelled:0, other:0, amount:0 };
    r.couriers.forEach(c => {
      out.push(line([c.courier, c.total, c.delivered, c.returned, c.transit,
                     c.cancelled, c.other, r2(c.amount)]));
      t.total += c.total; t.delivered += c.delivered; t.returned += c.returned;
      t.transit += c.transit; t.cancelled += c.cancelled; t.other += c.other;
      t.amount += c.amount;
    });
    out.push(line(['All companies', t.total, t.delivered, t.returned, t.transit,
                   t.cancelled, t.other, r2(t.amount)]));
    return out;
  }

  function cprs() {
    const byCpr = new Map();
    r.rows.forEach(x => {
      const key = x.courier + '|' + (x.cprNumber || '(no CPR number)');
      if (!byCpr.has(key)) {
        byCpr.set(key, {
          courier: x.courier,
          cpr: x.cprNumber || '(no CPR number)',
          date: x.cprDate || '',
          total: 0, delivered: 0, returned: 0, other: 0, amount: 0
        });
      }
      const g = byCpr.get(key);
      g.total++;
      g.amount += x.amount || 0;
      if (!g.date && x.cprDate) g.date = x.cprDate;
      if (x.bucket === 'delivered') g.delivered++;
      else if (x.bucket === 'returned') g.returned++;
      else g.other++;
    });

    const out = [];
    out.push(line(['Company', 'CPR number', 'CPR date', 'Orders',
                   'Delivered', 'Returned', 'Other', 'Amount']));

    [...byCpr.values()]
      .sort((a, b) => String(a.courier).localeCompare(String(b.courier)) ||
                      String(b.date || '').localeCompare(String(a.date || '')))
      .forEach(g => {
        out.push(line([g.courier, g.cpr, g.date, g.total,
                       g.delivered, g.returned, g.other, r2(g.amount)]));
      });
    return out;
  }

  function orders() {
    const out = [];
    out.push(line(['Company', 'Order number', 'Result', 'Sheet says', 'Amount',
                   'CPR number', 'CPR date', 'Month', 'Sheet', 'Tab', 'Row']));

    r.rows
      .slice()
      .sort((a, b) => String(a.courier).localeCompare(String(b.courier)) ||
                      String(a.cprNumber || '').localeCompare(String(b.cprNumber || '')) ||
                      String(a.invoice).localeCompare(String(b.invoice)))
      .forEach(x => {
        out.push(line([x.courier, x.invoice, x.bucket, x.status, r2(x.amount),
                       x.cprNumber || '', x.cprDate || '', x.month || '',
                       x.sheet, x.tab, x.sheetRow || '']));
      });
    return out;
  }

  function misses() {
    const out = [line(['Order number'])];
    r.missing.forEach(n => out.push(line([n])));
    return out;
  }

  /* ---------- whichever was asked for ---------- */

  const PARTS = {
    overview:  { name: 'overview',       build: overview },
    companies: { name: 'by-company',     build: companies },
    cprs:      { name: 'by-cpr',         build: cprs },
    orders:    { name: 'every-order',    build: orders },
    missing:   { name: 'not-found',      build: misses }
  };

  let rows, name;

  if (want === 'all') {
    name = 'order-search';
    rows = [];
    rows.push(...overview());
    rows.push('', line(['BY COMPANY']));
    rows.push(...companies());
    rows.push('', line(['BY CPR']));
    rows.push(...cprs());
    rows.push('', line(['EVERY ORDER']));
    rows.push(...orders());
    rows.push('', line(['NOT FOUND']));
    rows.push(...misses());
  } else if (PARTS[want]) {
    name = 'order-search-' + PARTS[want].name;
    rows = PARTS[want].build();
  } else {
    return res.status(400).json({ error: 'No such part' });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send('\uFEFF' + rows.join('\r\n') + '\r\n');
});

// ==================== Merged parcels ====================
// A month of Shopify exports, read together to find the orders that went to the
// same person. The courier ships those as one parcel, so their numbers land in
// one cell of the CPR sheet - and this is where that expectation is checked.
//
// The uploaded files stay in memory for the company, so changing a column or
// the matching strength does not mean uploading again.
const mergeStore = new Map();          // desk -> { files, orders, groups, at }
const KEEP_BYTES = 40 * 1024 * 1024;   // beyond this the uploaded bytes are dropped

function mergeState(desk) {
  const st = mergeStore.get(desk);
  if (!st) throw new Error('Upload the Shopify files first');
  return st;
}

function mergeFilesReport(st) {
  const per = new Map();
  st.orders.forEach(o => per.set(o.file, (per.get(o.file) || 0) + 1));

  return st.files.map(f => ({
    name: f.name,
    header: f.header,
    cols: f.cols,
    rows: f.rowCount,
    orders: per.get(f.name) || 0
  }));
}

// multer throws before the handler is reached - a file over the limit, too many
// files - and express would answer that with a page of HTML the browser cannot
// read. This says it in the same shape as every other answer here.
function takeMergeFiles(req, res, next) {
  bulkUpload.array('files', 15)(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'That file is over 80 MB. Export the month in smaller pieces and drop them together.'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'Fifteen files at a time is the most it will take.'
        : err.message;
    res.status(400).json({ error: msg });
  });
}

app.post('/api/merge/upload', takeMergeFiles, async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = req.files || [];
  if (!list.length) return res.status(400).json({ error: 'No files uploaded' });

  try {
    const files = list.map(f => openMergeFile(f.originalname, f.buffer));
    const orders = buildOrders(files);

    // The bytes are kept so a mis-guessed column can be put right without
    // uploading again - but only while they are small enough to be worth the
    // room. A month of forty thousand orders is not, and asking for it a
    // second time is better than falling over.
    const bytes = files.reduce((n, f) => n + (f.buffer ? f.buffer.length : 0), 0);
    if (bytes > KEEP_BYTES) files.forEach(f => { f.buffer = null; });
    if (!orders.length) {
      return res.status(400).json({
        error: 'No orders found. Check that the files have an order number column.'
      });
    }
    mergeStore.set(req.desk, { files, orders, groups: [], at: Date.now() });
    res.json({ files: mergeFilesReport(mergeStore.get(req.desk)), orders: orders.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// what is still in memory, so a page reload does not lose the upload
app.get('/api/merge/state', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  res.setHeader('Cache-Control', 'no-store');
  const st = mergeStore.get(req.desk);
  if (!st) return res.json({ loaded: false });
  res.json({
    loaded: true,
    files: mergeFilesReport(st),
    orders: st.orders.length,
    groups: st.groups.length,
    minFields: st.minFields || 0
  });
});

// the reader guessed a column wrong - put it right and fold the rows again
app.post('/api/merge/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { file, cols } = req.body || {};
  try {
    const st = mergeState(req.desk);
    const f = st.files.find(x => x.name === file);
    if (!f) return res.status(400).json({ error: 'No such file' });

    Object.keys(f.cols).forEach(k => {
      if (cols && cols[k] !== undefined) f.cols[k] = Number(cols[k]);
    });
    st.orders = buildOrders(st.files);
    st.groups = [];
    res.json({ files: mergeFilesReport(st), orders: st.orders.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/merge/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = mergeState(req.desk);
    const minFields = Number(req.body && req.body.minFields) || 4;
    // one parcel is one day's ordering - the same customer next week is a
    // second parcel, delivered and collected on its own
    const time = {
      mode: (req.body && req.body.timeMode) || 'day',
      hours: req.body && req.body.hours
    };
    st.groups = groupOrders(st.orders, minFields, time);
    st.minFields = minFields;
    st.time = time;

    const parcels = st.groups.reduce((n, g) => n + g.orders.length, 0);
    // thirteen thousand groups is a fine thing to have and a hopeless thing to
    // send - the page shows the first few hundred and the file holds them all
    const SHOW = 300;

    res.json({
      minFields,
      timeMode: time.mode,
      orders: st.orders.length,
      totals: {
        groups: st.groups.length,
        orders: parcels,
        byTier: [4, 3, 2].map(t => ({
          fields: t,
          groups: st.groups.filter(g => g.agreeCount === t).length
        }))
      },
      shown: Math.min(SHOW, st.groups.length),
      groups: st.groups.slice(0, SHOW)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// the groups as a file, one line per order
app.get('/api/merge/csv', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let st;
  try { st = mergeState(req.desk); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const cell = v => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const line = a => a.map(cell).join(',');

  const rows = [line(['Group', 'Fields agreed', 'Matched on', 'Orders in group',
                      'Order', 'Customer', 'Phone', 'Email', 'Address', 'Total', 'Date', 'File'])];
  st.groups.forEach(g => {
    g.orders.forEach(o => {
      rows.push(line([g.id, g.agreeCount, g.agree.join(' + '), g.orders.length,
                      o.order, o.customer, o.phone, o.email, o.address, o.total, o.date, o.file]));
    });
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="merged-parcels.csv"');
  res.send('﻿' + rows.join('\r\n') + '\r\n');
});

// The CPR rows are pasted in as they sit in the sheet. Each one is looked up
// among the Shopify orders, and where its customer ordered more than once that
// day the whole group comes with it - one parcel, one COD. What QuickBooks
// holds against that group is then set beside what the courier collected, and
// the difference explained if it can be.
app.post('/api/merge/paste', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = mergeState(req.desk);
    if (!st.groups.length) throw new Error('Find the groups first');

    const parsed = parsePasted(req.body && req.body.text);
    const placed = placeGroups(st.groups, parsed.rows);

    // a pasted row whose order is in none of the uploaded files cannot be
    // spoken for either way, so it is counted and named rather than passed over
    const known = new Set(st.orders.map(o => o.digits));
    const strangers = parsed.rows.filter(r =>
      !(r.invoices || []).some(n => known.has(cprDigits(n))));

    // every order of every group that turned up, asked for in one go
    const wanted = [];
    placed.matched.forEach(m => m.orders.forEach(o => wanted.push(o.order)));

    let invoices = new Map();
    if (wanted.length) {
      const token = await getAccessToken(realmId);
      invoices = await invoicesWithLines(realmId, token, wanted);
    }

    const plans = placed.matched.map(m => {
      const plan = planGroup(m, invoices);
      plan.remark = remarkFor(plan);
      plan.manual = plan.state !== 'agrees' && plan.state !== 'fix';
      return plan;
    });

    // pasted CPR by pasted CPR, the way the sheet is worked through
    const byCpr = new Map();
    const bucket = name => {
      const key = name || '(no CPR number)';
      if (!byCpr.has(key)) byCpr.set(key, { cprNumber: key, plans: [], twice: [], rows: 0 });
      return byCpr.get(key);
    };
    parsed.cprs.forEach(c => { bucket(c.cprNumber).rows = c.rows; });
    plans.forEach(p => bucket(p.cprNumber).plans.push(p));
    placed.twice.forEach(t => bucket((t.rows[0] || {}).cprNumber).twice.push(t));

    const count = state => plans.filter(p => p.state === state).length;

    st.plan = { at: Date.now(), plans, rows: parsed.rows };

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      pastedRows: parsed.rows.length,
      cprs: parsed.cprs,
      canWrite: true,
      strangers: {
        count: strangers.length,
        rows: strangers.slice(0, 40).map(r => ({ sheetRow: r.sheetRow, invoice: r.invoice }))
      },
      totals: {
        groups: plans.length,
        agrees: count('agrees'),
        fix: count('fix'),
        manual: plans.filter(p => p.manual).length,
        twice: placed.twice.length,
        shipping: plans.reduce((n, p) => n + ((p.strip || []).length), 0)
      },
      byCpr: Array.from(byCpr.values())
        .filter(c => c.plans.length || c.twice.length)
        .sort((a, b) => a.cprNumber.localeCompare(b.cprNumber))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The two columns to paste back: the order cell with the whole group written
// into it, and the remark saying why. They come out in the order the rows were
// pasted in, one line each, so the block drops straight back over the column
// it came from.
function mergeColumns(st) {
  if (!st.plan || !st.plan.rows) throw new Error('Match the pasted rows first');

  const byRow = new Map();
  st.plan.plans.forEach(p => byRow.set(p.sheetRow, p));

  return st.plan.rows.map(r => {
    const p = byRow.get(r.sheetRow);
    // only a group that adds up is worth writing - the rest stay as they are
    const merge = p && (p.state === 'fix' || p.state === 'agrees') && p.orders.length > 1;
    return {
      sheetRow: r.sheetRow,
      cell: merge ? p.orders.join(', ') : r.invoice,
      was: r.invoice,
      changed: !!merge,
      remark: p ? (p.remark || p.note || '') : ''
    };
  });
}

app.get('/api/merge/columns-back', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const lines = mergeColumns(mergeState(req.desk));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      changed: lines.filter(l => l.changed).length,
      rows: lines.length,
      orders: lines.map(l => l.cell).join('\n'),
      remarks: lines.map(l => l.remark).join('\n'),
      lines
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Taking the shipping charges off in QuickBooks. One invoice at a time, in the
// background, because a hundred of them is a hundred round trips - and the
// plan it works from is the one already on screen.
async function runStrip(realmId, job) {
  const token = await getAccessToken(realmId);

  for (const p of job.plans) {
    if (job.stop) break;

    // every line to come off this group, gathered per invoice
    const perInvoice = new Map();
    (p.strip || []).forEach(l => {
      if (!perInvoice.has(l.invoiceId)) perInvoice.set(l.invoiceId, { doc: l.doc, lines: [] });
      perInvoice.get(l.invoiceId).lines.push(l.lineId);
    });

    for (const [invoiceId, what] of perInvoice) {
      if (job.stop) break;
      try {
        const out = await stripShipping(realmId, token, invoiceId, what.lines);
        job.done++;
        job.log.push({ ok: true, doc: out.doc || what.doc, total: out.total });
      } catch (e) {
        job.done++;
        job.failed++;
        job.log.push({ ok: false, doc: what.doc, msg: e.message });
      }
    }

    if (!job.failed) p.stripped = true;
  }

  job.running = false;
  job.finished = Date.now();
}

app.post('/api/merge/strip', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = mergeState(req.desk);
    if (!st.plan || !st.plan.plans.length) throw new Error('Match the pasted rows first');
    if (st.strip && st.strip.running) throw new Error('That is already running');

    const only = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : null;
    const plans = st.plan.plans.filter(p =>
      p.state === 'fix' && !p.stripped && (!only || only.includes(p.id)));

    if (!plans.length) throw new Error('Nothing is waiting to have shipping taken off');

    const job = {
      running: true, stop: false, done: 0, failed: 0,
      total: plans.reduce((n, p) => n + new Set((p.strip || [])
        .map(l => l.invoiceId)).size, 0),
      groups: plans.length,
      log: [], started: Date.now(), plans
    };
    st.strip = job;

    runStrip(realmId, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, groups: job.groups, invoices: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/merge/strip-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = mergeStore.get(req.desk);
  const job = st && st.strip;
  res.setHeader('Cache-Control', 'no-store');
  if (!job) return res.json({ running: false, done: 0, total: 0, log: [] });

  res.json({
    running: job.running,
    done: job.done,
    failed: job.failed,
    total: job.total,
    groups: job.groups,
    error: job.error || null,
    log: job.log.slice(-60)
  });
});

app.post('/api/merge/strip-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = mergeStore.get(req.desk);
  if (st && st.strip) st.strip.stop = true;
  res.json({ ok: true });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/merge/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = mergeStore.get(req.desk);
  if (st) {
    st.ended = true;
    if (st.strip) st.strip.stop = true;
  }
  mergeStore.delete(req.desk);
  res.json({ ok: true, had: !!st });
});


// Only the log of a finished run goes; the matched rows stay.
app.post('/api/merge/strip-clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = mergeStore.get(req.desk);
  if (st && st.strip && st.strip.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) st.strip = null;
  res.json({ ok: true });
});

app.post('/api/merge/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  mergeStore.delete(req.desk);
  res.json({ ok: true });
});

/* ==================== shipping off pasted invoices ==================== */

// Merge payments above works out for itself how many shipping lines have to go,
// by reading a CPR. This is the same edit without the arithmetic: the numbers
// are pasted, the shipping line on each is shown, and the ticked ones are taken
// off. It keeps its own list so it does not disturb a CPR match in progress.

const shipStore = new Map();           // desk -> { rows, job, at }

app.post('/api/shipfix/plan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const numbers = parseShipNumbers((req.body && req.body.text) || '');
    if (!numbers.length) throw new Error('Paste the invoice numbers first');
    if (numbers.length > 600) throw new Error('That is more than 600 numbers - do it in blocks');

    const old = shipStore.get(req.desk);
    if (old && old.job && old.job.running) throw new Error('A change is still running');

    const token = await getAccessToken(realmId);
    const rows = await buildShipPlan(realmId, token, numbers);

    shipStore.set(req.desk, { rows, job: null, at: Date.now() });
    res.json({ ok: true, pasted: numbers.length, rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One invoice per request. The batch API times out under load, and a slow run
// that finishes beats a fast one that does not.
async function runShipfix(realmId, st, job) {
  const token = await getAccessToken(realmId);

  for (const row of job.rows) {
    if (job.stop) break;
    if (row.state !== 'ready') continue;

    try {
      const out = await stripShipping(realmId, token, row.qbId, row.hits.map(l => l.id));
      row.state = 'stripped';
      row.note = row.hits.length + (row.hits.length === 1 ? ' line' : ' lines') +
        ' off, now ' + out.total.toFixed(2);
      row.total = out.total;
      row.balance = out.balance;
      job.done++;
      job.taken = Math.round((job.taken + row.hitTotal) * 100) / 100;
      job.log.push({
        ok: true,
        doc: out.doc || row.doc,
        lines: row.hits.length,
        amount: row.hitTotal
      });
    } catch (e) {
      row.state = 'failed';
      row.note = e.message;
      job.done++;
      job.failed++;
      job.log.push({ ok: false, doc: row.doc, msg: e.message });
    }
  }

  job.running = false;
  job.finished = Date.now();
}

app.post('/api/shipfix/run', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = shipStore.get(req.desk);
    if (!st) throw new Error('Find the invoices first');
    if (st.job && st.job.running) throw new Error('That is already running');

    const only = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    // what a finished run left refused is taken again by carrying on
    st.rows.forEach(r => { if (r.state === 'failed') { r.state = 'ready'; r.note = ''; } });
    const rows = st.rows.filter(r =>
      r.state === 'ready' && r.qbId && (!only || only.includes(String(r.qbId))));
    if (!rows.length) throw new Error('None of these are waiting to have shipping taken off');

    const job = {
      running: true, stop: false, done: 0, failed: 0, taken: 0,
      total: rows.length, log: [], started: Date.now(), rows
    };
    st.job = job;

    runShipfix(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, invoices: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/shipfix/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = shipStore.get(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  if (!st) return res.json({ has: false });

  const job = st.job;
  res.json({
    has: true,
    rows: st.rows,
    job: job ? {
      running: job.running, done: job.done, failed: job.failed,
      taken: job.taken, total: job.total,
      error: job.error || null, log: job.log.slice(-80)
    } : null
  });
});

app.post('/api/shipfix/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = shipStore.get(req.desk);
  if (st && st.job && st.job.running) st.job.stop = true;
  res.json({ ok: true });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/shipfix/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = shipStore.get(req.desk);
  if (st) {
    st.ended = true;
    if (st.job) st.job.stop = true;
  }
  shipStore.delete(req.desk);
  res.json({ ok: true, had: !!st });
});


// Only the log of a finished run goes; the invoices found stay.
app.post('/api/shipfix/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = shipStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) st.job = null;
  res.json({ ok: true });
});

app.post('/api/shipfix/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = shipStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'A change is still running' });
  shipStore.delete(req.desk);
  res.json({ ok: true });
});

// ==================== Change product ====================
// Put a different product on invoices that were written against the wrong one,
// leaving the quantity, the price and the description where they are. The plan
// is read first and shown; nothing goes back to QuickBooks until it is asked
// for, and then one invoice at a time.

const swapStore = new Map();           // desk -> { from, to, rows, job, at }

function swapProduct(list, id) {
  const p = (list || []).find(it => String(it.id) === String(id));
  if (!p) throw new Error('That product is not in this QuickBooks company');
  return { id: String(p.id), name: p.name, sku: p.sku || '' };
}

async function loadProducts(realmId, token) {
  const products = [];
  let start = 1;
  while (true) {
    const q = await qbQuery(realmId, token,
      `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
    const arr = q.Item || [];
    arr.forEach(it => products.push({
      id: String(it.Id), name: it.Name, sku: it.Sku || '',
      type: it.Type || '', active: it.Active !== false
    }));
    if (arr.length < 1000) break;
    start += 1000;
    if (start > 9000) break;
  }
  return products;
}

app.get('/api/swap/products', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const products = await loadProducts(realmId, token);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ count: products.length, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const swapChecks = new Map();      // desk -> { running, stop }

app.get('/api/swap/plan-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const c = swapChecks.get(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ running: !!(c && c.running), stopping: !!(c && c.stop) });
});

app.post('/api/swap/plan-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const c = swapChecks.get(req.desk);
  if (c && c.running) c.stop = true;
  res.json({ ok: true });
});

app.post('/api/swap/plan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const { from, to, numbers } = req.body || {};
    if (!from || !to) throw new Error('Pick the product to change and the one to change it to');
    if (String(from) === String(to)) throw new Error('Those are the same product');

    const list = parseSwapNumbers(numbers);
    if (!list.length) throw new Error('Paste the invoice numbers first');
    if (list.length > 2000) throw new Error('That is more than 2,000 invoices in one go');

    const token = await getAccessToken(realmId);
    const products = await loadProducts(realmId, token);
    const fromP = swapProduct(products, from);
    const toP = swapProduct(products, to);

    // the check is held on the server while it reads, so any computer on the
    // same company can see it running and stop it
    const check = { running: true, stop: false, started: Date.now() };
    swapChecks.set(req.desk, check);
    let rows;
    try {
      rows = await buildSwapPlan(realmId, token, list, fromP.id, () => check.stop);
    } finally {
      check.running = false;
    }

    const old = swapStore.get(req.desk);
    if (old && old.job && old.job.running) throw new Error('A change is still running');

    swapStore.set(req.desk, { from: fromP, to: toP, rows, job: null, at: Date.now() });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      from: fromP, to: toP,
      pasted: list.length,
      ready: rows.filter(r => r.state === 'ready').length,
      lines: rows.reduce((n, r) => n + r.hits.length, 0),
      nomatch: rows.filter(r => r.state === 'nomatch').length,
      missing: rows.filter(r => r.state === 'missing').length,
      rows
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One invoice per request. The batch API times out under inventory locks, and
// a slow run that finishes beats a fast one that does not.
async function runSwap(realmId, st, job) {
  const token = await getAccessToken(realmId);

  for (const row of job.rows) {
    if (job.stop) break;
    try {
      const out = await swapOnInvoice(realmId, token, row.qbId, st.from.id, st.to,
        { rewriteDescription: job.rewriteDescription });
      row.state = 'changed';
      row.note = out.lines + (out.lines === 1 ? ' line' : ' lines') + ' now on ' + st.to.name;
      job.done++;
      job.changedLines += out.lines;
      job.log.push({
        ok: true, doc: out.doc, lines: out.lines,
        // the total is the proof that nothing but the name moved
        moved: Math.round((out.total - out.before) * 100) / 100
      });
    } catch (e) {
      row.state = 'failed';
      row.note = e.message;
      job.done++;
      job.failed++;
      job.log.push({ ok: false, doc: row.doc, msg: e.message });
    }
  }

  job.running = false;
  job.finished = Date.now();
}

app.post('/api/swap/run', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = swapStore.get(req.desk);
    if (!st) throw new Error('Check the invoices first');
    if (st.job && st.job.running) throw new Error('That is already running');

    const only = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    const rows = st.rows.filter(r =>
      r.state === 'ready' && r.qbId && (!only || only.includes(String(r.qbId))));
    if (!rows.length) throw new Error('None of these invoices are waiting to be changed');

    const job = {
      running: true, stop: false, done: 0, failed: 0, changedLines: 0,
      total: rows.length, log: [], started: Date.now(), rows,
      rewriteDescription: !!(req.body && req.body.rewriteDescription)
    };
    st.job = job;

    runSwap(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, invoices: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/swap/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = swapStore.get(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  if (!st) return res.json({ has: false });

  const job = st.job;
  res.json({
    has: true,
    from: st.from, to: st.to,
    rows: st.rows,
    job: job ? {
      running: job.running, done: job.done, failed: job.failed,
      changedLines: job.changedLines, total: job.total,
      error: job.error || null, log: job.log.slice(-80)
    } : null
  });
});

app.post('/api/swap/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = swapStore.get(req.desk);
  if (st && st.job) st.job.stop = true;
  res.json({ ok: true });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/swap/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = swapStore.get(req.desk);
  const chk = swapChecks.get(req.desk);
  if (st) {
    st.ended = true;
    if (st.job) st.job.stop = true;
  }
  if (chk) chk.stop = true;          // the plan being worked out goes too
  swapStore.delete(req.desk);
  swapChecks.delete(req.desk);
  res.json({ ok: true, had: !!(st || chk) });
});


// Only the log of a finished run goes; the invoices checked stay.
app.post('/api/swap/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = swapStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) st.job = null;
  res.json({ ok: true });
});

app.post('/api/swap/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = swapStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'A change is still running' });
  swapStore.delete(req.desk);
  res.json({ ok: true });
});

// ==================== change category ====================
// The P&L heading a transaction sits under is one field on one line. This moves
// that field and leaves the date, the payee, the bank account, the amount and
// the VAT exactly where they are.

const recatStore = new Map();          // desk -> { from, to, scan, rows, job, at }

// The run lives in memory while it goes and in Postgres as well, so a deploy
// half way through does not lose the list. Memory is read first; the table is
// only gone back to after a restart.
async function getRecat(desk) {
  const live = recatStore.get(desk);
  if (live) return live;

  const saved = await loadRecatState(desk);
  if (!saved) return null;

  // the process it was running in is gone, so whatever it says, it is not
  // running now - the boot resume is what restarts one
  if (saved.scan && saved.scan.running) {
    saved.scan.running = false;
    saved.scan.error = 'The server restarted part way through the read. Find them again.';
  }
  if (saved.job && saved.job.running) saved.job.running = false;

  saved.desk = desk;
  recatStore.set(desk, saved);
  return saved;
}

function recatAccount(list, id) {
  const a = list.filter(x => String(x.id) === String(id))[0];
  if (!a) throw new Error('That category is not in this company any more');
  return a;
}

app.get('/api/recat/accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const accounts = await listRecatAccounts(realmId, token);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      count: accounts.length,
      accounts,
      kinds: RECAT_KINDS.map(k => ({ key: k.key, label: k.label }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reading a year of books takes longer than a request should, so the scan runs
// on the server and the page polls it - the same shape as every other long job
// here.
async function runRecatScan(realmId, st, scan) {
  const token = await getAccessToken(realmId);
  const out = await scanRecatAccount(realmId, token,
    { from: scan.from, to: scan.to, accountId: st.from.id, kinds: scan.kinds },
    step => {
      if (scan.stop) throw new Error('stopped');
      scan.upto = step.upto;
      scan.kind = step.kind;
      scan.found = step.found;
      scan.read = step.read;
    });

  st.rows = out.rows;
  scan.read = out.read;
  scan.found = out.rows.length;
  scan.running = false;
  scan.finished = Date.now();
  // the list is written down once, whole - a part-read scan is not worth
  // keeping when reading the books again is a minute's work
  await saveRecatState(st.desk, st).catch(e => console.error('recat save:', e.message));
}

app.post('/api/recat/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const { from, to, dateFrom, dateTo, kinds } = req.body || {};
    if (!from || !to) throw new Error('Pick the category to move out of and the one to move into');
    if (String(from) === String(to)) throw new Error('Those are the same category');
    if (!dateFrom || !dateTo) throw new Error('Give the dates to look between');
    if (dateFrom > dateTo) throw new Error('The first date is after the last one');

    const old = await getRecat(req.desk);
    if (old && old.job && old.job.running) throw new Error('A change is still running');
    if (old && old.scan && old.scan.running) throw new Error('A scan is still running');

    const token = await getAccessToken(realmId);
    const accounts = await listRecatAccounts(realmId, token);
    const fromA = recatAccount(accounts, from);
    const toA = recatAccount(accounts, to);

    const scan = {
      running: true, stop: false, from: dateFrom, to: dateTo,
      kinds: Array.isArray(kinds) ? kinds : null,
      upto: dateFrom, kind: '', found: 0, read: 0, started: Date.now()
    };
    const st = { desk: req.desk, from: fromA, to: toA, scan, rows: [], job: null, at: Date.now() };
    recatStore.set(req.desk, st);
    await saveRecatState(st.desk, st).catch(e => console.error('recat save:', e.message));

    runRecatScan(realmId, st, scan).catch(e => {
      scan.running = false;
      scan.stopped = e.message === 'stopped';
      scan.error = scan.stopped ? null : e.message;
    });

    res.json({ ok: true, from: fromA, to: toA });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One transaction per request. The batch API times out under load, and a slow
// run that finishes beats a fast one that does not.
async function runRecat(realmId, st, job) {
  const token = await getAccessToken(realmId);

  for (const row of job.rows) {
    if (job.stop) break;
    // a resumed run walks the same list again - what is already moved is done
    if (row.state !== 'ready') continue;

    try {
      const out = await recatOne(realmId, token, row.kind, row.qbId, st.from.id, st.to);
      row.state = 'changed';
      row.note = out.lines + (out.lines === 1 ? ' line' : ' lines') + ' now under ' + st.to.name;
      job.done++;
      job.changedLines += out.lines;
      job.moved = Math.round((job.moved + row.hitTotal) * 100) / 100;
      job.log.push({
        ok: true,
        doc: out.doc || (row.kindLabel + ' ' + row.date),
        lines: out.lines,
        // the total is the proof that nothing but the category moved
        moved: Math.round((out.total - out.before) * 100) / 100
      });
      await logRecatMove(realmId, st, row, { ok: true, lines: out.lines })
        .catch(e => console.error('recat log:', e.message));
    } catch (e) {
      row.state = 'failed';
      row.note = e.message;
      job.done++;
      job.failed++;
      job.log.push({ ok: false, doc: row.doc || (row.kindLabel + ' ' + row.date), msg: e.message });
      await logRecatMove(realmId, st, row, { ok: false, message: e.message })
        .catch(err => console.error('recat log:', err.message));
    }

    // written down after every transaction, so a deploy mid-run costs at most
    // the one that was in flight
    job.cursor = job.done;
    await saveRecatProgress(st.desk, st).catch(e => console.error('recat save:', e.message));
  }

  job.running = false;
  job.finished = Date.now();
  await saveRecatProgress(st.desk, st).catch(e => console.error('recat save:', e.message));
}

app.post('/api/recat/run', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = await getRecat(req.desk);
    if (!st) throw new Error('Find the transactions first');
    if (st.scan && st.scan.running) throw new Error('The scan is still running');
    if (st.job && st.job.running) throw new Error('That is already running');

    const only = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    // what a finished run left refused is taken again by carrying on
    st.rows.forEach(r => { if (r.state === 'failed') { r.state = 'ready'; r.note = ''; } });
    const rows = st.rows.filter(r =>
      r.state === 'ready' && r.qbId && (!only || only.includes(r.kind + '|' + r.qbId)));
    if (!rows.length) throw new Error('None of these are waiting to be moved');

    const job = {
      running: true, stop: false, done: 0, failed: 0, changedLines: 0, moved: 0,
      total: rows.length, cursor: 0, log: [], started: Date.now(), rows,
      // the keys are what a restart reads back to know which rows this run is for
      keys: rows.map(r => r.kind + '|' + r.qbId)
    };
    st.job = job;
    await saveRecatState(st.desk, st).catch(e => console.error('recat save:', e.message));

    runRecat(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
      saveRecatProgress(st.desk, st).catch(() => {});
    });

    res.json({ ok: true, transactions: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/recat/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = await getRecat(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  if (!st) return res.json({ has: false });

  const s = st.scan, job = st.job;
  res.json({
    has: true,
    from: st.from, to: st.to,
    rows: st.rows,
    scan: s ? {
      running: s.running, from: s.from, to: s.to, upto: s.upto, kind: s.kind,
      found: s.found, read: s.read, stopped: !!s.stopped, error: s.error || null
    } : null,
    job: job ? {
      running: job.running, done: job.done, failed: job.failed,
      changedLines: job.changedLines, moved: job.moved, total: job.total,
      error: job.error || null, log: job.log.slice(-80)
    } : null
  });
});

app.post('/api/recat/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = recatStore.get(req.desk);
  if (st && st.job && st.job.running) st.job.stop = true;
  if (st && st.scan && st.scan.running) st.scan.stop = true;
  res.json({ ok: true });

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/recat/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = recatStore.get(req.desk);
  if (st) {
    st.ended = true;                 // nothing of it is written back
    if (st.job) st.job.stop = true;
    if (st.scan) st.scan.stop = true;
  }
  recatStore.delete(req.desk);
  // the list goes; what was actually moved stays in recat_moves
  await clearRecatState(req.desk).catch(e => console.error('recat end:', e.message));
  res.json({ ok: true, had: !!st });
});

});

// Only the log of a finished run goes; the transactions found stay.
app.post('/api/recat/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = await getRecat(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) {
    st.job = null;
    await saveRecatState(st.desk, st).catch(e => console.error('recat save:', e.message));
  }
  res.json({ ok: true });
});

app.post('/api/recat/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = recatStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'A change is still running' });
  if (st && st.scan && st.scan.running) return res.status(400).json({ error: 'A scan is still running' });
  recatStore.delete(req.desk);
  // the list goes; what was actually moved stays in recat_moves
  await clearRecatState(req.desk).catch(e => console.error('recat clear:', e.message));
  res.json({ ok: true });
});

// What has been moved in this company, newest first. Read only - this is the
// record, not something to change.
app.get('/api/recat/history', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const moves = await listRecatMoves(realmId, Number(req.query.limit) || 200);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ count: moves.length, moves });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==================== change category by description ==================== */

// Same edit as the category change, picked a different way. The description on
// a line is what tells one bank charge from another, so the range is read once,
// the descriptions in it are gathered with what they are worth and what they
// sit under now, and the ticked ones are moved to the category chosen.
//
// The list lives in memory only. It is rebuilt by reading the books again,
// which is a minute's work, and what was actually moved goes into the same
// record as the category change so there is one place to look.

const descStore = new Map();           // desk -> { scan, rows, accountId, to, job, at }

const descRound = n => Math.round(n * 100) / 100;

// The transactions a run is about, each carrying the lines that will move and
// what those lines are worth - that is what the record is written from.
function descPick(st, keys, by) {
  const want = descWantOf(keys);
  const out = [];

  st.rows.forEach(row => {
    if (row.state !== 'ready') return;
    const hits = linesFor(row, want, st.accountId, by);
    if (!hits.length) return;
    row.hits = hits;
    row.hitTotal = descRound(hits.reduce((s, l) => s + Number(l.amount || 0), 0));
    out.push(row);
  });

  return out;
}

app.post('/api/desc/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const { dateFrom, dateTo, kinds, accountId } = req.body || {};
    if (!dateFrom || !dateTo) throw new Error('Give the dates to look between');
    if (dateFrom > dateTo) throw new Error('The first date is after the last one');

    const old = descStore.get(req.desk);
    if (old && old.job && old.job.running) throw new Error('A change is still running');
    if (old && old.scan && old.scan.running) throw new Error('A scan is still running');

    const token = await getAccessToken(realmId);
    let only = null;
    if (accountId) {
      const accounts = await listRecatAccounts(realmId, token);
      only = recatAccount(accounts, accountId);
    }

    const scan = {
      running: true, stop: false, from: dateFrom, to: dateTo,
      kinds: Array.isArray(kinds) ? kinds : null,
      upto: dateFrom, kind: '', found: 0, read: 0, started: Date.now()
    };
    const st = {
      scan, rows: [], accountId: only ? only.id : null, account: only,
      to: null, job: null, at: Date.now()
    };
    descStore.set(req.desk, st);

    scanDescriptions(realmId, token,
      { from: dateFrom, to: dateTo, accountId: st.accountId, kinds: scan.kinds },
      step => {
        if (scan.stop) throw new Error('stopped');
        scan.upto = step.upto;
        scan.kind = step.kind;
        scan.found = step.found;
        scan.read = step.read;
        scan.itemOnly = step.itemOnly || 0;
      })
      .then(out => {
        st.rows = out.rows;
        scan.read = out.read;
        scan.itemOnly = out.itemOnly || 0;
        scan.found = out.rows.length;
        scan.running = false;
        scan.finished = Date.now();
      })
      .catch(e => {
        scan.running = false;
        scan.stopped = e.message === 'stopped';
        scan.error = scan.stopped ? null : e.message;
      });

    res.json({ ok: true, account: only });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/desc/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = descStore.get(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  if (!st) return res.json({ has: false });

  const s = st.scan, job = st.job;
  // the same read, listed by description, by payee or by the heading it is
  // under - whichever the page is asking for. Regrouping is free, so changing
  // the way does not read the books again.
  const by = descWayOf(req.query.by).key;

  res.json({
    has: true,
    account: st.account || null,
    to: st.to || null,
    by,
    ways: DESC_WAYS,
    // one row per heading, not per transaction - the transactions behind one of
    // them are asked for on their own
    groups: groupDescRows(st.rows, by),
    txns: st.rows.length,
    scan: s ? {
      running: s.running, from: s.from, to: s.to, upto: s.upto, kind: s.kind,
      found: s.found, read: s.read, itemOnly: s.itemOnly || 0, stopped: !!s.stopped, error: s.error || null
    } : null,
    job: job ? {
      running: job.running, done: job.done, failed: job.failed,
      changedLines: job.changedLines, moved: job.moved, total: job.total,
      descs: job.descs, by: job.by || 'description',
      error: job.error || null, log: job.log.slice(-80)
    } : null
  });
});

// The transactions carrying one description, so what is about to move can be
// looked at before it moves.
app.get('/api/desc/rows', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const st = descStore.get(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  if (!st) return res.json({ rows: [] });

  const by = descWayOf(req.query.by).key;
  const want = new Set([String(req.query.key || descKey(req.query.desc || ''))]);
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const out = [];

  for (const row of st.rows) {
    const hits = linesFor(row, want, st.accountId, by);
    if (!hits.length) continue;
    out.push({
      kind: row.kind, kindLabel: row.kindLabel, qbId: row.qbId, doc: row.doc,
      date: row.date, name: row.name, payFrom: row.payFrom,
      state: row.state, note: row.note || '',
      hits,
      hitTotal: descRound(hits.reduce((s, l) => s + Number(l.amount || 0), 0))
    });
    if (out.length >= limit) break;
  }

  res.json({ rows: out });
});

// One transaction per request, the same as the category change - the batch API
// times out under load and a slow run that finishes beats a fast one that does
// not.
async function runDesc(realmId, st, job) {
  const token = await getAccessToken(realmId);

  for (const row of job.rows) {
    if (job.stop) break;
    if (row.state !== 'ready') continue;

    // what this row is posted to now, so the record says where it came from
    const was = row.hits[0];
    const from = { id: String(was.accountId), name: was.account || '' };

    try {
      const out = await redescOne(realmId, token, row.kind, row.qbId,
        row.hits.map(l => l.id), st.to);
      row.state = 'changed';
      row.note = out.lines + (out.lines === 1 ? ' line' : ' lines') + ' now under ' + st.to.name;
      // the list on screen is rebuilt from these lines, so they say where the
      // lines are now rather than where they were when the books were read
      row.hits.forEach(l => { l.accountId = String(st.to.id); l.account = st.to.name; });
      job.done++;
      job.changedLines += out.lines;
      job.moved = descRound(job.moved + row.hitTotal);
      job.log.push({
        ok: true,
        doc: out.doc || (row.kindLabel + ' ' + row.date),
        lines: out.lines,
        // the total is the proof that nothing but the category moved
        moved: descRound(out.total - out.before)
      });
      await logRecatMove(realmId, { from, to: st.to }, row, { ok: true, lines: out.lines })
        .catch(e => console.error('desc log:', e.message));
    } catch (e) {
      row.state = 'failed';
      row.note = e.message;
      job.done++;
      job.failed++;
      job.log.push({ ok: false, doc: row.doc || (row.kindLabel + ' ' + row.date), msg: e.message });
      await logRecatMove(realmId, { from, to: st.to }, row, { ok: false, message: e.message })
        .catch(err => console.error('desc log:', err.message));
    }
  }

  job.running = false;
  job.finished = Date.now();
}

app.post('/api/desc/run', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = descStore.get(req.desk);
    if (!st) throw new Error('Find the descriptions first');
    if (st.scan && st.scan.running) throw new Error('The scan is still running');
    if (st.job && st.job.running) throw new Error('That is already running');

    const body = req.body || {};
    // carrying on takes the same descriptions to the same category as the run before
    if (body.carryOn && st.job && st.to) {
      body.keys = st.job.descs; body.by = st.job.by; body.to = st.to.id;
    }
    // what a finished run left refused is taken again by carrying on
    st.rows.forEach(r => { if (r.state === 'failed') { r.state = 'ready'; r.note = ''; } });
    const by = descWayOf(body.by).key;
    // the keys come back as the list handed out - already levelled for case and
    // spacing, and a category keyed by its id
    const keys = (Array.isArray(body.keys) ? body.keys : [])
      .map(k => String(k || '').trim()).filter(Boolean);
    if (!keys.length) throw new Error('Tick at least one of them');
    if (!body.to) throw new Error('Pick the category to put them under');

    const token = await getAccessToken(realmId);
    const accounts = await listRecatAccounts(realmId, token);
    const toA = recatAccount(accounts, body.to);
    st.to = toA;

    const rows = descPick(st, keys, by);
    if (!rows.length) throw new Error('Nothing is waiting under those');

    const job = {
      running: true, stop: false, done: 0, failed: 0, changedLines: 0, moved: 0,
      total: rows.length, descs: keys, by, log: [], started: Date.now(), rows
    };
    st.job = job;

    runDesc(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, transactions: job.total, to: toA });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/desc/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = descStore.get(req.desk);
  if (st && st.job && st.job.running) st.job.stop = true;
  if (st && st.scan && st.scan.running) st.scan.stop = true;
  res.json({ ok: true });

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/desc/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = descStore.get(req.desk);
  if (st) {
    st.ended = true;
    if (st.job) st.job.stop = true;
    if (st.scan) st.scan.stop = true;
  }
  descStore.delete(req.desk);
  res.json({ ok: true, had: !!st });
});

});

// Only the log of a finished run goes; what was read stays.
app.post('/api/desc/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = descStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) st.job = null;
  res.json({ ok: true });
});

app.post('/api/desc/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = descStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'A change is still running' });
  if (st && st.scan && st.scan.running) return res.status(400).json({ error: 'A scan is still running' });
  descStore.delete(req.desk);
  res.json({ ok: true });
});

// Empty the record. Asked for from either page - the category change and the
// description change write to the same table, so there is one record and one
// place to clear it.
app.post('/api/recat/history/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const gone = await clearRecatMoves(realmId);
    res.json({ ok: true, cleared: gone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A deploy in the middle of a run leaves the rest of the list sitting in
// Postgres. This picks it up where it stopped.
async function resumeRecat() {
  const rows = await unfinishedRecat();

  for (const r of rows) {
    // nobody's run - written before runs had an owner - is not restarted
    if (!r.user_sub) continue;
    const desk = deskKey(r.realm_id, r.user_sub);
    const st = {
      desk,
      from: r.from_acct, to: r.to_acct, scan: r.scan,
      rows: r.txns || [], job: null, at: Date.now()
    };
    if (!st.from || !st.to || recatStore.has(desk)) continue;

    const saved = r.job || {};
    const byKey = new Map(st.rows.map(x => [x.kind + '|' + x.qbId, x]));
    const left = (saved.keys || []).map(k => byKey.get(k))
      .filter(x => x && x.state === 'ready');
    if (!left.length) continue;

    const job = {
      running: true, stop: false,
      done: saved.done || 0, failed: saved.failed || 0,
      changedLines: saved.changedLines || 0, moved: saved.moved || 0,
      total: saved.total || (saved.keys || []).length,
      cursor: saved.cursor || 0, keys: saved.keys || [],
      log: saved.log || [], started: saved.started || Date.now(),
      rows: left
    };
    st.job = job;
    recatStore.set(desk, st);

    console.log(`recat: picking up ${left.length} left for ${r.realm_id}`);
    runRecat(r.realm_id, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
      saveRecatProgress(desk, st).catch(() => {});
    });
  }
}

// Only asks Google what it has. Nothing is changed.
app.get('/api/adv/peek-images', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await peekImages(sheetId, tab));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Delivery charges and taxes ====================
// Daewoo keeps its delivery charges in a folder of their own, apart from the
// CPR sheets. This is where that folder is remembered.
app.get('/api/charges/dc-root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ folderId: await getSetting(realmId, 'charges:dcRoot', '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/charges/dc-root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let id = String(req.body.folderId || '').trim();
  const m = id.match(/[-\w]{25,}/);
  if (m) id = m[0];
  if (!id) return res.status(400).json({ error: 'Folder link or ID required' });

  try {
    await setSetting(realmId, 'charges:dcRoot', id);
    res.json({ ok: true, folderId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// open a CPR sheet and add its charge columns up, CPR by CPR
app.get('/api/charges/open', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const tabs = await listTabs(sheetId, excel);
    if (!tabs.length) return res.status(400).json({ error: 'That file has no tabs' });
    const useTab = tab || tabs[0].title;

    const saved = courier
      ? await getSetting(realmId, `charges:cols:${courier}`, null)
      : null;

    const d = await loadCharges(sheetId, useTab, excel, saved);
    const accounts = await getSetting(realmId, `charges:accounts:${courier}`, null);

    res.json({
      tabs,
      tab: useTab,
      header: d.header,
      cols: d.cols,
      remembered: !!saved,
      headerRow: d.headerRow,
      skippedTotals: d.skippedTotals,
      accounts,
      cprs: d.cprs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/charges/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, cols } = req.body;
  if (!courier || !cols) return res.status(400).json({ error: 'courier and cols required' });

  try {
    await setSetting(realmId, `charges:cols:${courier}`, cols);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// which QuickBooks account each line lands in - asked once per courier
app.post('/api/charges/accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, accounts } = req.body;
  if (!courier || !accounts) return res.status(400).json({ error: 'courier and accounts required' });

  try {
    await setSetting(realmId, `charges:accounts:${courier}`, accounts);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/charges/qb-accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const token = await getAccessToken(realmId);
    res.json({ accounts: await listAllAccounts(realmId, token) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// has this CPR been journalled already?
app.get('/api/charges/check', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const cpr = req.query.cpr;
  if (!cpr) return res.status(400).json({ error: 'cpr required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const token = await getAccessToken(realmId);
    res.json({ existing: await findJournal(realmId, token, cpr) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// one CPR, one journal entry
// every CPR in the sheet, looked up in QuickBooks in one go
app.post('/api/charges/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = Array.isArray(req.body.cprs) ? req.body.cprs : [];
  if (!list.length) return res.status(400).json({ error: 'Nothing to look up' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const token = await getAccessToken(realmId);

    const out = {};
    for (const c of list) {
      const cpr = String(c.cpr || '').trim();
      if (!cpr) continue;

      let found = null;
      try {
        found = await findJournal(realmId, token, cpr);
      } catch (e) {
        out[cpr] = { state: 'unknown', note: e.message };
        continue;
      }

      if (!found) { out[cpr] = { state: 'none' }; continue; }

      const sheetTotal = Math.round(Number(c.total || 0) * 100) / 100;
      const gap = Math.round((found.amount - sheetTotal) * 100) / 100;

      out[cpr] = {
        state: Math.abs(gap) > 1 ? 'off' : 'done',
        id: found.id,
        date: found.date,
        amount: found.amount,
        sheetTotal,
        gap
      };
    }

    res.json({ checked: Object.keys(out).length, cprs: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/charges/post', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const {
    courier, cprNumber, cprDate,
    charges = 0, wht = 0, wst = 0,
    chargesAccount, whtAccount, wstAccount, bankAccount
  } = req.body;

  if (!cprNumber) return res.status(400).json({ error: 'CPR number required' });
  if (!bankAccount) return res.status(400).json({ error: 'Pick the bank account' });

  const c = Math.round(Number(charges) * 100) / 100;
  const i = Math.round(Number(wht) * 100) / 100;
  const s = Math.round(Number(wst) * 100) / 100;
  const total = Math.round((c + i + s) * 100) / 100;

  if (total <= 0) return res.status(400).json({ error: 'Nothing to post - all three are zero' });
  if (c > 0 && !chargesAccount) return res.status(400).json({ error: 'Pick the delivery charges account' });
  if (i > 0 && !whtAccount) return res.status(400).json({ error: 'Pick the withholding income tax account' });
  if (s > 0 && !wstAccount) return res.status(400).json({ error: 'Pick the withholding sales tax account' });

  try {
    const token = await getAccessToken(realmId);

    // never post the same CPR twice
    const already = await findJournal(realmId, token, cprNumber);
    if (already && !req.body.force) {
      return res.status(409).json({
        error: `CPR ${cprNumber} was already journalled on ${already.date}`,
        existing: already
      });
    }

    // the same words on every line, as they appear when this is done by hand
    const note = String(req.body.description || '').trim() ||
                 [String(cprNumber).slice(0, 21), courier].filter(Boolean).join(' - ');

    const lines = [];
    const line = (amount, accountId, side) => {
      lines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: note,
        JournalEntryLineDetail: {
          PostingType: side,
          AccountRef: { value: String(accountId) }
        }
      });
    };

    if (c > 0) line(c, chargesAccount, 'Debit');
    if (i > 0) line(i, whtAccount, 'Debit');
    if (s > 0) line(s, wstAccount, 'Debit');
    line(total, bankAccount, 'Credit');

    const memo = String(req.body.memo || '').trim() ||
                 `Delivery charges and taxes - CPR ${cprNumber}` +
                 (courier ? ` - ${courier}` : '') +
                 (cprDate ? ` dated ${cprDate}` : '');

    const payload = {
      DocNumber: String(cprNumber).slice(0, 21),
      Line: lines,
      PrivateNote: memo
    };
    if (cprDate) payload.TxnDate = cprDate;

    const r = await postJournal(realmId, token, payload);
    if (!r.ok) return res.status(400).json({ error: r.msg });

    if (courier) {
      try {
        await setSetting(realmId, `charges:accounts:${courier}`, {
          chargesAccount, whtAccount, wstAccount, bankAccount
        });
      } catch (e) {}
    }

    res.json({
      ok: true,
      id: r.id,
      cprNumber,
      total,
      lines: {
        charges: c, wht: i, wst: s
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ---- couriers that write their charges in a summary block, not in columns ----

app.get('/api/charges/summary-open', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, courier } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const tabs = await listTabs(sheetId, excel);
    if (!tabs.length) return res.status(400).json({ error: 'That file has no tabs' });
    const useTab = tab || tabs[0].title;

    const d = await loadTraxSummaries(sheetId, useTab, excel);
    const lines = courier
      ? await getSetting(realmId, `charges:lines:${courier}`, null)
      : null;

    res.json({
      tabs,
      tab: useTab,
      cprs: d.cprs,
      names: d.names,
      lines,
      headerRow: d.headerRow
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the lines a courier's journal entry is built from - saved once, reused
app.post('/api/charges/lines', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { courier, lines } = req.body;
  if (!courier || !Array.isArray(lines)) {
    return res.status(400).json({ error: 'courier and lines required' });
  }

  try {
    await setSetting(realmId, `charges:lines:${courier}`, lines);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// work out what one CPR's entry would look like, without writing anything
app.post('/api/charges/preview', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { cpr, lines } = req.body;
  if (!cpr) return res.status(400).json({ error: 'cpr required' });

  try {
    res.json(applyLines(cpr, lines || []));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// a journal entry built from those lines - any number of debits, one credit
app.post('/api/charges/post-lines', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const {
    courier, cprNumber, cprDate, bankAccount,
    lines = [], description, memo
  } = req.body;

  if (!cprNumber) return res.status(400).json({ error: 'CPR number required' });
  if (!bankAccount) return res.status(400).json({ error: 'Pick the bank account' });

  const good = lines
    .map(l => ({
      label: String(l.label || '').trim(),
      account: l.account,
      amount: Math.round(Number(l.amount || 0) * 100) / 100
    }))
    .filter(l => l.amount > 0);

  if (!good.length) return res.status(400).json({ error: 'Every line came to zero' });

  const missing = good.filter(l => !l.account);
  if (missing.length) {
    return res.status(400).json({
      error: 'Pick an account for: ' + missing.map(l => l.label || 'a line').join(', ')
    });
  }

  const total = Math.round(good.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  try {
    const token = await getAccessToken(realmId);

    const already = await findJournal(realmId, token, cprNumber);
    if (already && !req.body.force) {
      return res.status(409).json({
        error: `CPR ${cprNumber} was already journalled on ${already.date}`,
        existing: already
      });
    }

    const note = String(description || '').trim() ||
                 [String(cprNumber).slice(0, 21), courier].filter(Boolean).join(' - ');

    const qbLines = good.map(l => ({
      DetailType: 'JournalEntryLineDetail',
      Amount: l.amount,
      Description: note,
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: String(l.account) }
      }
    }));

    qbLines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: total,
      Description: note,
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: String(bankAccount) }
      }
    });

    const payload = {
      DocNumber: String(cprNumber).slice(0, 21),
      Line: qbLines,
      PrivateNote: String(memo || '').trim() ||
        `Delivery charges and taxes - CPR ${cprNumber}` +
        (courier ? ` - ${courier}` : '') +
        (cprDate ? ` dated ${cprDate}` : '')
    };
    if (cprDate) payload.TxnDate = cprDate;

    const r = await postJournal(realmId, token, payload);
    if (!r.ok) return res.status(400).json({ error: r.msg });

    if (courier && bankAccount) {
      try {
        const prev = (await getSetting(realmId, `charges:accounts:${courier}`, {})) || {};
        prev.bankAccount = bankAccount;
        await setSetting(realmId, `charges:accounts:${courier}`, prev);
      } catch (e) {}
    }

    res.json({ ok: true, id: r.id, cprNumber, total, lines: good });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Courier accounts ====================
// Everything the courier dashboard needs, for one account, one courier,
// or all of them at once. Read from our own table, so it is quick.
// the dashboard, asked from the courier the moment it is opened
app.get('/api/courier/live', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.fresh === '1' && account) forgetLive(account);
    res.json(await liveStats(realmId, { from, to, account, courier }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// one parcel, by its tracking number
app.get('/api/courier/track', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await trackOne(realmId, req.query.q, req.query.account));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Cash payment receipts ----------

// the receipts we know of, newest first
app.get('/api/courier/cprs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const { account, from, to } = req.query;

    // ask the courier about a few more parcels while the page is being read
    chaseCpr(realmId, account).catch(() => {});

    const [list, progress] = await Promise.all([
      listCprs(realmId, { account, from, to }),
      cprProgress(realmId, account)
    ]);

    res.json({ cprs: list, progress });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// everything inside one receipt
app.get('/api/courier/cpr', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const cpr = String(req.query.cpr || '').trim();
  if (!cpr) return res.status(400).json({ error: 'cpr required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const orders = await cprOrders(realmId, cpr);
    const n = v => Math.round(Number(v || 0) * 100) / 100;

    res.json({
      cpr,
      count: orders.length,
      amount: n(orders.reduce((s, x) => s + x.amount, 0)),
      fee: n(orders.reduce((s, x) => s + x.fee, 0)),
      tax: n(orders.reduce((s, x) => s + x.tax, 0)),
      settledOn: orders.length ? orders[0].settledOn : null,
      orders
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// a nudge, for the button on the page
app.post('/api/courier/cpr-chase', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.json(await chaseCpr(realmId, req.body.account));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ---------- Bringing the history in ----------

app.post('/api/courier/backfill', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startBackfill(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/courier/backfill-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = backfillSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/courier/backfill-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopBackfill(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/courier/backfill-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endBackfill(req.desk) });
});


app.post('/api/courier/backfill-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeBackfill(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/courier/backfill-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearBackfill(req.desk);
  if (!ok) return res.status(409).json({ error: 'The backfill is still running' });
  res.json({ ok: true });
});
// how the quiet catch-up is getting on
app.get('/api/courier/keeper', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json(keeperState());
});

app.post('/api/courier/keeper-now', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json(sweepNow());
});
// ---------- The dashboard, read from our own table ----------

app.get('/api/courier/dash', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await dashData(realmId, { from, to, account, courier }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the receipts, newest first
app.get('/api/courier/receipts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier, limit } = req.query;

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ cprs: await recentCprs(realmId, { from, to, account, courier, limit }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// what was handed over, day by day - what a load sheet would have said
app.get('/api/courier/pickups', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier, limit, day } = req.query;

  try {
    res.setHeader('Cache-Control', 'no-store');
    if (day) return res.json(await pickupOrders(realmId, { day, account, courier }));
    res.json({ days: await pickups(realmId, { from, to, account, courier, limit }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the orders behind any number on the page
app.get('/api/courier/rows', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier, status, group, city, cpr, picked } = req.query;

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ordersBy(realmId, { from, to, account, courier, status, group, city, cpr, picked }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Every parcel booked in the range, with what became of it - booked, picked,
// delivered or returned, what it was worth, what the courier charged, and
// which receipt paid it out. This is the whole tracking story in one file.
app.get('/api/courier/export', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier, status, group, city, cpr, picked } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  // every value quoted, so a tracking number keeps its leading zeros and a
  // comma inside an address cannot split a row
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const line = a => a.map(cell).join(',');
  const CRLF = '\r\n';

  try {
    const name = `courier ${from} to ${to}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('Cache-Control', 'no-store');

    // written out as it is read, so a year of parcels never has to be held
    res.write('﻿' + line([
      'Account', 'Order ref', 'Tracking', 'City', 'Status', 'Stage',
      'Amount', 'Fee', 'Tax', 'Booked', 'Picked up', 'Delivered',
      'Settled', 'CPR number'
    ]) + CRLF);

    const sent = await eachOrder(
      realmId,
      { from, to, account, courier, status, group, city, cpr, picked },
      rows => {
        res.write(rows.map(o => line([
          o.account, o.orderRef, o.tracking, o.city, o.status, o.statusGroup,
          o.amount, o.fee, o.tax, o.bookedOn, o.pickedOn, o.deliveredOn,
          o.settledOn, o.cprNumber
        ])).join(CRLF) + CRLF);
      }
    );

    console.log(`export: ${sent} orders, ${from} to ${to}`);
    res.end();
  } catch (e) {
    // the headers are already out by now, so the error has to go in the file
    if (res.headersSent) {
      res.end(CRLF + '"Export stopped: ' +
              String(e.message).replace(/"/g, "'") + '"' + CRLF);
    }
    else res.status(500).json({ error: e.message });
  }
});

// the orders behind one status

app.get('/api/courier/orders', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier, status, group } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await liveOrders(realmId, { from, to, account, courier, status, group }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// one untouched row, to see what the courier actually sends
app.get('/api/courier/peek', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await peekRaw(realmId, req.query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// every status the courier knows, with its number
app.get('/api/courier/status-list', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const acc = await getCourierAccount(realmId, Number(req.query.account));
    if (!acc) return res.status(404).json({ error: 'No such account' });

    const a = ADAPTERS[acc.courier];
    if (!a) return res.status(400).json({ error: 'No adapter for ' + acc.courier });

    res.json(await a.testToken(acc.token));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/courier/stats', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account, courier } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');

       // the joined query needs the table spelled out; the plain ones do not mind
    const where = [`o.realm_id = $1`, `o.booked_on >= $2`, `o.booked_on <= $3`];
    const args = [realmId, from, to];

    if (account) { args.push(Number(account)); where.push(`o.account_id = $${args.length}`); }
    if (courier) { args.push(String(courier)); where.push(`o.courier = $${args.length}`); }

    const w = where.join(' AND ');

    // the buckets, and what each is worth
    const groups = await pool.query(
      `SELECT status_group, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount
                 FROM courier_orders o WHERE ${w}
        GROUP BY o.status_group ORDER BY n DESC`, args);

    // one row per account, so the "all companies" view can list them
    const byAccount = await pool.query(
      `SELECT o.account_id, a.label, a.courier,
              COUNT(*) AS orders,
              COUNT(*) FILTER (WHERE o.status_group = 'delivered')  AS delivered,
              COUNT(*) FILTER (WHERE o.status_group = 'returned')   AS returned,
              COUNT(*) FILTER (WHERE o.status_group = 'transit')    AS transit,
              COUNT(*) FILTER (WHERE o.status_group = 'unbooked')   AS unbooked,
              COUNT(*) FILTER (WHERE o.status_group IN ('lost','damaged')) AS lost,
              COALESCE(SUM(o.amount),0) AS amount,
              COALESCE(SUM(o.amount) FILTER (WHERE o.status_group = 'delivered'),0) AS delivered_amount,
              COALESCE(SUM(o.fee),0) AS fee,
              COALESCE(SUM(o.tax),0) AS tax
         FROM courier_orders o
         JOIN courier_accounts a ON a.id = o.account_id
        WHERE ${w}
        GROUP BY o.account_id, a.label, a.courier
        ORDER BY orders DESC`, args);

    // day by day, for the line chart
        const daily = await pool.query(
      `SELECT o.booked_on AS day,
              COUNT(*) AS orders,
              COUNT(*) FILTER (WHERE o.status_group = 'delivered') AS delivered,
              COALESCE(SUM(o.amount),0) AS amount
         FROM courier_orders o WHERE ${w}
        GROUP BY o.booked_on ORDER BY o.booked_on`, args);
    
    // where the parcels went
       const cities = await pool.query(
      `SELECT o.city, COUNT(*) AS n
         FROM courier_orders o WHERE ${w} AND o.city IS NOT NULL AND o.city <> ''
        GROUP BY o.city ORDER BY n DESC LIMIT 12`, args);

        const totals = await pool.query(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.amount),0) AS amount,
              COALESCE(SUM(o.fee),0) AS fee,
              COALESCE(SUM(o.tax),0) AS tax,
              MAX(o.seen_at) AS last_seen
         FROM courier_orders o WHERE ${w}`, args);

    const num = v => Math.round(Number(v || 0) * 100) / 100;

    res.json({
      from, to,
      totals: {
        orders: Number(totals.rows[0].orders || 0),
        amount: num(totals.rows[0].amount),
        fee: num(totals.rows[0].fee),
        tax: num(totals.rows[0].tax),
        lastSeen: totals.rows[0].last_seen
      },
      groups: groups.rows.map(r => ({
        group: r.status_group || 'other',
        count: Number(r.n),
        amount: num(r.amount)
      })),
      accounts: byAccount.rows.map(r => ({
        id: r.account_id,
        label: r.label,
        courier: r.courier,
        orders: Number(r.orders),
        delivered: Number(r.delivered),
        returned: Number(r.returned),
        transit: Number(r.transit),
        unbooked: Number(r.unbooked),
        lost: Number(r.lost),
        amount: num(r.amount),
        deliveredAmount: num(r.delivered_amount),
        fee: num(r.fee),
        tax: num(r.tax)
      })),
      daily: daily.rows.map(r => ({
        day: r.day ? new Date(r.day).toISOString().slice(0, 10) : null,
        orders: Number(r.orders),
        delivered: Number(r.delivered),
        amount: num(r.amount)
      })).filter(x => x.day),
      cities: cities.rows.map(r => ({ city: r.city, count: Number(r.n) }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// what this view is called, so the page can head itself properly
app.get('/api/courier/scope', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const { account, courier } = req.query;

    if (account) {
      const acc = await getCourierAccount(realmId, Number(account));
      if (!acc) return res.status(404).json({ error: 'No such account' });
      const a = ADAPTERS[acc.courier];
      return res.json({
        kind: 'account',
        id: acc.id,
        title: acc.label,
        sub: (a ? a.name : acc.courier),
        lastSync: acc.last_sync,
        lastError: acc.last_error
      });
    }

    if (courier) {
      const a = ADAPTERS[courier];
      return res.json({
        kind: 'courier',
        title: a ? a.name : courier,
        sub: 'every account'
      });
    }

    return res.json({ kind: 'all', title: 'All courier companies', sub: 'every account' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One adapter per courier. Adding a courier means adding a file and a line here.
const ADAPTERS = {
  postex: postexAdapter
};

app.get('/api/courier/kinds', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({
    kinds: Object.values(ADAPTERS).map(a => ({ key: a.key, name: a.name }))
  });
});
// The sidebar shows every courier we can speak to, whether or not an account
// has been added yet - so a first account can be added from there.
app.get('/api/courier/tree', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const accounts = await listCourierAccounts(realmId);

    const tree = Object.values(ADAPTERS).map(a => ({
      key: a.key,
      name: a.name,
      ready: true,
      accounts: accounts
        .filter(x => x.courier === a.key)
        .map(x => ({ id: x.id, label: x.label, lastSync: x.last_sync }))
    }));

    // couriers we know of but cannot talk to yet
    const PLANNED = [
      { key: 'trax',   name: 'Trax' },
      { key: 'daewoo', name: 'Daewoo' }
    ];

    PLANNED.forEach(p => {
      if (tree.some(t => t.key === p.key)) return;
      tree.push({
        key: p.key,
        name: p.name,
        ready: false,
        accounts: accounts
          .filter(x => x.courier === p.key)
          .map(x => ({ id: x.id, label: x.label, lastSync: x.last_sync }))
      });
    });

    res.json({ couriers: tree });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/courier/accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ accounts: await listCourierAccounts(realmId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the token is checked before it is kept, so a bad one never gets saved
app.post('/api/courier/accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const courier = String(req.body.courier || '').trim().toLowerCase();
  const label = String(req.body.label || '').trim();
  const token = String(req.body.token || '').trim();

  if (!ADAPTERS[courier]) return res.status(400).json({ error: 'Unknown courier' });
  if (!label) return res.status(400).json({ error: 'Give this account a name' });
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const check = await ADAPTERS[courier].testToken(token);
    const id = await addCourierAccount(realmId, { courier, label, token });
    res.json({ ok: true, id, check });
  } catch (e) {
    res.status(400).json({ error: 'That token did not work: ' + e.message });
  }
});

app.post('/api/courier/accounts/test', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const acc = await getCourierAccount(realmId, req.body.id);
    if (!acc) return res.status(404).json({ error: 'No such account' });

    const a = ADAPTERS[acc.courier];
    if (!a) return res.status(400).json({ error: 'No adapter for ' + acc.courier });

    const check = await a.testToken(acc.token);
    await markSync(realmId, acc.id, null);
    res.json({ ok: true, check });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/courier/accounts/remove', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    await removeCourierAccount(realmId, req.body.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// pull a span of days from one account into our own table
app.post('/api/courier/sync', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id, from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    const acc = await getCourierAccount(realmId, id);
    if (!acc) return res.status(404).json({ error: 'No such account' });

    const a = ADAPTERS[acc.courier];
    if (!a) return res.status(400).json({ error: 'No adapter for ' + acc.courier });

    const orders = await a.fetchOrders(acc.token, from, to, 0);
    const saved = await saveOrders(realmId, acc.id, acc.courier, orders);
    await markSync(realmId, acc.id, null);

    // a quick count by bucket, so the page can show something straight away
    const tally = {};
    const unknown = {};
    orders.forEach(o => {
      tally[o.statusGroup] = (tally[o.statusGroup] || 0) + 1;
      if (o.statusGroup === 'other') {
        const s = o.status || '(blank)';
        unknown[s] = (unknown[s] || 0) + 1;
      }
    });

    res.json({
      ok: true,
      account: acc.label,
      pulled: orders.length,
      saved,
      tally,
      unknown
    });
  } catch (e) {
    try { await markSync(realmId, req.body.id, e.message); } catch (e2) {}
    res.status(400).json({ error: e.message });
  }
});
// ==================== Advance payments ====================

// where the advance sheet lives, saved once per company
app.get('/api/adv/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ folderId: await getSetting(realmId, 'adv:root', '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/adv/root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let id = String(req.body.folderId || '').trim();
  const m = id.match(/[-\w]{25,}/);
  if (m) id = m[0];
  if (!id) return res.status(400).json({ error: 'Folder or sheet link required' });

  try {
    await setSetting(realmId, 'adv:root', id);
    res.json({ ok: true, folderId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// a folder link gives a list; a sheet link gives just that one
app.get('/api/adv/sheets', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const id = req.query.id || await getSetting(realmId, 'adv:root', '');
    if (!id) return res.status(400).json({ error: 'Set the sheet first' });

    let folders = [], sheets = [];
    try {
      [folders, sheets] = await Promise.all([listFolders(id), listSheetsIn(id)]);
    } catch (e) { /* not a folder, then */ }

    if (!sheets.length && !folders.length) {
      const info = await fileInfo(id);
      if (info && info.mimeType !== 'application/vnd.google-apps.folder') {
        sheets = [{
          id: info.id,
          name: info.name,
          excel: info.mimeType !== 'application/vnd.google-apps.spreadsheet'
        }];
      }
    }

    res.json({ folders, sheets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/adv/tabs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const sheetId = req.query.sheetId;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tabs: await listTabs(sheetId, excel) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// open a tab: work out the columns and list every day in it
app.get('/api/adv/open', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const saved = await getSetting(realmId, 'adv:cols', null);
    const d = await loadAdvance(sheetId, tab, excel, saved);

    res.json({
      header: d.header,
      cols: d.cols,
      remembered: !!saved,
      headerRow: d.headerRow,
      rowCount: d.rows.length,
      days: d.days
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// forget the saved columns, so the page asks for them again
app.post('/api/adv/columns-reset', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    await setSetting(realmId, 'adv:cols', null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/adv/columns', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const cols = req.body.cols;
  if (!cols) return res.status(400).json({ error: 'cols required' });

  try {
    await setSetting(realmId, 'adv:cols', cols);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Which QuickBooks account each bank name in the sheet stands for. Asked once
// per name, then remembered - a name that turns up later is asked about then.
app.get('/api/adv/banks', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ banks: await getSetting(realmId, 'adv:banks', {}) || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/adv/banks', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const pairs = req.body.banks || {};
  try {
    const all = (await getSetting(realmId, 'adv:banks', {})) || {};
    Object.keys(pairs).forEach(name => {
      const v = pairs[name];
      if (v) all[name] = String(v); else delete all[name];
    });
    await setSetting(realmId, 'adv:banks', all);
    res.json({ ok: true, banks: all });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// the rows in a chosen span, matched against QuickBooks
// Sort advance rows against QuickBooks.
//
// One rule for both ways into this page: the month's days, and a pasted list of
// order numbers found anywhere in the sheet. A row already marked posted in the
// sheet is left alone, nothing is handed over for more than the invoice still
// owes, and nothing goes at all until we know which bank the row's own words
// name - that is what "needs bank" means.
async function advanceBuckets(realmId, rows) {
  const token = await getAccessToken(realmId);
  const found = await findForAdvance(realmId, token, rows.map(r => r.invoice));

  // every bank name the sheet uses, and what it was mapped to last time
  const bankMap = (await getSetting(realmId, 'adv:banks', {})) || {};
  const seenBanks = new Map();
  rows.forEach(r => {
    const b = String(r.bank || '').trim();
    if (!b) return;
    seenBanks.set(b, (seenBanks.get(b) || 0) + 1);
  });

  const ready = [], overpaid = [], settled = [], notInQb = [],
        needsBank = [], alreadyPosted = [];

  rows.forEach(r => {
    // where the rows came from several tabs at once, each one remembers its
    // own, so the sheet is marked in the right place afterwards
    const where = { sheetId: r.sheetId || null, tab: r.tab || null, sheetName: r.sheetName || '' };

    if (r.posted) {
      alreadyPosted.push(Object.assign({
        sheetRow: r.sheetRow, date: r.date, invoice: r.invoice,
        amount: r.amount, bank: r.bank || '', posted: r.posted
      }, where));
      return;
    }

    const inv = found.get(cprDigits(r.invoice));
    if (!inv) { notInQb.push(Object.assign({}, r, where)); return; }

    const entry = Object.assign({
      sheetRow: r.sheetRow,
      date: r.date,
      invoice: r.invoice,
      amount: r.amount,
      payable: r.payable,
      name: r.name,
      qbDoc: inv.doc,
      qbId: inv.id,
      qbTotal: inv.total,
      qbBalance: inv.balance,
      customerId: inv.customerId,
      customerName: inv.customerName,
      bank: String(r.bank || '').trim(),
      accountId: bankMap[String(r.bank || '').trim()] || null
    }, where);

    if (inv.balance <= 0.005) { settled.push(entry); return; }

    // never hand QuickBooks more than the invoice still owes
    if (r.amount > inv.balance + 0.005) {
      entry.willPay = Math.round(inv.balance * 100) / 100;
      overpaid.push(entry);
      return;
    }

    entry.willPay = Math.round(r.amount * 100) / 100;

    // nothing goes to QuickBooks until we know which account it lands in
    if (!entry.accountId) { needsBank.push(entry); return; }
    ready.push(entry);
  });

  const byCustomer = new Map();
  ready.forEach(m => {
    const k = m.customerId || 'none';
    if (!byCustomer.has(k)) {
      byCustomer.set(k, { customerId: m.customerId, customerName: m.customerName, count: 0, amount: 0 });
    }
    const g = byCustomer.get(k);
    g.count++;
    g.amount += m.willPay;
  });

  return {
    totals: {
      rows: rows.length,
      ready: ready.length,
      overpaid: overpaid.length,
      settled: settled.length,
      notInQb: notInQb.length,
      needsBank: needsBank.length,
      alreadyPosted: alreadyPosted.length,
      amount: Math.round(ready.reduce((t, m) => t + m.willPay, 0) * 100) / 100
    },
    customers: [...byCustomer.values()].map(g => ({
      customerId: g.customerId,
      customerName: g.customerName,
      count: g.count,
      amount: Math.round(g.amount * 100) / 100
    })),
    banks: [...seenBanks.entries()].map(([name, count]) => ({
      name, count, accountId: bankMap[name] || null
    })),
    ready, overpaid, settled, notInQb, needsBank, alreadyPosted
  };
}

app.get('/api/adv/match', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, from, to } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const saved = await getSetting(realmId, 'adv:cols', null);
    const d = await loadAdvance(sheetId, tab, excel, saved);

    const rows = d.rows.filter(r => r.date && r.date >= from && r.date <= to);
    if (!rows.length) return res.status(400).json({ error: 'No paid rows in that range' });

    const sorted = await advanceBuckets(realmId, rows);

    res.json(Object.assign({ from, to, label: spanLabel(from, to) }, sorted));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Look up what QuickBooks actually did with a set of advance rows: which
// payments are sitting on each invoice, how much, and into which account.
// Works just as well on payments that were entered by hand.
// ---- the advance sheet read backwards: here are the orders, find their rows ----
//
// The page above picks a month and reads the days. This takes a pasted list of
// order numbers and looks for their rows wherever they were written - any
// workbook in the folder, any month's tab - and then sorts what it found
// against QuickBooks exactly as a day's rows are sorted, so the same Receive
// below it does the rest.
app.post('/api/adv/find-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const cols = await getSetting(realmId, 'adv:cols', null);
    const id = startAdvFind(req.desk, {
      numbers: req.body.numbers,
      books: req.body.books,
      cols
    });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/adv/find-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = advFindSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/adv/find-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopAdvFind(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/adv/find-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endAdvFind(req.desk) });
});


app.post('/api/adv/find-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeAdvFind(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/adv/find-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearAdvFind(req.desk);
  if (!ok) return res.status(409).json({ error: 'The search is still going' });
  res.json({ ok: true });
});

// the rows the search found, sorted against QuickBooks - nothing is written
app.post('/api/adv/find-match', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to check' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const sorted = await advanceBuckets(realmId, rows);
    // which column says a row has been posted - the page needs it to mark the
    // rows afterwards, and in this way in it never went through the tab picker
    const cols = (await getSetting(realmId, 'adv:cols', null)) || {};
    res.json(Object.assign({
      from: null, to: null,
      label: req.body.label || 'a pasted list',
      postedCol: cols.posted === undefined ? -1 : cols.posted
    }, sorted));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/adv/recheck', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to check' });

  try {
    const token = await getAccessToken(realmId);
    const bankMap = (await getSetting(realmId, 'adv:banks', {})) || {};

    const found = await findForAdvance(realmId, token, rows.map(r => r.invoice));

    // every payment sitting on those invoices, by invoice id
    const invIds = [];
    found.forEach(inv => invIds.push(String(inv.id)));
    // The invoice tells us which payments are on it; asking QuickBooks for a
    // payment by a field inside its lines does not work, so we go the other way.
    const wantIds = [];
    found.forEach(inv => (inv.paymentIds || []).forEach(id => wantIds.push(String(id))));
    const uniq = [...new Set(wantIds)];

    const payById = new Map();
    for (let i = 0; i < uniq.length; i += 30) {
      const chunk = uniq.slice(i, i + 30).map(x => `'${x}'`).join(',');
      let q;
      try {
        q = await qbQuery(realmId, token,
          `SELECT Id, TxnDate, TotalAmt, DepositToAccountRef, Line ` +
          `FROM Payment WHERE Id IN (${chunk}) MAXRESULTS 1000`);
      } catch (e) { continue; }

      (q.Payment || []).forEach(p => payById.set(String(p.Id), p));
    }

    const byInvoice = new Map();
    found.forEach(inv => {
      const list = [];
      (inv.paymentIds || []).forEach(id => {
        const p = payById.get(String(id));
        if (!p) return;

        // how much of that payment landed on this invoice
        let mine = 0, lines = 0;
        (p.Line || []).forEach(l => {
          (l.LinkedTxn || []).forEach(t => {
            if (t.TxnType !== 'Invoice') return;
            lines++;
            if (String(t.TxnId) === String(inv.id)) mine += Number(l.Amount || 0);
          });
        });

        list.push({
          id: String(p.Id),
          date: p.TxnDate || '',
          amount: mine || Number(p.TotalAmt || 0),
          total: Number(p.TotalAmt || 0),
          accountId: p.DepositToAccountRef ? String(p.DepositToAccountRef.value) : '',
          accountName: p.DepositToAccountRef ? (p.DepositToAccountRef.name || '') : '',
          shared: lines > 1
        });
      });
      byInvoice.set(String(inv.id), list);
    });
    const out = rows.map(r => {
      const inv = found.get(cprDigits(r.invoice));
      if (!inv) {
        return { sheetRow: r.sheetRow, invoice: r.invoice, sheetAmount: r.amount,
                 bank: r.bank || '', verdict: 'notInQb', payments: [], advance: [] };
      }

      const pays = byInvoice.get(String(inv.id)) || [];
      const want = Math.round(Number(r.amount || 0) * 100) / 100;
      const wantAcct = bankMap[String(r.bank || '').trim()] || null;
      const near = (a, b) => Math.abs(a - b) < 1;

      // The CPR settlement lands on the same invoice, so not every payment here
      // is an advance. The advance is the one - or the few together - that come
      // to what the sheet says.
      let advance = pays.filter(p => near(p.amount, want));

      if (!advance.length && want > 0) {
        // an advance paid in two goes, written up as one figure in the sheet
        const small = pays.filter(p => p.amount < want + 1)
                          .sort((a, b) => a.amount - b.amount);
        const take = [];
        let sum = 0;
        for (const p of small) {
          if (sum + p.amount > want + 1) continue;
          take.push(p);
          sum += p.amount;
          if (near(sum, want)) break;
        }
        if (near(sum, want) && take.length) advance = take;
      }

      const notes = [];
      let dup = [];

      if (!advance.length) {
        notes.push('No advance payment of ' + want.toFixed(2) + ' on this invoice');
      } else if (advance.length > 1 && advance.every(p => near(p.amount, want))) {
        // the same figure more than once is the sheet's advance paid twice
        dup = advance.slice(1);
        notes.push('Received ' + advance.length + ' times \u2014 ' +
                   (advance.length - 1) + ' to remove');
      }

      if (advance.length && wantAcct) {
        const wrong = advance.filter(p => p.accountId && p.accountId !== String(wantAcct));
        if (wrong.length) {
          notes.push('In ' + [...new Set(wrong.map(p => p.accountName || p.accountId))].join(', ') +
                     ', not ' + (r.bank || 'the bank the sheet names'));
        }
      }

      return {
        sheetRow: r.sheetRow,
        invoice: r.invoice,
        qbDoc: inv.doc,
        qbId: inv.id,
        sheetAmount: want,
        bank: r.bank || '',
        wantAccountId: wantAcct,
        balance: inv.balance,
        advance,                                    // the advance payments only
        dup: dup.map(p => p.id),                    // the extra copies, if any
        others: pays.filter(p => !advance.includes(p)).length,
        verdict: notes.length ? 'off' : 'ok',
        notes
      };
    });
    res.json({
      checked: out.length,
      ok: out.filter(x => x.verdict === 'ok').length,
      off: out.filter(x => x.verdict !== 'ok').length,
      rows: out
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// The sheet says an advance was taken but QuickBooks has no payment for it.
// This puts that one payment in, on its own, into the bank the sheet names.
app.post('/api/adv/receive-one', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { qbId, amount, accountId, txnDate, methodId, memo } = req.body;
  if (!qbId || !accountId) return res.status(400).json({ error: 'qbId and accountId required' });

  const amt = Math.round(Number(amount || 0) * 100) / 100;
  if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be more than zero' });

  try {
    const token = await getAccessToken(realmId);

    const q = await qbQuery(realmId, token,
      `SELECT Id, DocNumber, Balance, CustomerRef FROM Invoice WHERE Id = '${qbId}'`);
    const inv = (q.Invoice || [])[0];
    if (!inv) return res.status(404).json({ error: 'That invoice is not in QuickBooks any more' });

    const owed = Number(inv.Balance || 0);
    if (owed <= 0.005) {
      return res.status(400).json({ error: 'That invoice is already settled' });
    }

    // never hand QuickBooks more than the invoice still owes
    const pay = Math.min(amt, Math.round(owed * 100) / 100);

    const payload = {
      CustomerRef: inv.CustomerRef,
      TotalAmt: pay,
      DepositToAccountRef: { value: String(accountId) },
      PrivateNote: memo || 'Advance payment',
      Line: [{
        Amount: pay,
        LinkedTxn: [{ TxnId: String(inv.Id), TxnType: 'Invoice' }]
      }]
    };
    if (txnDate) payload.TxnDate = txnDate;
    if (methodId) payload.PaymentMethodRef = { value: String(methodId) };

    const r = await postPayment(realmId, token, payload);
    if (!r.ok) return res.status(400).json({ error: r.msg });

    res.json({ ok: true, id: r.id, amount: pay, doc: inv.DocNumber || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Write the stamp against rows that were received properly but never marked,
// so the next run leaves them where they are.
app.post('/api/adv/mark-posted', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, postedCol, rows, stamp } = req.body;
  if (!sheetId || !tab || postedCol === undefined || postedCol < 0) {
    return res.status(400).json({ error: 'The sheet and its posted column are needed' });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'No rows to mark' });
  }

  try {
    const n = await stampRows(sheetId, tab, Number(postedCol),
                              rows.map(Number).filter(Boolean),
                              stamp || 'Posted by Rani');
    res.json({ ok: true, marked: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// move one payment into the right bank
app.post('/api/adv/fix-payment', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { paymentId, accountId } = req.body;
  if (!paymentId || !accountId) {
    return res.status(400).json({ error: 'paymentId and accountId required' });
  }

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Payment WHERE Id = '${paymentId}'`);
    const pay = (q.Payment || [])[0];
    if (!pay) return res.status(404).json({ error: 'That payment is not in QuickBooks any more' });

    const r = await fetch(`${API}/v3/company/${realmId}/payment?minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        Id: pay.Id, SyncToken: pay.SyncToken, sparse: true,
        DepositToAccountRef: { value: String(accountId) }
      })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true, id: pay.Id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// remove a payment that went in twice
app.post('/api/adv/delete-payment', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    const token = await getAccessToken(realmId);
    const q = await qbQuery(realmId, token, `SELECT * FROM Payment WHERE Id = '${paymentId}'`);
    const pay = (q.Payment || [])[0];
    if (!pay) return res.status(404).json({ error: 'That payment is not in QuickBooks any more' });

    const r = await fetch(`${API}/v3/company/${realmId}/payment?operation=delete&minorversion=70`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ Id: pay.Id, SyncToken: pay.SyncToken })
    });

    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const f = JSON.parse(text).Fault;
        if (f && f.Error && f.Error.length) msg = `${f.Error[0].Message} | ${f.Error[0].Detail || ''}`;
      } catch (e) {}
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true, id: pay.Id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// post the advance payments in the background
app.post('/api/adv/receive', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startAdvJob(req.desk, req.body);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/adv/receive-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = advSnapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/adv/receive-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopAdvJob(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/adv/receive-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endAdvJob(req.desk) });
});


app.post('/api/adv/receive-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeAdvJob(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/adv/receive-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearAdvJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The payment run is still going' });
  res.json({ ok: true });
});

// the bank used last time, so it comes up ready
app.get('/api/adv/last-bank', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ bank: await getSetting(realmId, 'adv:lastBank', null) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ==================== Void invoices ====================
// The return sheet lives in its own Drive folder, saved once per company
app.get('/api/void/sheet-root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ folderId: await getSetting(realmId, 'void:root', '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/void/sheet-root', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let id = String(req.body.folderId || '').trim();
  const m = id.match(/[-\w]{25,}/);
  if (m) id = m[0];
  if (!id) return res.status(400).json({ error: 'Folder ID or link required' });

  try {
    await setSetting(realmId, 'void:root', id);
    res.json({ ok: true, folderId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// what is in that folder
app.get('/api/void/sheets', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    res.setHeader('Cache-Control', 'no-store');
    const id = req.query.id || await getSetting(realmId, 'void:root', '');
    if (!id) return res.status(400).json({ error: 'Set the Drive folder first' });

    // people paste the workbook link as often as the folder link - take either
    let folders = [], sheets = [];
    try {
      [folders, sheets] = await Promise.all([listFolders(id), listSheetsIn(id)]);
    } catch (e) { /* not a folder, then */ }

    if (!sheets.length && !folders.length) {
      const info = await fileInfo(id);
      if (info && info.mimeType !== 'application/vnd.google-apps.folder') {
        sheets = [{
          id: info.id,
          name: info.name,
          excel: info.mimeType !== 'application/vnd.google-apps.spreadsheet'
        }];
      }
    }

    res.json({ folders, sheets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the tabs inside one workbook
app.get('/api/void/tabs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const sheetId = req.query.sheetId;
  const excel = req.query.excel === '1';
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tabs: await listTabs(sheetId, excel) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// every dated column on a tab, with how many order numbers sit under it
app.get('/api/void/days', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const d = await readDateColumns(sheetId, tab, excel);
    res.json({
      headerRow: d.headerRow,
      days: d.days.map(x => ({ date: x.date, label: x.label, count: x.count }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the order numbers for a chosen span of days
app.get('/api/void/numbers', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { sheetId, tab, from, to } = req.query;
  const excel = req.query.excel === '1';
  if (!sheetId || !tab) return res.status(400).json({ error: 'sheetId and tab required' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    const d = await readDateColumns(sheetId, tab, excel);

    const picked = d.days.filter(x => {
      if (from && x.date < from) return false;
      if (to && x.date > to) return false;
      return true;
    });

    const seen = new Set();
    const numbers = [];
    picked.forEach(day => day.numbers.forEach(n => {
      if (seen.has(n)) return;
      seen.add(n);
      numbers.push(n);
    }));

    res.json({
      days: picked.map(x => ({ date: x.date, label: x.label, count: x.count })),
      numbers,
      count: numbers.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Look the pasted numbers up in QuickBooks and sort them into buckets,
// so nothing is voided before you have seen what it is.
// Look the pasted numbers up in QuickBooks and sort them into buckets, so
// nothing is voided before you have seen what it is. It runs as a job, because
// a look-up started on the wrong list has to be stoppable at once.
app.post('/api/void/scan-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const id = startVoidScan(req.desk, req.body.numbers);
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/void/scan-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = voidScanSnapshot(req.desk, req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/void/scan-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopVoidScan(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/void/scan-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endVoidScan(req.desk) });
});


app.post('/api/void/scan-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeVoidScan(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/void/scan-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearVoidScan(req.desk);
  if (!ok) return res.status(409).json({ error: 'The look-up is still going' });
  res.json({ ok: true });
});

app.post('/api/void/start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { invoices, force = false, delay = 0 } = req.body;
  try {
    const id = startVoidJob(req.desk, { invoices, force, delay });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/void/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = voidSnapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/void/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopVoidJob(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/void/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endVoidJob(req.desk) });
});


app.post('/api/void/resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeVoidJob(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/void/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearVoidJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The void run is still going' });
  res.json({ ok: true });
});

// ---- the other way round: pasted invoice numbers, looked for in the sheet ----
// Nothing is written by any of these - the workbook is only read - so they are
// open to anybody who may see the page.
app.post('/api/void/check-start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const id = startSheetCheck(req.desk, {
      numbers: req.body.numbers,
      sheetId: req.body.sheetId,
      sheetName: req.body.sheetName,
      excel: !!req.body.excel,
      tabs: req.body.tabs,
      from: req.body.from,
      to: req.body.to
    });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/void/check-status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = sheetCheckSnapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/void/check-stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopSheetCheck(req.desk) });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/void/check-end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endSheetCheck(req.desk) });
});


app.post('/api/void/check-resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeSheetCheck(req.desk);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/void/check-clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearSheetCheck(req.desk);
  if (!ok) return res.status(409).json({ error: 'The return sheet check is still going' });
  res.json({ ok: true });
});
// ==================== Upload ====================
// Convert hands the list over here instead of squeezing it through the
// browser, so a run of any size makes it across.
const handovers = new Map();      // desk -> { invoices, at }

app.post('/api/upload/handover', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = req.body.invoices;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'No invoices were sent' });
  }

  handovers.set(req.desk, { invoices: list, at: Date.now() });

  // anything left lying about for a day is not coming back for it
  const cutoff = Date.now() - 24 * 3600 * 1000;
  handovers.forEach((v, k) => { if (v.at < cutoff) handovers.delete(k); });

  res.json({ ok: true, count: list.length });
});

app.get('/api/upload/handover', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const held = handovers.get(req.desk);
  if (!held) return res.json({ invoices: [] });

    // the page can be reloaded, or the server can restart mid-handover, so the
  // list stays put until an upload has actually been started with it
  if (req.query.drop === '1') handovers.delete(req.desk);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invoices: held.invoices, at: held.at });
});
// the work happens in a server-side job now, so leaving the page changes nothing

app.post('/api/upload/start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

 const { invoices, delay = 1000, negativeItems = [], batchSize = 30 } = req.body;
  if (!Array.isArray(invoices) || !invoices.length) {
    return res.status(400).json({ error: 'No invoices provided' });
  }

  try {
   const id = startJob(req.desk, { invoices, delay, negativeItems, batchSize });
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/upload/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
res.setHeader('Cache-Control', 'no-store');
  const snap = snapshot(req.desk, req.query.since || 0, req.query.full === '1');
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/upload/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopJob(req.desk) });
});
// Pause holds the run where it is; Resume carries on from the same place,
// so nothing already in QuickBooks is sent again.
app.post('/api/upload/pause', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: pauseJob(req.desk) });
});

app.post('/api/upload/resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ ok: true, jobId: resumeJob(req.desk) });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});
// End process: the run is over. Whatever has not been sent is dropped and the
// job is gone from the server, so no deploy or restart brings it back. The
// invoices already in QuickBooks stay where they are.
app.post('/api/upload/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const had = await endJob(req.desk);
  handovers.delete(req.desk);        // and the list Convert was holding for it
  res.json({ ok: true, had });
});

app.post('/api/upload/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const ok = clearJob(req.desk);
  if (!ok) return res.status(409).json({ error: 'The upload is still running' });
  res.json({ ok: true });
});

app.post('/api/upload/retry', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ ok: true, jobId: retryFailed(req.desk) });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// whatever has not been sent yet, back in QuickBooks import shape
app.get('/api/upload/remaining-file', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const list = remainingInvoices(req.desk);
  if (!list.length) return res.status(404).json({ error: 'Nothing left to send' });

  const HEADER = ['*InvoiceNo','*Customer','*InvoiceDate','*DueDate','Terms','Location','Memo',
    'Item(Product/Service)','ItemDescription','ItemQuantity','ItemRate','*ItemAmount','Service Date'];

  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const dmy = iso => {
    if (!iso) return '';
    const p = String(iso).split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
  };

  const rows = [HEADER.join(',')];
  list.forEach(inv => {
    inv.lines.forEach(l => {
      rows.push([
        inv.docNumber, inv.customer, dmy(inv.txnDate), dmy(inv.dueDate),
        inv.terms || '', '', inv.memo || '', l.item, l.desc || '',
        Number(l.qty).toFixed(2), Number(l.rate || l.amt).toFixed(2), Number(l.amt).toFixed(2),
        dmy(l.svc || inv.txnDate)
      ].map(cell).join(','));
    });
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="remaining-invoices-import.csv"');
  res.send('\uFEFF' + rows.join('\r\n') + '\r\n');
});
// ==================== Cash payment receipts, from the courier's portal ====
// New, and self-contained. Nothing above this line is involved: the older
// receipt pages read our own courier_orders table, these read PostEx itself.

import {
  refreshCprs, listCprs as listLiveCprs, cprDetail, forget as forgetCpr
} from './cprlive.js';
import { buildWorkbook, fileName as cprFileName } from './cprsheet.js';
import { setPortalLogin, clearPortalLogin, markCprReceived } from './couriers.js';
import { login as portalLogin } from './postexportal.js';
import { encrypt as encryptSecret } from './secrets.js';
import { deskKey } from './desk.js';
import {
  startAdvFind, stopAdvFind, resumeAdvFind, clearAdvFind, endAdvFind, advFindSnapshot
} from './advfind.js';
import {
  startVoidScan, stopVoidScan, resumeVoidScan, clearVoidScan, endVoidScan, voidScanSnapshot
} from './voidscan.js';
import { startRead, stopRead, resumeRead, clearRead, endRead, readSnapshot } from './reads.js';
import {
  KINDS as AUDIT_KINDS,
  parsePasted as parseAuditPasted, auditRead,
  getLinks as getAuditLinks, saveLink as saveAuditLink, dropLink as dropAuditLink,
  booksAt as auditBooksAt, tabTitles as auditTabTitles, savePick as saveAuditPick,
  headerOf as auditHeaderOf
} from './audit.js';

// Save (or replace) the portal sign-in for one courier account. The password
// is tried before it is kept, so a typo is caught here and not at midnight.
app.post('/api/receipts/login', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const id = Number(req.body.id);
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');

  if (!id) return res.status(400).json({ error: 'Which account?' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password both needed' });

  try {
    const acc = await getCourierAccount(realmId, id);
    if (!acc) return res.status(404).json({ error: 'No such account' });

    const who = await portalLogin(email, password);

    await setPortalLogin(realmId, id, {
      email,
      secret: encryptSecret(password),
      merchantId: who.merchantId
    });

    forgetCpr(id);

    res.json({
      ok: true,
      merchantId: who.merchantId,
      merchantName: who.merchantName
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/receipts/logout', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    await clearPortalLogin(realmId, Number(req.body.id));
    forgetCpr(Number(req.body.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the receipts themselves - asked from PostEx, then read back with the
// QuickBooks column alongside
app.get('/api/receipts/list', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { from, to, account } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    let asked = null;
    let trouble = null;

    if (account) {
      try {
        asked = await refreshCprs(realmId, Number(account), from, to);
      } catch (e) {
        // the list we already have is still worth showing
        trouble = e.message;
      }
    }

    res.json({
      cprs: await listLiveCprs(realmId, { account, from, to }),
      asked,
      trouble
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The few most recent receipts, read from our own table only. The dashboard
// uses this, so it must not wait on PostEx - the receipts page is where they
// get refreshed.
app.get('/api/receipts/recent', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { account, courier } = req.query;
  const limit = Math.min(Number(req.query.limit) || 6, 50);

  try {
    res.setHeader('Cache-Control', 'no-store');
    const all = await listLiveCprs(realmId, { account, courier });
    res.json({ cprs: all.slice(0, limit), total: all.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// everything inside one receipt, exactly as the portal shows it
app.get('/api/receipts/detail', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const account = Number(req.query.account);
  const remoteId = String(req.query.id || '').trim();
  if (!account || !remoteId) return res.status(400).json({ error: 'account and id both needed' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await cprDetail(realmId, account, remoteId, req.query.created, req.query.fresh === '1'));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- receiving a receipt into QuickBooks ---------- */

// Which bank a courier account's receipts are deposited into. Asked once and
// remembered per account, because two PostEx accounts can settle into two
// different banks - the older per-courier setting is the fallback so nothing
// already answered has to be answered again.
// A payment's total says nothing about which invoice it went on - one payment
// covers many. The lines do: each carries an amount and the invoice it paid.
// Without them a receipt can only be told "some other payment touched these",
// which is not enough to say how much of it was not yours.
async function paymentLines(realmId, token, paymentIds) {
  const ids = [...new Set((paymentIds || []).map(String).filter(Boolean))];
  const out = new Map();                       // payment id -> { ref, date, onInvoice }

  for (let i = 0; i < ids.length; i += 30) {
    const list = ids.slice(i, i + 30).map(x => `'${x}'`).join(',');

    let q;
    try {
      q = await qbQuery(realmId, token,
        `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, PrivateNote, ` +
        `DepositToAccountRef, Line FROM Payment ` +
        `WHERE Id IN (${list}) MAXRESULTS 1000`);
    } catch (e) { continue; }

    (q.Payment || []).forEach(p => {
      const onInvoice = new Map();

      (p.Line || []).forEach(l => {
        (l.LinkedTxn || []).forEach(t => {
          if (t.TxnType !== 'Invoice') return;
          const id = String(t.TxnId);
          onInvoice.set(id, (onInvoice.get(id) || 0) + Number(l.Amount || 0));
        });
      });

      out.set(String(p.Id), {
        id: String(p.Id),
        ref: String(p.PaymentRefNum || '').trim(),
        date: p.TxnDate || '',
        total: Number(p.TotalAmt || 0),
        memo: String(p.PrivateNote || '').trim(),
        bank: p.DepositToAccountRef ? (p.DepositToAccountRef.name || '') : '',
        onInvoice
      });
    });
  }

  return out;
}

// "CPR-6L4DB532992", "cpr 6l4db532992" and "6L4DB532992" are one receipt.
// Whoever typed it into QuickBooks first should not decide whether we can
// recognise it later.
function sameRef(a, b) {
  const bare = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CPR/, '');
  const x = bare(a), y = bare(b);
  return !!x && !!y && x === y;
}

async function bankFor(realmId, accountId, courier) {
  const perAccount = await getSetting(realmId, `cpr:bank:${accountId}`, null);
  if (perAccount) return perAccount;

  const prefs = (await getSetting(realmId, 'cpr:prefs', {})) || {};
  return courier ? (prefs[courier] || null) : null;
}

app.post('/api/receipts/bank', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const id = Number(req.body.id);
  const accountId = String(req.body.accountId || '').trim();
  if (!id || !accountId) return res.status(400).json({ error: 'Account and bank both needed' });

  try {
    await setSetting(realmId, `cpr:bank:${id}`, {
      accountId,
      methodId: req.body.methodId ? String(req.body.methodId) : null
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What this receipt looks like against QuickBooks: which of its orders have an
// invoice with something still owing, which have already been paid, and which
// are not there at all. Nothing is changed - this only reads.
app.get('/api/receipts/match', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const account = Number(req.query.account);
  const remoteId = String(req.query.id || '').trim();
  if (!account || !remoteId) return res.status(400).json({ error: 'account and id both needed' });

  try {
    res.setHeader('Cache-Control', 'no-store');

    const acc = await getCourierAccount(realmId, account);
    if (!acc) return res.status(404).json({ error: 'No such account' });

    const detail = await cprDetail(realmId, account, remoteId, req.query.created, false);
    const token = await getAccessToken(realmId);

    // A returned parcel is in the receipt but no money came with it, so there
    // is nothing to receive against its invoice.
    const paying = (detail.orders || []).filter(o => o.received > 0.005 && o.orderRef);

    const found = await findInvoices(realmId, token, paying.map(o => o.orderRef));

    const matched = [], alreadyPaid = [], missing = [], mismatched = [];
    const heldBack = [];       // matched, but the amounts do not agree

    paying.forEach(o => {
      const inv = found.get(cprDigits(o.orderRef));

      if (!inv) { missing.push({ ...o, why: 'not in QuickBooks' }); return; }

      if (inv.balance <= 0.005) {
        alreadyPaid.push({ ...o, qbDoc: inv.doc, qbId: inv.id, qbTotal: inv.total,
                           paymentIds: inv.paymentIds || [], why: 'already paid' });
        return;
      }

      const line = {
        invoice: o.orderRef,
        qbId: inv.id,
        qbDoc: inv.doc,
        qbBalance: inv.balance,
        qbTotal: inv.total,
        customerId: inv.customerId,
        customerName: inv.customerName,
        courierAmount: o.received,
        tracking: o.tracking,
        city: o.city
      };

      // A payment settles the balance QuickBooks is owed, not what the courier
      // handed over. Where those disagree, posting it marks the invoice paid
      // and buries the difference in the receipt's total - so it is held back
      // instead. The invoice can be corrected and the receipt run again.
      const gap = Math.round((o.received - inv.balance) * 100) / 100;

      if (Math.abs(gap) > 1) {
        heldBack.push(line);
        mismatched.push({
          ...o,
          qbDoc: inv.doc,
          qbBalance: inv.balance,
          qbTotal: inv.total,
          unexplained: Math.abs(gap),
          why: `QuickBooks is owed ${inv.balance.toFixed(2)} but the courier ` +
               `collected ${o.received.toFixed(2)} - ` +
               (gap > 0 ? `${gap.toFixed(2)} more` : `${Math.abs(gap).toFixed(2)} less`) +
               '. Held back until the invoice is put right.'
        });
      } else {
        matched.push(line);
      }
    });

    const [accounts, methods] = await Promise.all([
      listAccounts(realmId, token),
      listPaymentMethods(realmId, token)
    ]);

    const r2 = v => Math.round(v * 100) / 100;

    // An invoice with nothing owing was settled by something. A payment's
    // total says nothing about which invoice it went on - one payment covers
    // many, across several receipts - so the payment's lines are read and only
    // the part sitting on these invoices is counted.
    let paidBy = [];
    const offBy = [];        // this receipt did not settle what the courier collected
    const settled = [];      // an advance was involved, and everything still adds up

    if (alreadyPaid.length) {
      const ids = [];
      alreadyPaid.forEach(o => (o.paymentIds || []).forEach(id => ids.push(id)));

      try {
        const pays = await paymentLines(realmId, token, ids.slice(0, 500));
        const byRef = new Map();

        alreadyPaid.forEach(o => {
          let here = 0, other = 0;
          const otherRefs = [], from = [];

          (o.paymentIds || []).forEach(id => {
            const p = pays.get(String(id));
            if (!p) return;

            const part = p.onInvoice.get(String(o.qbId)) || 0;
            if (!part) return;

            const key = p.ref || '(no reference)';
            const mine = sameRef(p.ref, req.query.cpr);

            if (!byRef.has(key)) {
              byRef.set(key, { ref: key, count: 0, amount: 0, dates: [], mine,
                               banks: [], memos: [] });
            }
            const g = byRef.get(key);
            g.count++;
            g.amount += part;
            if (p.date && g.dates.indexOf(p.date) < 0) g.dates.push(p.date);
            if (p.bank && g.banks.indexOf(p.bank) < 0) g.banks.push(p.bank);
            if (p.memo && g.memos.indexOf(p.memo) < 0) g.memos.push(p.memo);

            if (mine) {
              here += part;
            } else {
              other += part;
              if (otherRefs.indexOf(key) < 0) otherRefs.push(key);
              from.push({ ref: p.ref, amount: r2(part), date: p.date,
                          bank: p.bank, memo: p.memo });
            }
          });

          o.paidHereAmount = r2(here);
          o.paidElseAmount = r2(other);
          o.paidHere = here > 0.005;

          // Money this receipt collected that arrived under someone else's
          // name - the whole invoice, or part of it, as when an advance was
          // taken before the parcel was delivered.
          // An invoice is right if it was raised for what the courier
          // collected, or for that plus an advance the customer had already
          // paid. Either way it settles and nothing is owed. Anything the
          // advance does not account for is an invoice raised for the wrong
          // figure, and that is the only thing worth chasing.
          const qbGap = r2((o.qbTotal || 0) - o.received);
          const unexplained = r2(Math.abs(qbGap) - other);

          o.advance = r2(other);
          o.qbGap = qbGap;
          o.unexplained = unexplained > 0 ? unexplained : 0;

          const say = from.map(f => {
            const bits = [];
            if (f.ref) bits.push(f.ref);
            if (f.bank) bits.push(f.bank);
            if (f.memo) bits.push('“' + f.memo.replace(/\s+/g, ' ') + '”');
            if (f.date) bits.push(f.date);
            return f.amount.toFixed(2) + (bits.length ? ' from ' + bits.join(' · ') : '');
          });

          o.paidFrom = from;

          if (unexplained > 1) {
            offBy.push({
              ...o,
              why: `the courier collected ${o.received.toFixed(2)} but the ` +
                   `invoice was raised at ${(o.qbTotal || 0).toFixed(2)}` +
                   (other > 0.005
                      ? `, and only ${other.toFixed(2)} of that is the advance` : '') +
                   `. ${unexplained.toFixed(2)} is unaccounted for` +
                   (say.length ? ` (${say.join('; ')})` : '')
            });
          } else if (other > 0.005) {
            settled.push({
              ...o,
              why: 'settled in full: ' + r2(here).toFixed(2) + ' from this receipt' +
                   (say.length ? ', ' + say.join('; ') : '')
            });
          }

        });

        paidBy = [...byRef.values()]
          .map(g => ({ ...g, amount: r2(g.amount) }))
          .sort((a, b) => b.amount - a.amount);
      } catch (e) { /* the panel is still useful without it */ }
    }

    res.json({
      cpr: req.query.cpr || remoteId,
      cprDate: (req.query.created || '').slice(0, 10),
      account: acc.label,
      matched,
      heldBack,
      alreadyPaid,
      settled,
      missing,
      // everything with something wrong with it, in one list, each saying what
      problems: [].concat(
        // nothing in QuickBooks at all - the whole amount is at stake
        missing.map(o => ({ ...o, kind: 'no invoice', impact: o.received })),

        // an advance, usually - what is at stake is the part that came from
        // somewhere other than this receipt
        // the receipt did not settle what the courier collected
        offBy.map(o => ({
          ...o, kind: 'amount differs', impact: o.unexplained || 0
        })),

        // the invoice was raised for a different figure than the courier
        // collected, so the two sides never could have met
        mismatched.map(o => ({
          ...o, kind: 'amount differs',
          impact: r2(Math.abs(o.received - (o.qbBalance || 0)))
        }))
      ),
      // Two different denominators were being shown side by side: 464 orders
      // on the receipt against 390 already paid, which is out of the 390 that
      // carried money at all. Both, and everything between them, spelled out.
      counts: {
        orders:      (detail.orders || []).length,
        noMoney:     (detail.orders || []).length - paying.length,
        withMoney:   paying.length,
        ready:       matched.length,
        heldBack:    heldBack.length,
        alreadyPaid: alreadyPaid.length,
        missing:     missing.length,
        differs:     offBy.length + mismatched.length,
        settled:     settled.length
      },
      totals: {
        courier:  r2(paying.reduce((s, o) => s + o.received, 0)),
        noMoney:  r2((detail.orders || [])
                      .filter(o => !(o.received > 0.005))
                      .reduce((s, o) => s + o.amount, 0)),
        toReceive: r2(matched.reduce((s, m) => s + m.qbBalance, 0)),
        heldBack:  r2(heldBack.reduce((s, m) => s + m.qbBalance, 0)),
        paidAlready: r2(alreadyPaid.reduce((s, o) => s + o.received, 0)),
        paidHere: r2(alreadyPaid.reduce((s, o) => s + (o.paidHereAmount || 0), 0)),
        settled: r2(settled.reduce((s, o) => s + (o.advance || 0), 0)),
        settledCount: settled.length,
        missing: r2(missing.reduce((s, o) => s + o.received, 0)),
        mismatched: r2(mismatched.reduce((s, o) => s + o.received, 0)),
        net: detail.summary ? detail.summary.netAmount : 0
      },
      banks: accounts,
      methods,
      paidBy,
      chosen: await bankFor(realmId, account, acc.courier)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Hand the matched invoices to the payment engine the sheet-based page
// already uses - one payment per customer, the receipt's own date on it and
// its number as the reference, halving the batch if QuickBooks baulks.
app.post('/api/receipts/receive', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const { id, cpr, cprDate, accountId, methodId, matched, remember } = req.body;

  if (!accountId) return res.status(400).json({ error: 'Pick the bank the money went into' });
  if (!Array.isArray(matched) || !matched.length) {
    return res.status(400).json({ error: 'Nothing to receive' });
  }

  try {
    if (remember !== false && id) {
      await setSetting(realmId, `cpr:bank:${id}`, {
        accountId: String(accountId),
        methodId: methodId ? String(methodId) : null
      });
    }

    const jobId = startPayJob(req.desk, {
      courier: 'postex',
      cprNumber: cpr,
      cprDate,
      accountId,
      methodId: methodId || null,
      matched,
      writeStatus: false          // there is no sheet to stamp - this came from the portal
    });

    res.json({ ok: true, id: jobId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A receipt received into QuickBooks before this page knew how to say so -
// or through the older sheet page - is still received. QuickBooks holds the
// proof: the payment carries the receipt's number as its reference. This
// finds those and stamps them, rather than making anyone receive twice.
app.get('/api/receipts/check', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const account = Number(req.query.account);
  const { from, to } = req.query;
  if (!account || !from || !to) {
    return res.status(400).json({ error: 'account and a date range are needed' });
  }

  try {
    res.setHeader('Cache-Control', 'no-store');

    const token = await getAccessToken(realmId);

    // a receipt dated the 1st is usually paid within days, not the same hour
    const wide = d => {
      const x = new Date(d + 'T00:00:00Z');
      x.setUTCDate(x.getUTCDate() + 45);
      return x.toISOString().slice(0, 10);
    };

    const byRef = await paymentsByCpr(realmId, token, from, wide(to));
    const list = await listLiveCprs(realmId, { account, from, to });

    let stamped = 0;
    const found = [];

    for (const c of list) {
      if (c.qbPaymentId) continue;              // already known about

      let hit = byRef.get(c.cpr);
      if (!hit) {
        for (const [ref, g] of byRef) {
          if (sameRef(ref, c.cpr)) { hit = g; break; }
        }
      }
      if (!hit || !hit.amount) continue;

      const amount = Math.round(hit.amount * 100) / 100;

      await markCprReceived(realmId, account, c.cpr, {
        qbPaymentId: hit.ids && hit.ids.length ? String(hit.ids[0]) : 'found',
        expected: c.codAmount == null ? null : c.codAmount,
        received: amount
      });

      stamped++;
      found.push({ cpr: c.cpr, amount, payments: hit.count });
    }

    res.json({ stamped, found });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A parcel settled under a different receipt cannot be received again - the
// invoice has nothing owing. The sheet page answers this by copying the
// invoice under a "-D" number so the second settlement has something of its
// own to pay, and this does the same. The copy keeps the original's date,
// customer and lines, so it ages and reports the same way; only the number
// differs. There is no sheet here to rename, which is the only part left out.
app.post('/api/receipts/duplicate', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const invoiceId = String(req.body.invoiceId || '').trim();
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

  try {
    const token = await getAccessToken(realmId);
    const made = await copyInvoice(realmId, token, invoiceId, '-D');
    res.json({ ok: true, invoice: made });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stamped once the money is in, so the receipt is never taken twice.
app.post('/api/receipts/mark', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const id = Number(req.body.id);
  const cpr = String(req.body.cpr || '').trim();
  if (!id || !cpr) return res.status(400).json({ error: 'account and cpr both needed' });

  try {
    await markCprReceived(realmId, id, cpr, {
      qbPaymentId: req.body.qbPaymentId || null,
      expected: req.body.expected,
      received: req.body.received,
      add: req.body.add === true
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// the same receipt as a workbook
app.get('/api/receipts/export', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  const account = Number(req.query.account);
  const remoteId = String(req.query.id || '').trim();
  if (!account || !remoteId) return res.status(400).json({ error: 'account and id both needed' });

  try {
    const detail = await cprDetail(realmId, account, remoteId, req.query.created, false);

    const cpr = {
      cpr: String(req.query.cpr || remoteId),
      status: req.query.status || '',
      createdOn: req.query.created || '',
      approvedOn: req.query.approved || ''
    };

    const buf = buildWorkbook(cpr, detail);

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + cprFileName(cpr) + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== Product health ====================
//
// One read of the books, held in memory, that every tab of the products page is
// drawn from: the items themselves, what they sold and what that cost, what the
// stock is worth, and what was bought. Reading it is a minute's work, so it is
// read once and asked of many times.

const prodStore = new Map();       // desk -> { scan, rows, summary, from, to, at }

const prodRound = n => Math.round(n * 100) / 100;

app.post('/api/products/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const { from, to } = req.body || {};
    if (!from || !to) throw new Error('Give the dates to look between');
    if (from > to) throw new Error('The first date is after the last one');

    const old = prodStore.get(req.desk);
    if (old && old.scan && old.scan.running) throw new Error('A read is still running');

    const scan = {
      running: true, step: 'the items', items: 0, read: 0,
      from, to, started: Date.now(), error: null
    };
    const st = { scan, rows: [], summary: null, from, to, at: Date.now() };
    prodStore.set(req.desk, st);

    (async () => {
      const token = await getAccessToken(realmId);
      const halt = () => { if (scan.stop) throw new Error('stopped'); };

      scan.step = 'the items';
      const items = await readItems(realmId, token, s => { halt(); scan.items = s.items; });
      halt();

      scan.step = 'what sold, and what it cost';
      const sales = await readItemSales(realmId, token, from, to);
      halt();

      scan.step = 'what the stock is worth';
      const valuation = await readValuation(realmId, token, to);
      halt();

      scan.step = 'what was bought';
      const purchases = await readPurchases(realmId, token, from, to,
        s => { halt(); scan.read = s.read; });

      st.rows = buildProductRows(items, sales.by, valuation.by, purchases.by);
      st.summary = summariseProducts(st.rows);
      st.columns = { sales: sales.columns, valuation: valuation.columns };
      st.at = Date.now();
      scan.running = false;
      scan.finished = Date.now();
    })().catch(e => {
      scan.running = false;
      scan.stopped = e.message === 'stopped';
      scan.error = scan.stopped ? null : e.message;
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/products/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  res.setHeader('Cache-Control', 'no-store');
  const st = prodStore.get(req.desk);
  if (!st) return res.json({ has: false });

  res.json({
    has: true,
    from: st.from, to: st.to,
    summary: st.summary,
    columns: st.columns || null,
    scan: {
      running: st.scan.running, step: st.scan.step, items: st.scan.items,
      read: st.scan.read, stopped: !!st.scan.stopped, error: st.scan.error || null
    },
    job: st.job ? {
      running: st.job.running, field: st.job.field, done: st.job.done,
      failed: st.job.failed, total: st.job.total,
      left: Math.max(0, st.job.total - st.job.okIds.size),
      error: st.job.error || null, log: st.job.log.slice(-80)
    } : null
  });
});

// One tab's worth of the read: the rows carrying a flag, narrowed by what was
// typed, biggest trouble first. The whole list is never sent - five thousand
// items with their twins is not something a page should be handed.
app.get('/api/products/rows', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  res.setHeader('Cache-Control', 'no-store');
  const st = prodStore.get(req.desk);
  if (!st) return res.json({ rows: [], total: 0 });

  const flag = String(req.query.flag || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 300, 5000);
  const sortBy = String(req.query.sort || '');
  const active = req.query.active || '';

  let rows = st.rows;
  if (flag && flag !== 'all') rows = rows.filter(r => r.flags.includes(flag));
  if (active === 'yes') rows = rows.filter(r => r.active);
  if (active === 'no') rows = rows.filter(r => !r.active);
  if (q) rows = rows.filter(r =>
    (r.name || '').toLowerCase().indexOf(q) > -1 ||
    (r.sku || '').toLowerCase().indexOf(q) > -1);

  const by = {
    sold:   (a, b) => b.soldAmount - a.soldAmount,
    qty:    (a, b) => a.qty - b.qty,
    name:   (a, b) => (a.name || '').localeCompare(b.name || ''),
    cost:   (a, b) => (a.cost || 0) - (b.cost || 0)
  }[sortBy] || ((a, b) => b.soldAmount - a.soldAmount || (a.name || '').localeCompare(b.name || ''));

  const sorted = rows.slice().sort(by);

  res.json({
    total: rows.length,
    shown: Math.min(sorted.length, limit),
    rows: sorted.slice(0, limit)
  });
});

// A pasted column of SKUs or product names, found in the read. Ticking three
// thousand boxes by hand is not a way to work; a column copied out of a sheet is.
//
// Each pasted line is matched whole - on the SKU, on the name, or on the name
// with its bracketed SKU taken off - and never on part of a name, because
// "Lip Tint" is inside forty other products and a wrong match here puts the
// wrong item away. What is found on this tab comes back to be ticked; what is in
// the books but not on this tab, and what is not in the books at all, come back
// named, so nothing pasted goes quietly missing.
app.post('/api/products/paste', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = prodStore.get(req.desk);
    if (!st || !st.rows.length) throw new Error('Read the books first');

    const flag = String((req.body || {}).flag || '');
    const lines = String((req.body || {}).text || '')
      .split(/[\r\n\t]+/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Paste at least one SKU or product name');
    if (lines.length > 10000) throw new Error('That is more than ten thousand lines - paste it in parts');

    // every way an item can be named, pointing back at it
    const index = new Map();
    const add = (k, row) => {
      if (!k) return;
      if (!index.has(k)) index.set(k, []);
      if (index.get(k).indexOf(row) < 0) index.get(k).push(row);
    };
    st.rows.forEach(r => {
      add(productKey(r.sku), r);
      add(productKey(r.name), r);
      // "18 Color Lipstick Kit B-3(7301-006MB-3)" is also "18 Color Lipstick Kit B-3"
      add(productKey(String(r.name || '').replace(/\([^)]*\)\s*$/, '')), r);
    });

    const onTab = r => !flag || flag === 'all' || r.flags.includes(flag);
    const found = new Map(), elsewhere = [], missing = [];

    lines.forEach(raw => {
      const hits = index.get(productKey(raw)) || [];
      if (!hits.length) { missing.push(raw); return; }

      const here = hits.filter(onTab);
      here.forEach(r => found.set(r.id, r));
      if (!here.length) {
        elsewhere.push({
          pasted: raw,
          items: hits.map(r => ({ name: r.name, sku: r.sku, qty: r.qty, active: r.active, flags: r.flags }))
        });
      }
    });

    res.json({
      pasted: lines.length,
      rows: Array.from(found.values()),
      elsewhere,
      missing
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/products/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = prodStore.get(req.desk);
  if (st && st.scan && st.scan.running) return res.status(400).json({ error: 'A read is still running' });
  prodStore.delete(req.desk);
  res.json({ ok: true });
});

// Putting a cost on the items that never had one.
//
// The cost on an item is not what a sale already carried - QuickBooks works that
// out from the bills, and nothing typed here changes a sale that has happened.
// What it does change is everything from here on: a bill opens at the right
// rate, and a report that reads the item rather than the ledger stops saying
// nothing at all. What was already sold at no cost is put right by the purchases
// behind it, not by this.
//
// One item per request, the way every other run in this app works, with what was
// done written down as it goes.
async function runProductJob(realmId, st, job) {
  let token = await getAccessToken(realmId);

  // an item counts as done once it went through, so a carry-on skips it
  let lastOne = null, lastOk = 0;
  const settle = () => {
    if (lastOne && (job.done - job.failed) > lastOk) job.okIds.add(lastOne.id);
  };

  for (const one of job.items) {
    settle();
    if (job.stop) break;
    if (job.okIds.has(one.id)) continue;
    lastOne = one;
    lastOk = job.done - job.failed;

    const row = st.rows.filter(r => r.id === one.id)[0] || { id: one.id, name: '', sku: '' };

    try {
      let patch = null;
      let was = '';
      let now = '';

      if (job.field === 'cost') {
        const cost = Number(one.value);
        if (!(cost > 0)) throw new Error('A cost has to be more than nothing');
        patch = { PurchaseCost: cost };
        was = row.cost === null || row.cost === undefined ? '' : row.cost;
        now = cost;
      } else if (job.field === 'active') {
        // an item holding stock is not switched off here: QuickBooks answers that
        // by writing its own adjustment, which moves cost of sales on a date
        // nobody chose
        if (Number(row.qty || 0) !== 0) {
          throw new Error('This one still holds ' + row.qty + ' in stock - put the stock right first');
        }
        patch = { Active: false };
        was = 'in use';
        now = 'put away';
      } else if (job.field === 'merge') {
        // Two items that are one product, made into one - in this order, and each
        // step said as it goes so the row shows what moved and what did not:
        //
        //   1. every bill, expense, order and vendor credit found on the item going
        //      is put onto the item kept - which moves the stock and the cost those
        //      bills brought in, so QuickBooks works cost of sales out of them
        //   2. what stock the item going still reads is carried across
        //   3. the cost goes with it where the one kept has none
        //   4. the item going is put away - but only once nothing is left on it,
        //      so a half-done merge is never hidden behind a switched-off item
        //
        // The invoices already written stay where they are. What they cost has
        // been charged; moving a year of them belongs on the Product tab of
        // Changes, where it is chosen on purpose.
        const keepId = String(one.value || '');
        const keep = st.rows.filter(r => r.id === keepId)[0];
        if (!keep) throw new Error('The item to keep is not in this read');
        if (keepId === one.id) throw new Error('That is the same item');
        if (!sameVariant(row, keep)) {
          throw new Error('These read as different shades - ' + row.name + ' and ' + keep.name + ' - so they are not merged');
        }
        if (row.type === 'Inventory' && keep.type !== 'Inventory') {
          throw new Error('The item kept does not hold stock and this one does - keep the inventory item instead');
        }

        const report = row.merge = {
          into: keep.name, docsTotal: (row.docs || []).length, docsMoved: 0, docsFailed: [],
          stockMoved: 0, costCopied: false, putAway: false, complete: false,
          moreDocs: Math.max(0, (row.docCount || 0) - (row.docs || []).length)
        };
        const pause = ms => new Promise(r => setTimeout(r, ms));
        const pair = [{ from: { id: row.id, name: row.name }, to: { id: keep.id, name: keep.name } }];

        // 1 - the documents, each tried a second time before it is called refused
        let waiting = (row.docs || []).slice();
        for (let round = 1; round <= 2 && waiting.length; round++) {
          if (round === 2) { await pause(4000); token = await getAccessToken(realmId); }
          const again = [];
          for (const d of waiting) {
            if (job.stop) break;
            try {
              await replaceItemOn(realmId, token, d.kind, d.id, pair);
              d.moved = true;
              report.docsMoved++;
            } catch (e) {
              // already moved by an earlier run counts as moved
              if (/no longer|any more|None of those products/i.test(e.message)) { d.moved = true; report.docsMoved++; }
              else { d.why = e.message; again.push(d); }
            }
          }
          waiting = again;
        }
        report.docsFailed = waiting.map(d => ({ kind: d.kindLabel, doc: d.doc || d.id, date: d.date, why: d.why }));

        // 2 - what stock is left, read fresh now the bills have moved
        const nowGoing = await replaceItemById(realmId, token, row.id);
        const nowKeep = await replaceItemById(realmId, token, keep.id);
        const had = Number(nowGoing.qty || 0);
        if (had !== 0 && row.type === 'Inventory') {
          if (!job.accountId) throw new Error('Stock is left to move - pick the account to write the difference off to');
          await adjustStock(realmId, token, {
            accountId: job.accountId, date: job.date,
            memo: 'Stock moved to ' + keep.name, itemId: row.id, from: had, to: 0
          });
          await adjustStock(realmId, token, {
            accountId: job.accountId, date: job.date,
            memo: 'Stock taken over from ' + row.name, itemId: keep.id,
            from: Number(nowKeep.qty || 0), to: Number(nowKeep.qty || 0) + had
          });
          report.stockMoved = had;
        }
        row.qty = 0;
        keep.qty = Number(nowKeep.qty || 0) + (report.stockMoved || 0);

        // 3 - the cost
        if (!keep.cost && row.cost) {
          await updateProductItem(realmId, token, keepId, { PurchaseCost: Number(row.cost) });
          keep.cost = Number(row.cost);
          report.costCopied = true;
        }

        // 4 - put away only when nothing is left behind on it
        if (!report.docsFailed.length && !report.moreDocs) {
          await updateProductItem(realmId, token, one.id, { Active: false });
          row.active = false;
          report.putAway = true;
          report.complete = true;
        }

        job.done++;
        if (!report.complete) job.failed++;
        job.log.push({
          ok: report.complete, name: row.name || one.id,
          was: report.docsMoved + ' of ' + report.docsTotal + ' documents moved' +
               (report.stockMoved ? ', ' + report.stockMoved + ' stock moved' : ''),
          now: report.complete ? 'merged into ' + keep.name + ', put away'
                               : 'not finished - ' + (report.docsFailed.length
                                   ? report.docsFailed.length + ' document(s) refused'
                                   : report.moreDocs + ' more documents than were read'),
          msg: report.complete ? '' : report.docsFailed.map(f => f.kind + ' ' + f.doc + ': ' + f.why).join('; ')
        });
        await logProductChange(realmId, {
          id: one.id, name: row.name || '', sku: row.sku || '', field: 'merge',
          was: report.docsMoved + '/' + report.docsTotal + ' documents, ' + (report.stockMoved || 0) + ' stock',
          now: keep.name + (report.complete ? '' : ' (not finished)'), ok: report.complete,
          message: report.complete ? '' : report.docsFailed.map(f => f.kind + ' ' + f.doc + ': ' + f.why).join('; ')
        }).catch(e => console.error('product log:', e.message));
        continue;
      } else if (job.field === 'stock') {
        // the correction itself, rather than a field on the item: what the stock
        // should read, against what it reads now
        const to = Number(one.value);
        if (!isFinite(to)) throw new Error('Say what the stock should read');
        const had = Number(row.qty || 0);
        const made = await adjustStock(realmId, token, {
          accountId: job.accountId, date: job.date, memo: job.memo,
          itemId: one.id, from: had, to
        });
        row.qty = to;
        job.done++;
        job.log.push({ ok: true, name: row.name || one.id,
                       was: had, now: to + (made.doc ? ' (' + made.doc + ')' : '') });
        await logProductChange(realmId, {
          id: one.id, name: row.name || '', sku: row.sku || '',
          field: 'stock', was: had, now: to, ok: true
        }).catch(e => console.error('product log:', e.message));
        continue;
      } else {
        throw new Error('Unknown change ' + job.field);
      }

      const out = await updateProductItem(realmId, token, one.id, patch);

      // the list on screen is what the page reads back, so it is told what
      // happened rather than left saying what used to be true
      if (job.field === 'cost') row.cost = Number(one.value);
      if (job.field === 'active') row.active = false;

      job.done++;
      job.log.push({ ok: true, name: row.name || out.Name || one.id, was, now });
      await logProductChange(realmId, {
        id: one.id, name: row.name || out.Name || '', sku: row.sku || '',
        field: job.field, was, now, ok: true
      }).catch(e => console.error('product log:', e.message));
    } catch (e) {
      job.done++;
      job.failed++;
      job.log.push({ ok: false, name: row.name || one.id, msg: e.message });
      await logProductChange(realmId, {
        id: one.id, name: row.name || '', sku: row.sku || '',
        field: job.field, was: '', now: '', ok: false, message: e.message
      }).catch(err => console.error('product log:', err.message));
    }
  }

  settle();
  job.running = false;
  job.finished = Date.now();
  if (st.rows.length) st.summary = summariseProducts(st.rows);
}

app.post('/api/products/apply', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = prodStore.get(req.desk);
    if (!st) throw new Error('Read the books first');
    if (st.scan && st.scan.running) throw new Error('The read is still running');
    if (st.job && st.job.running) throw new Error('That is already running');

    const body = req.body || {};
    // carrying on takes what is left of the run before, the way it was asked
    const before = body.carryOn && st.job ? st.job : null;
    if (before) {
      body.field = before.field;
      body.items = before.items;
      body.accountId = before.accountId;
      body.date = before.date;
      body.memo = before.memo;
    }
    const field = String(body.field || '');
    if (['cost', 'active', 'stock', 'merge'].indexOf(field) < 0) throw new Error('Unknown change');
    if (field === 'stock' && !body.accountId) {
      throw new Error('Pick the account to write the difference off to');
    }

    const items = (Array.isArray(body.items) ? body.items : [])
      .map(i => ({ id: String(i.id || ''), value: i.value }))
      .filter(i => i.id);
    if (!items.length) throw new Error('Tick at least one of them');

    const job = {
      running: true, stop: false, field, done: 0, failed: 0,
      total: items.length, items, log: [], started: Date.now(),
      okIds: new Set(before ? before.okIds : []),
      accountId: body.accountId || '', date: body.date || '', memo: body.memo || ''
    };
    job.done = job.okIds.size;
    st.job = job;

    runProductJob(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, total: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/products/adjust-accounts', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const token = await getAccessToken(realmId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ accounts: await listAdjustAccounts(realmId, token) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Only the log of a finished run goes; what was read stays.
app.post('/api/products/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = prodStore.get(req.desk);
  if (st && st.job && st.job.running) return res.status(400).json({ error: 'The run is still going' });
  if (st) st.job = null;
  res.json({ ok: true });
});

app.post('/api/products/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = prodStore.get(req.desk);
  if (st && st.job) st.job.stop = true;
  if (st && st.scan && st.scan.running) st.scan.stop = true;
  res.json({ ok: true });

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/products/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = prodStore.get(req.desk);
  if (st) {
    st.ended = true;
    if (st.job) st.job.stop = true;
    if (st.scan) st.scan.stop = true;
  }
  prodStore.delete(req.desk);
  res.json({ ok: true, had: !!st });
});

});

app.get('/api/products/record', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ changes: await listProductChanges(realmId, Number(req.query.limit) || 300) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products/record/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ ok: true, cleared: await clearProductChanges(realmId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Purchases ====================
//
// The orders and bills already in QuickBooks, and a way to make another. What
// was bought is what QuickBooks builds cost of sales out of, so this is the
// other half of the products page: that one says the cost is missing, this one
// is where it is put in.

const purchStore = new Map();      // desk -> { kind, from, to, docs, at }

app.get('/api/purchases/who', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const [vendors, payables] = await Promise.all([
      listVendors(realmId, token),
      listPayables(realmId, token)
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ vendors, payables });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/purchases/list', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const kind = String(req.query.kind || 'PurchaseOrder');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!from || !to) throw new Error('Give the dates to look between');

    const token = await getAccessToken(realmId);
    const docs = await readDocs(realmId, token, kind, { from, to });

    purchStore.set(req.desk, { kind, from, to, docs, at: Date.now() });

    // the lines are what make this heavy, and the list does not show them until
    // one is opened
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      kind, from, to,
      total: docs.length,
      value: Math.round(docs.reduce((s, d) => s + d.total, 0) * 100) / 100,
      docs: docs.map(d => {
        const light = Object.assign({}, d);
        delete light.lines;
        delete light.other;
        return light;
      })
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/purchases/one', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    const one = await readOne(realmId, token,
      String(req.query.kind || 'PurchaseOrder'), String(req.query.id || ''));
    res.setHeader('Cache-Control', 'no-store');
    res.json(one);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reading the supplier's own paper so the lines do not have to be typed.
//
// All of it happens here: the reading, the rules that turn what was read into
// lines, and the matching to this company's own items. Nothing is sent
// anywhere, and nothing about it costs anything to run.
//
// This only fills the form in - a person still presses the button that makes
// the order or the bill.
app.post('/api/purchases/read', upload.array('files', 10), async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  let gone = false;
  req.on('close', () => { if (!res.writableEnded) gone = true; });

  try {
    if (!(req.files || []).length) throw new Error('No photo came through');

    const got = await readPictures(req.files);
    if (gone) return;                         // Stop was pressed while it read

    const sheet = parseSheet(got.text);

    const token = await getAccessToken(realmId);
    const items = [];
    let start = 1;
    while (true) {
      // SELECT * - naming the fields instead hands Sku back empty, and the code
      // is the whole of how a line finds its product
      const q = await qbQuery(realmId, token,
        `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
      const arr = q.Item || [];
      arr.forEach(it => items.push({
        id: String(it.Id),
        name: it.FullyQualifiedName || it.Name || '',
        sku: it.Sku || '',
        active: it.Active !== false,
        // what the line should say: the wording QuickBooks itself keeps for a
        // purchase of this product, falling back to the selling one
        desc: it.PurchaseDesc || it.Description || ''
      }));
      if (arr.length < 1000) break;
      start += 1000;
      if (start > 9000) break;
    }
    if (gone) return;

    const out = matchToItems(sheet, items);
    res.setHeader('Cache-Control', 'no-store');
    res.json(Object.assign(out, {
      read: got.read, skipped: got.skipped, sure: got.sure,
      // how many products there were to match against, and how many of them
      // carry a code at all - without this, "nothing matched" reads the same
      // whether the codes are missing or the reading was wrong
      items: items.length,
      coded: items.filter(it => it.sku).length,
      // what the reader actually saw, so a line that came out wrong can be
      // checked without squinting at the picture
      saw: got.text
    }));
  } catch (e) {
    if (gone) return;
    res.status(400).json({ error: e.message });
  }
});

// The supplier's own paper, kept against the transaction. One file at a time,
// the same size limit as everything else that is uploaded here.
app.post('/api/purchases/attach', upload.single('file'), async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const kind = String(req.body.kind || 'PurchaseOrder');
    const id = String(req.body.id || '');
    if (!id) throw new Error('Say which one it belongs to');
    if (!req.file) throw new Error('No file came through');

    const token = await getAccessToken(realmId);
    const made = await attachFile(realmId, token, kind, id, req.file);
    res.json({ ok: true, file: made });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/purchases/files', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const token = await getAccessToken(realmId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      files: await listAttachments(realmId, token,
        String(req.query.kind || 'PurchaseOrder'), String(req.query.id || ''))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/purchases/create', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const body = req.body || {};
    const token = await getAccessToken(realmId);
    const made = await createDoc(realmId, token, String(body.kind || 'PurchaseOrder'), body);

    // one row per product, so the record says what came in at what cost rather
    // than only that a document was made
    for (const l of (body.lines || [])) {
      await logProductChange(realmId, {
        id: String(l.itemId || ''), name: l.itemName || '', sku: l.sku || '',
        field: made.kind === 'Bill' ? 'bill' : 'order',
        was: '', now: (made.doc || made.id) + ' — ' + l.qty + ' @ ' + l.rate,
        ok: true
      }).catch(e => console.error('purchase log:', e.message));
    }

    res.json({ ok: true, made });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== Replace product ====================
//
// A pasted column of pairs - the item going, the item taking its place - found
// across every kind of transaction that carries a product, and the old item
// swapped for the new one on the lines that carry it. Held in memory like the
// description change: reading it again is cheaper than keeping it.

const replStore = new Map();       // desk -> { pairs, bad, scan, rows, job, at }

app.get('/api/replace/kinds', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ kinds: REPLACE_KINDS.map(k => ({ key: k.key, label: k.label, side: k.side })) });
});

// The pairs are checked against the items before anything is read, so a name
// that matches nothing - or two things - is said up front rather than found out
// halfway through a year of invoices.
app.post('/api/replace/pairs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const old = replStore.get(req.desk);
    if (old && ((old.scan && old.scan.running) || (old.job && old.job.running))) {
      throw new Error('A read or a run is still going');
    }

    const pasted = parseReplacePairs((req.body || {}).text);
    if (!pasted.length) throw new Error('Paste the old item and the new one, side by side, one pair to a line');
    if (pasted.length > 3000) throw new Error('That is more than three thousand pairs - paste it in parts');

    const token = await getAccessToken(realmId);
    const items = await readItems(realmId, token);
    const { ok, bad } = resolveReplacePairs(pasted, items);

    replStore.set(req.desk, { desk: req.desk, pairs: ok, bad, scan: null, rows: [], job: null, at: Date.now() });
    res.json({ pairs: ok, bad, pasted: pasted.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Every item, switched off ones included - a product already put away is often
// exactly the one whose transactions still need moving.
app.get('/api/replace/items', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const token = await getAccessToken(realmId);
    const items = await readItems(realmId, token);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      items: items.map(it => ({ id: it.id, name: it.name, sku: it.sku, type: it.type, active: it.active, qty: it.qty }))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Shopify's product export, turned into pairs: every variant live in the store
// keeps the item carrying its SKU, and that item's duplicates in the same shade
// are paired onto it. What could not be paired safely comes back named, with why.
app.post('/api/replace/shopify', upload.single('file'), async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const old = replStore.get(req.desk);
    if (old && ((old.scan && old.scan.running) || (old.job && old.job.running))) {
      throw new Error('A read or a run is still going');
    }
    if (!req.file) throw new Error('No file came through');

    // raw, so a SKU like 7102-001/7 is not read as a date
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: true, cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    const { variants, skipped } = shopifyVariants(rows);
    if (!variants.length) throw new Error('No active variant with a SKU was found in that file');

    const token = await getAccessToken(realmId);
    const items = await readItems(realmId, token);
    const out = pairsFromShopify(variants, items, { twinKeys, sameVariant });

    replStore.set(req.desk, { desk: req.desk, pairs: out.pairs, bad: out.bad, scan: null, rows: [], job: null, at: Date.now() });
    res.json({
      variants: variants.length, notActive: skipped, keepers: out.keepers,
      pairs: out.pairs, bad: out.bad
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One product picked from the list, to be looked for on its own. The product
// taking its place is chosen after the read, once it is plain where this one is.
app.post('/api/replace/pick', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const old = replStore.get(req.desk);
    if (old && ((old.scan && old.scan.running) || (old.job && old.job.running))) {
      throw new Error('A read or a run is still going');
    }
    const id = String((req.body || {}).id || '');
    if (!id) throw new Error('Pick the product to look for');

    const token = await getAccessToken(realmId);
    const from = await replaceItemById(realmId, token, id);
    replStore.set(req.desk, { desk: req.desk, pairs: [{ line: 1, from, to: null }], bad: [], scan: null, rows: [], job: null, at: Date.now() });
    res.json({ pair: { from, to: null } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The product that goes on in its place, with what to be careful of said before
// anything moves: a different shade, or stock moving onto an item that does not
// hold stock.
app.post('/api/replace/target', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = replStore.get(req.desk);
    if (!st || st.pairs.length !== 1) throw new Error('Pick the product to replace first');
    if (st.job && st.job.running) throw new Error('A run is still going');
    const id = String((req.body || {}).id || '');
    if (!id) throw new Error('Pick the product to put on instead');

    const token = await getAccessToken(realmId);
    const to = await replaceItemById(realmId, token, id);
    const from = st.pairs[0].from;
    if (to.id === from.id) throw new Error('That is the same product');

    const warnings = [];
    if (!sameVariant(from, to)) {
      warnings.push('These read as different shades or numbers - check this is really the same product before replacing.');
    }
    if (from.type === 'Inventory' && to.type !== 'Inventory') {
      warnings.push('The product going holds stock and this one does not: moved onto it, those bills bring no stock in and those sales carry no cost of sales.');
    }
    if (!to.active) warnings.push('This product is switched off in QuickBooks.');

    st.pairs[0].to = to;
    // what was already counted on the new one belonged to a pair with no target
    st.pairs[0].warnings = warnings;
    res.json({ pair: st.pairs[0], warnings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The pairs, narrowed to the ones ticked on the page. Read first, run second:
// this is where a match that does not look right is taken out before anything is
// found or changed.
app.post('/api/replace/pairs-keep', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = replStore.get(req.desk);
    if (!st || !st.pairs.length) throw new Error('There are no pairs to narrow');
    if ((st.scan && st.scan.running) || (st.job && st.job.running)) throw new Error('A read or a run is still going');

    const ids = new Set((((req.body || {}).ids) || []).map(String));
    if (!ids.size) throw new Error('Tick the pairs to keep');
    const kept = st.pairs.filter(p => ids.has(String(p.from.id)));
    if (!kept.length) throw new Error('None of those pairs is in the list');

    st.pairs = kept;
    st.rows = [];
    st.scan = null;
    st.scanState = null;
    st.job = null;
    res.json({ pairs: kept });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/replace/scan', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = replStore.get(req.desk);
    if (!st || !st.pairs.length) throw new Error('Check the pairs first');
    if ((st.scan && st.scan.running) || (st.job && st.job.running)) throw new Error('A read or a run is still going');

    const body = req.body || {};
    // carrying on picks up the read that stopped - its dates, its kinds, what it
    // had found and how far each kind had got - rather than starting over
    const carryOn = !!body.carryOn && st.scan && st.scanState && !st.scan.running;
    const from = carryOn ? st.scan.from : body.from;
    const to = carryOn ? st.scan.to : body.to;
    const kinds = carryOn ? st.scan.kinds : body.kinds;
    if (!from || !to) throw new Error('Give the dates to look between');
    if (from > to) throw new Error('The first date is after the last one');
    if (!Array.isArray(kinds) || !kinds.length) throw new Error('Tick at least one kind of transaction');

    const state = carryOn ? st.scanState : newScanState(st.pairs);
    const scan = {
      running: true, stop: false, from, to, kinds, carriedOn: carryOn,
      kind: carryOn ? st.scan.kind : '', upto: carryOn ? st.scan.upto : from,
      found: state.rows.length, read: state.read, error: null, started: Date.now()
    };
    st.scan = scan;
    st.scanState = state;
    st.rows = [];
    st.onNew = {};
    st.job = null;
    clearReplace(req.desk).catch(() => {});

    const getToken = tokenKeeper(() => getAccessToken(realmId), await getAccessToken(realmId));
    scanReplace(realmId, getToken,
      { from, to, kinds, pairs: st.pairs, state, shouldStop: () => scan.stop },
      step => {
        scan.kind = step.kind; scan.upto = step.upto;
        scan.found = step.found; scan.read = step.read;
      })
      .then(out => {
        st.rows = out.rows;
        st.onNew = out.onNew || {};
        st.scanState = null;
        scan.found = out.rows.length;
        scan.read = out.read;
        scan.running = false;
        scan.finished = Date.now();
      })
      .catch(e => {
        scan.running = false;
        // a stop asked for is not an error - the dates or the kinds are about to
        // change and the read to start again
        scan.stopped = e.message === 'stopped';
        scan.error = scan.stopped ? null : e.message;
        // what was found before it stopped is kept, to be carried on from
        scan.canCarryOn = !!(st.scanState && (st.scanState.read || st.scanState.rows.length));
        scan.found = state.rows.length;
        scan.read = state.read;
      });

    res.json({ ok: true, carriedOn: carryOn });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// What was found, per pair and per kind - the thing to look at before pressing
// the button - and the transactions themselves, newest trouble first.
app.get('/api/replace/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  res.setHeader('Cache-Control', 'no-store');
  const st = replStore.get(req.desk);
  if (!st) return res.json({ has: false });

  const byPair = new Map(st.pairs.map(p => [p.from.id, {
    from: p.from, to: p.to, warnings: p.warnings || [],
    txns: 0, lines: 0, qty: 0, amount: 0, kinds: {}, byKind: {}, done: 0, failed: 0,
    onNew: p.to ? ((st.onNew || {})[p.to.id] || null) : null
  }]));
  st.rows.forEach(r => {
    const touched = new Set();
    r.hits.forEach(h => {
      const g = byPair.get(h.fromId);
      if (!g) return;
      g.lines++;
      g.qty = Math.round((g.qty + h.qty) * 100) / 100;
      g.amount = Math.round((g.amount + h.amount) * 100) / 100;
      const k = g.byKind[r.kindLabel] || (g.byKind[r.kindLabel] = { txns: 0, lines: 0, qty: 0, amount: 0 });
      k.lines++;
      k.qty = Math.round((k.qty + h.qty) * 100) / 100;
      k.amount = Math.round((k.amount + h.amount) * 100) / 100;
      if (!touched.has(h.fromId)) k.txns++;
      if (!touched.has(h.fromId)) {
        touched.add(h.fromId);
        g.txns++;
        g.kinds[r.kindLabel] = (g.kinds[r.kindLabel] || 0) + 1;
        if (r.state === 'changed') g.done++;
        if (r.state === 'failed') g.failed++;
      }
    });
  });

  const limit = Math.min(Number(req.query.limit) || 400, 3000);
  const s = st.scan, job = st.job;

  res.json({
    has: true,
    pairs: st.pairs, bad: st.bad,
    summary: Array.from(byPair.values()),
    total: st.rows.length,
    rows: st.rows.slice(0, limit),
    scan: s ? {
      running: s.running, from: s.from, to: s.to, kinds: s.kinds, kind: s.kind,
      upto: s.upto, found: s.found, read: s.read, stopped: !!s.stopped, error: s.error || null,
      canCarryOn: !!s.canCarryOn && !!st.scanState, carriedOn: !!s.carriedOn
    } : null,
    job: job ? {
      running: job.running, done: job.done, failed: job.failed, lines: job.lines,
      total: job.total, round: job.round, retried: job.retried, recovered: job.recovered,
      avgMs: job.avgMs || 0, resumed: !!job.resumed,
      stopped: !!job.stopped, failures: job.failures || [],
      error: job.error || null, log: job.log.slice(-80)
    } : null
  });
});

// One transaction per request, the same as every other run here - the batch API
// times out under inventory locks, and a slow run that finishes beats a fast one
// that does not.
async function runReplace(realmId, st, job) {
  const getToken = tokenKeeper(() => getAccessToken(realmId), await getAccessToken(realmId));
  const pairById = new Map(st.pairs.map(p => [p.from.id, p]));
  const pause = ms => new Promise(r => setTimeout(r, ms));

  // Newest first. Changing the product on a transaction makes QuickBooks work the
  // stock cost of both products out again for everything dated after it - so the
  // oldest invoice first means every change redoes the whole year after it, and
  // the newest first means each one has only the little after it left to redo.
  job.rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') ||
                          String(b.doc || '').localeCompare(String(a.doc || '')));

  // written down before it starts, so a restart in the first minutes is not lost
  await saveReplace(st.desk, st).catch(e => console.error('replace save:', e.message));

  // A refusal is very often not about the transaction at all - a lock held by
  // another edit, a gateway that timed out, a token that ran out mid-run. So the
  // run goes through once, then takes the refused ones again, twice more, after
  // a breath each time. Only what is still refused after that is reported as
  // refused, with the reason QuickBooks gave the last time.
  for (job.round = 1; job.round <= 3; job.round++) {
    const todo = job.rows.filter(r => job.round === 1 ? r.state === 'ready' : r.state === 'failed');
    if (!todo.length) break;
    if (job.round > 1) {
      job.log.push({ ok: true, note: true, doc: 'Trying the ' + todo.length + ' refused again (round ' + job.round + ')', lines: 0 });
      await pause(4000);
      await getToken(true);
      job.retried += job.round === 2 ? todo.length : 0;
    }
    await replacePass(realmId, getToken, job, todo, pairById);
    if (job.stop) { job.stopped = true; break; }
  }

  job.failures = job.rows.filter(r => r.state === 'failed')
    .map(r => ({ kind: r.kindLabel, doc: r.doc || r.qbId, date: r.date, why: r.note }));
  job.running = false;
  job.finished = Date.now();
  // finished - there is nothing for a restart to carry on with
  await clearReplace(st.desk).catch(e => console.error('replace clear:', e.message));
}

async function replacePass(realmId, getToken, job, todo, pairById) {
  let sinceSave = 0, savedAt = Date.now();
  const saveNow = async (force) => {
    if (!force && sinceSave < 5 && Date.now() - savedAt < 20000) return;
    sinceSave = 0; savedAt = Date.now();
    await saveReplace(job.st.desk, job.st).catch(e => console.error('replace save:', e.message));
  };

  for (const row of todo) {
    if (job.stop) break;
    const again = row.state === 'failed';
    sinceSave++;

    const pairs = Array.from(new Set(row.hits.map(h => h.fromId)))
      .map(id => pairById.get(id)).filter(Boolean);

    const started = Date.now();
    try {
      let out;
      try {
        out = await replaceItemOn(realmId, await getToken(false), row.kind, row.qbId, pairs);
      } catch (e) {
        // the token ran out mid-run: fetch another and ask once more
        if (!/\(401\)|authenticat|unauthori|token/i.test(e.message)) throw e;
        out = await replaceItemOn(realmId, await getToken(true), row.kind, row.qbId, pairs);
      }
      row.state = 'changed';
      row.note = out.lines + (out.lines === 1 ? ' line' : ' lines') + ' changed' + (again ? ' on another try' : '');
      if (again) { job.failed--; job.recovered++; } else job.done++;
      job.lines += out.lines;
      // how long a transaction takes, on the last twenty, so the page can say how
      // long is left and a slow stretch can be seen as QuickBooks' and not ours
      const took = Date.now() - started;
      job.recent = (job.recent || []).concat(took).slice(-20);
      job.avgMs = Math.round(job.recent.reduce((a, b) => a + b, 0) / job.recent.length);
      job.log.push({
        ok: true, doc: row.kindLabel + ' ' + (out.doc || row.qbId), lines: out.lines,
        // the total is the proof that only the product moved
        moved: Math.round((out.total - out.before) * 100) / 100,
        readMs: out.readMs, writeMs: out.writeMs
      });
      for (const p of pairs) {
        await logProductChange(realmId, {
          id: p.from.id, name: p.from.name, sku: p.from.sku, field: 'replace',
          was: row.kindLabel + ' ' + (out.doc || row.qbId) + ' (' + row.date + ')',
          now: p.to.name, ok: true
        }).catch(e => console.error('replace log:', e.message));
      }
    } catch (e) {
      // changed before a restart but not yet written down - the old product is
      // simply not on it any more, which is the change having been made
      if (/None of those products is on/.test(e.message)) {
        row.state = 'changed';
        row.note = 'already changed';
        if (again) { job.failed--; job.recovered++; } else job.done++;
        job.log.push({ ok: true, doc: row.kindLabel + ' ' + (row.doc || row.qbId), lines: 0, already: true });
        await saveNow(false);
        continue;
      }
      row.state = 'failed';
      row.note = e.message;
      if (!again) { job.done++; job.failed++; }
      job.log.push({ ok: false, doc: row.kindLabel + ' ' + (row.doc || row.qbId), msg: e.message });
      // the record says a refusal once, when it is final - not once per try
      if (again && job.round === 3) {
        for (const p of pairs) {
          await logProductChange(realmId, {
            id: p.from.id, name: p.from.name, sku: p.from.sku, field: 'replace',
            was: row.kindLabel + ' ' + (row.doc || row.qbId), now: p.to.name,
            ok: false, message: e.message
          }).catch(err => console.error('replace log:', err.message));
        }
      }
    }
    await saveNow(false);
  }
  await saveNow(true);
}

app.post('/api/replace/run', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;

  try {
    const st = replStore.get(req.desk);
    if (!st || !st.rows.length) throw new Error('Find the transactions first');
    if (st.scan && st.scan.running) throw new Error('The read is still running');
    if (st.job && st.job.running) throw new Error('That is already running');

    // the kinds left ticked on the page decide what is run - bills alone, say,
    // before the invoices are touched
    const kinds = (req.body || {}).kinds;
    // what a finished run left refused is taken again by pressing the button again
    st.rows.forEach(r => { if (r.state === 'failed') { r.state = 'ready'; r.note = ''; } });
    const rows = st.rows.filter(r => r.state === 'ready' &&
      (!Array.isArray(kinds) || !kinds.length || kinds.includes(r.kind)));
    if (!rows.length) throw new Error('Nothing is waiting to be changed');
    if (st.pairs.some(p => !p.to)) throw new Error('Pick the product to put on instead first');

    const job = {
      running: true, stop: false, done: 0, failed: 0, lines: 0,
      round: 1, retried: 0, recovered: 0, kinds: Array.isArray(kinds) ? kinds : null,
      total: rows.length, rows, log: [], started: Date.now()
    };
    job.st = st;
    st.job = job;

    runReplace(realmId, st, job).catch(e => {
      job.running = false;
      job.error = e.message;
    });

    res.json({ ok: true, total: job.total });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/replace/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = replStore.get(req.desk);
  if (st && st.scan && st.scan.running) st.scan.stop = true;
  if (st && st.job && st.job.running) st.job.stop = true;
  res.json({ ok: true });

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/replace/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = replStore.get(req.desk);
  if (st) {
    st.ended = true;                 // nothing of it is written back
    if (st.scan) st.scan.stop = true;
    if (st.job) st.job.stop = true;
  }
  replStore.delete(req.desk);
  await clearReplace(req.desk).catch(e => console.error('replace end:', e.message));
  res.json({ ok: true, had: !!st });
});

});

// Only the log of a finished run goes - the pairs and what was found stay, so a
// new run starts with an empty log and shows nothing of the last one.
app.post('/api/replace/clear-log', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = replStore.get(req.desk);
  if (st && st.job && st.job.running) {
    return res.status(400).json({ error: 'The run is still going' });
  }
  if (st) st.job = null;
  res.json({ ok: true });
});

app.post('/api/replace/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  const st = replStore.get(req.desk);
  if (st && ((st.scan && st.scan.running) || (st.job && st.job.running))) {
    return res.status(400).json({ error: 'A read or a run is still going' });
  }
  replStore.delete(req.desk);
  res.json({ ok: true });
});

// A replacement that was running when the server went down - a deploy, a crash -
// is carried on with what was left, and says so at the top of its log.
async function resumeReplace() {
  const rows = await unfinishedReplace();
  for (const r of rows) {
    try {
      const saved = r.job || {};
      const all = (r.rows || []);
      if (!r.user_sub) continue;      // nobody's run is not restarted
      const desk = deskKey(r.realm_id, r.user_sub);
      if (!all.some(x => x.state === 'ready' || x.state === 'failed')) { await clearReplace(desk); continue; }

      const st = {
        desk,
        pairs: r.pairs || [], bad: [],
        scan: Object.assign({ running: false, stopped: false, error: null }, r.scan || {}),
        rows: all, onNew: {}, at: Date.now()
      };
      const kinds = saved.kinds;
      const job = {
        running: true, stop: false, resumed: true,
        done: saved.done || 0, failed: saved.failed || 0, lines: saved.lines || 0,
        round: 1, retried: saved.retried || 0, recovered: saved.recovered || 0,
        kinds, total: saved.total || all.length, started: saved.started || Date.now(),
        avgMs: saved.avgMs || 0, log: saved.log || []
      };
      // what was refused before the restart is simply taken again
      all.forEach(x => { if (x.state === 'failed') { x.state = 'ready'; job.failed = Math.max(0, job.failed - 1); job.done = Math.max(0, job.done - 1); } });
      job.rows = all.filter(x => x.state === 'ready' && (!kinds || !kinds.length || kinds.includes(x.kind)));
      job.log.push({ ok: true, note: true, lines: 0,
        doc: 'Server restarted - carrying on. ' + (all.length - job.rows.length) + ' already done, ' + job.rows.length + ' to go.' });
      job.st = st;
      st.job = job;
      replStore.set(desk, st);

      runReplace(r.realm_id, st, job).catch(e => { job.running = false; job.error = e.message; });
    } catch (e) {
      console.error('replace resume:', e.message);
    }
  }
}

// Everybody except the admins starts again.
//
// Access was being handed out by the act of signing in: whoever arrived was let
// in, and where the app held a single company they were put into it. Nobody asked
// for that and nobody granted it. So it is taken back once - every company any
// user was in, and the access that came with it - and from here each person waits
// for the admin, who is told they are waiting. It runs a single time; the mark is
// kept in the database so a restart is not a second clearing out.
async function resetNonAdminAccess() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS once_done (
        what TEXT PRIMARY KEY,
        at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const mark = 'reset-non-admin-access-2026-09';
    const seen = await pool.query('SELECT 1 FROM once_done WHERE what = $1', [mark]);
    if (seen.rowCount) return;

    const admins = [...ADMIN_EMAILS];
    const r = await pool.query(
      `UPDATE users SET allowed = FALSE, role = 'none', rights = '[]'::jsonb,
              decided_at = NULL
       WHERE LOWER(COALESCE(email, '')) <> ALL($1) RETURNING sub`,
      [admins]
    );
    await pool.query(
      `DELETE FROM user_companies WHERE user_sub IN (
         SELECT sub FROM users WHERE LOWER(COALESCE(email, '')) <> ALL($1))`,
      [admins]
    );
    await pool.query('INSERT INTO once_done (what) VALUES ($1)', [mark]);
    whoCache.clear();
    console.log(`Access reset: ${r.rowCount} account(s) now wait for the admin`);
  } catch (e) {
    console.error('access reset failed:', e.message);
  }
}

// ==================== Open invoice audit ====================
// Why are these invoices still open? The sheets that answer it (bloggers, issues,
// advances, CPRs, returns) are attached once and kept for the company; an audit
// looks the open invoices up in all of them. Reading only - nothing is written to
// QuickBooks - so the look-up is open to everybody, and attaching, changing or
// removing a sheet is the admin's alone.
// Where each kind of sheet lives in Google Drive: a folder or one sheet, linked once
// the way Receive payments and Advance payments do it. The pages that already keep
// a link (CPR, advance, return) offer theirs as the starting point.
app.get('/api/audit/links', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      kinds: AUDIT_KINDS,
      links: await getAuditLinks(realmId),
      known: {
        cpr: await getSetting(realmId, 'cpr:root', ''),
        advance: await getSetting(realmId, 'adv:root', ''),
        return: await getSetting(realmId, 'void:root', '')
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audit/link', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ ok: true, link: await saveAuditLink(realmId, String(req.body.kind || ''), req.body.link) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/audit/link-remove', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  await dropAuditLink(realmId, String(req.body.kind || ''));
  res.json({ ok: true });
});

app.get('/api/audit/books', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    const l = (await getAuditLinks(realmId))[String(req.query.kind || '')];
    if (!l) return res.status(400).json({ error: 'Save the link first' });
    res.json({ books: await auditBooksAt(l.root) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audit/tabs', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tabs: await auditTabTitles(String(req.query.id || ''), req.query.excel === '1') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audit/header', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await auditHeaderOf(String(req.query.id || ''), String(req.query.tab || ''), req.query.excel === '1'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The workbooks behind a link some other page already holds: the advance sheet
// (Advance payments) and the return sheet (Void invoices). Linked and changed
// there, only read here.
app.get('/api/audit/place', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.setHeader('Cache-Control', 'no-store');
    const kind = String(req.query.kind || '');
    const key = kind === 'advance' ? 'adv:root' : kind === 'return' ? 'void:root' : '';
    if (!key) return res.status(400).json({ error: 'Not a sheet with a page of its own' });
    const root = await getSetting(realmId, key, '');
    if (!root) {
      return res.status(400).json({ error: kind === 'advance'
        ? 'Set the advance sheet in Advance payments first'
        : 'Set the return sheet folder in Void invoices first' });
    }
    res.json({ books: await auditBooksAt(root) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audit/pick', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    res.json({ ok: true, link: await saveAuditPick(realmId, String(req.body.kind || ''), req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/audit/start', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    const input = req.body.text != null
      ? { invoices: parseAuditPasted(req.body.text), kinds: req.body.kinds, places: req.body.places }
      : req.body;
    const id = startRead(req.desk, 'audit', auditRead(realmId, input));
    res.json({ ok: true, jobId: id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/audit/status', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.setHeader('Cache-Control', 'no-store');
  const snap = readSnapshot(req.desk, 'audit', req.query.since || 0);
  res.json(snap ? { job: snap } : { job: null });
});

app.post('/api/audit/stop', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: stopRead(req.desk, 'audit') });
});

// End process - the run is over. Whatever is left is dropped and nothing of
// it stays on the server, not even after a deploy. What is already written
// to QuickBooks or to the sheets is not undone.
app.post('/api/audit/end', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  res.json({ ok: endRead(req.desk, 'audit') });
});


app.post('/api/audit/resume', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  try {
    resumeRead(req.desk, 'audit');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/audit/clear', async (req, res) => {
  const realmId = await requireCompany(req, res);
  if (!realmId) return;
  if (!clearRead(req.desk, 'audit')) return res.status(409).json({ error: 'The look-up is still going' });
  res.json({ ok: true });
});

// ==================== Start ====================
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => initMappings())
  .then(() => initUsers())
  .then(() => initNotify())
  .then(() => initPush())
  .then(() => resetNonAdminAccess())
  .then(() => initSettings())
  .then(() => initCache())
  .then(() => initCouriers())
    .then(() => import('./jobstore.js').then(m => m.initJobStore()))
  .then(() => initRecatStore())
  .then(() => initProdStore())
  .then(() => initReplaceStore())
  .then(() => initVoidStore())
  .then(() => app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startKeeper();
        resumeUnfinished().catch(e => console.error('resume failed:', e.message));
    resumeRecat().catch(e => console.error('recat resume failed:', e.message));
    resumeReplace().catch(e => console.error('replace resume failed:', e.message));
    resumeVoidRuns().catch(e => console.error('void resume failed:', e.message));
  }))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
