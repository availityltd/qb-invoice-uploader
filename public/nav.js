(function(){
  "use strict";

  /* ---------- before anyone has signed in ---------- */
  // A sign-in screen is not a page of the app, so it is not framed like one: no
  // rail, no toolbar, nothing to click until there is somebody here. The server
  // leaves a plain cookie beside the session one purely so this can be decided
  // now, at the first line, instead of after a round trip that the eye would
  // catch as a flash of the whole navigation.
  (function signedOutFrame(){
    var st = document.createElement('style');
    st.textContent =
      'html.signed-out .rail, html.signed-out .topline { display:none !important }' +
      'html.signed-out .main { margin-left:0 !important }' +
      // nothing else is on the screen, so the one thing that is sits in the
      // middle of it - not up in the corner where the rail used to hold it
      'html.signed-out .shell { max-width:none; min-height:100vh; padding:24px;' +
      '  display:flex; align-items:center; justify-content:center }' +
      'html.signed-out .gate { margin:0; width:100%; max-width:420px }';
    (document.head || document.documentElement).appendChild(st);

    if(!/(?:^|;\s*)signed=1(?:;|$)/.test(document.cookie)){
      document.documentElement.classList.add('signed-out');
    }
  })();

  // `need` is the job a line belongs to. A person given areas of the books rather
  // than all of them sees only the lines whose job they were given - and the
  // server turns the same pages away at their own address, so the rail is not
  // hiding a door that still opens. A line with no `need` is reading, which was
  // never what was being handed out: the dashboard and the searches stay.
  var ITEMS = [
    { group: null, items: [
      { href:'/',              label:'Dashboard',        icon:'grid' }
    ]},
    { group: 'Import invoices', items: [
      { href:'/convert.html',  label:'Convert',          icon:'shuffle', need:'upload' },
      { href:'/upload.html',   label:'Upload',           icon:'up',      need:'upload' }
    ]},
    { group: 'Payments', items: [
      { href:'/payments.html', label:'Receive payments', icon:'cash',    need:'payments' },
      { href:'/advance.html',  label:'Advance payments', icon:'wallet',  need:'advance' },
      { href:'/charges.html',  label:'Delivery charges', icon:'receipt', need:'charges' },
            { href:'/find.html',     label:'Find orders',      icon:'search' },
      { href:'/audit.html',    label:'Open invoice audit', icon:'receipt' },
      { href:'/couriers.html', label:'Couriers',         icon:'truck', tree:true,
        need:'couriersync' }
    ]},
    { group: 'Products', items: [
      // cost, stock, duplicates and the reports behind them are tabs of one page
      { href:'/products.html',  label:'Product health',  icon:'tag',  need:'products' },
      { href:'/purchases.html', label:'Purchases',       icon:'cart', need:'purchases' }
    ]},
    { group: 'Maintenance', items: [
      { href:'/fix.html',      label:'Fix duplicates',   icon:'copy', need:'products' },
      // Product, Category and Description are tabs of one page, not three
      // lines in the rail - a new kind of change is a new tab, not a new link
      { href:'/replace.html',  label:'Changes',          icon:'swap', need:'changes' },
      { href:'/void.html',     label:'Void invoices',    icon:'ban',  need:'void' }
      // Who may sign in, and what each of them may change, is not a line in this
      // rail. It sits under the settings gear with the rest of the company's own
      // settings, the way QuickBooks keeps it, and only the admin sees it there.
    ]}
  ];

  var ICONS = {
    grid:   '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    shuffle:'<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    up:     '<path d="M12 19V5M5 12l7-7 7 7"/>',
    cash:   '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
    truck:  '<path d="M3 16V6h11v10M14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    copy:   '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
    ban:    '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
    receipt:'<path d="M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
    swap:   '<path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3"/>',
    cart:   '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.6L21 7H6"/>',
    people: '<path d="M16 19v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="3.2"/><path d="M22 19v-2a4 4 0 00-3-3.8"/><path d="M16.5 3.9a4 4 0 010 6.2"/>',
    tag:    '<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7A2 2 0 013 12.2V5a2 2 0 012-2h7.2a2 2 0 011.4.6l7 7a2 2 0 010 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>'
  };

  function svg(name){
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
           'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
           (ICONS[name] || '') + '</svg>';
  }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var path = location.pathname.replace(/index\.html$/, '') || '/';

  var html =
    '<a class="brand" href="/">' +
      '<img src="/logo.svg" alt="">' +
      '<span><b>Shopify → QuickBooks</b><span>Invoice pipeline</span></span>' +
    '</a><nav>';

  ITEMS.forEach(function(sec){
    if(sec.group) html += '<div class="group">' + sec.group + '</div>';
    sec.items.forEach(function(it){
      // Merge payments and the check list are tabs of Receive payments,
      // so that is the line that lights up
      var on = (it.href === path) || (it.href !== '/' && path.indexOf(it.href) === 0) ||
               (it.href === '/payments.html' &&
                (path === '/merge.html' || path === '/checklist.html')) ||
               // every tab of the changes page lights up the one link
               (it.href === '/replace.html' &&
                (path === '/swap.html' || path === '/recat.html' || path === '/desc.html'));
      html += '<a href="' + it.href + '"' +
              (it.need ? ' data-line="' + it.need + '"' : '') +
              (on ? ' class="on"' : (it.admin ? ' class="admin-only"' : '')) +
              (on && it.admin ? ' data-admin="1"' : '') +
              (it.tree ? ' id="couriersLink"' : '') + '>' +
              svg(it.icon) + it.label +
              (it.tree ? '<span class="tcar" id="couriersCar">\u25B8</span>' : '') + '</a>';
      // Couriers is not one page but a small tree, filled in further down
      if(it.tree) html += '<div class="ctree" id="ctree"></div>';
    });
  });

  html += '</nav>' +
    '<div class="foot">' +
      '<div class="conn" id="connBox">' +
        '<span class="dot" id="dot"></span>' +
        '<span class="who" id="connText">Checking…</span>' +
        '<span class="caret">▼</span>' +
        '<div class="switcher" id="switcher"></div>' +
      '</div>' +
    '</div>';

  var rail = document.querySelector('.rail');
  if(rail) rail.innerHTML = html;

  /* ---------- how it looks on this computer ---------- */
  // Text size, rail width and colours are one person's own taste on one machine, so
  // they are kept in this browser rather than on the server and put on at once, before
  // the page has drawn, so nothing has to change under the eye.
  var LOOK_KEY = 'app:look';
  // The app writes its sizes in pixels throughout, so growing the body text alone
  // would move almost nothing. The whole page is scaled instead, which takes the
  // tables, the rail and the charts with it.
  var LOOK_BASE = { zoom: 1, rail: 236, tight: false, ink: '#0F2E24', accent: '#2CA01C' };

  function readLook(){
    try {
      var kept = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
      var out = {};
      for (var k in LOOK_BASE) out[k] = (kept && kept[k] !== undefined) ? kept[k] : LOOK_BASE[k];
      return out;
    } catch (e) { return JSON.parse(JSON.stringify(LOOK_BASE)); }
  }

  function wearLook(look){
    var r = document.documentElement.style;
    r.setProperty('--rail', look.rail + 'px');
    r.setProperty('--ink', look.ink);
    r.setProperty('--qbo', look.accent);
    r.zoom = (Number(look.zoom) === 1) ? '' : String(look.zoom);
    document.documentElement.classList.toggle('tight', !!look.tight);
  }

  function keepLook(look){
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch (e) {}
    wearLook(look);
  }

  window.APP = window.APP || {};
  window.APP.look = { read: readLook, wear: wearLook, keep: keepLook, base: LOOK_BASE };

  (function(){
    var tight = document.createElement('style');
    tight.textContent =
      'html.tight td, html.tight th { padding-top:7px; padding-bottom:7px }' +
      'html.tight .rail nav a { padding-top:6px; padding-bottom:6px }' +
      'html.tight .step, html.tight .sheet, html.tight .sec { padding-top:14px; padding-bottom:14px }';
    document.head.appendChild(tight);
    wearLook(readLook());
  })();

  /* ---------- back, forward, refresh ---------- */

  (function pageTools(){
    var top = document.querySelector('.topline');
    if(!top) return;

    var css = document.createElement('style');
    css.textContent = [
      '.ptools{display:flex;gap:6px;margin-left:auto;align-items:center}',
      '.ptools button{width:30px;height:30px;border:1px solid var(--line);background:#fff;',
      '  border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      '  color:var(--muted);padding:0}',
      '.ptools button:hover{border-color:var(--qbo);color:var(--qbo)}',
      '.ptools button svg{width:15px;height:15px}',
      '.ptools button.spin svg{animation:ptspin .7s linear infinite}',
      '@keyframes ptspin{to{transform:rotate(360deg)}}',
      '.setwrap{position:relative;display:flex}',
      '.setmenu{position:absolute;top:36px;right:0;z-index:200;min-width:230px;',
      '  background:var(--panel);border:1px solid var(--line);border-radius:10px;',
      '  box-shadow:0 12px 30px rgba(15,46,36,.14);padding:10px 0;display:none}',
      '.setmenu.open{display:block}',
      '.setmenu .cap{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;',
      '  text-transform:uppercase;color:var(--faint);padding:10px 16px 5px}',
      '.setmenu a{display:block;padding:7px 16px;font-size:13px;text-decoration:none;',
      '  color:var(--text)}',
      '.setmenu a:hover{background:var(--panel-2);color:var(--qbo)}',
      '.bellwrap{position:relative;display:flex}',
      '.belldot{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;',
      '  padding:0 4px;border-radius:9px;background:var(--neg,#9A2E24);color:#fff;',
      '  font-size:10px;line-height:16px;text-align:center;font-family:var(--mono);',
      '  display:none;pointer-events:none}',
      '.belldot.on{display:block}',
      '.bellmenu{position:absolute;top:36px;right:0;z-index:200;width:340px;',
      '  max-height:420px;overflow-y:auto;background:var(--panel);',
      '  border:1px solid var(--line);border-radius:10px;',
      '  box-shadow:0 12px 30px rgba(15,46,36,.14);padding:0;display:none}',
      '.bellmenu.open{display:block}',
      '.bellmenu .top{display:flex;align-items:center;gap:8px;padding:11px 14px;',
      '  border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}',
      '.bellmenu .top b{font-size:12.5px;font-weight:600;flex:1}',
      '.bellmenu .top button{font-size:11px;padding:3px 9px;border-radius:6px;',
      '  border:1px solid var(--line);background:#fff;cursor:pointer;color:var(--muted);',
      '  font-family:inherit}',
      '.bellmenu .top button:hover{border-color:var(--qbo);color:var(--qbo)}',
      '.bellmenu .n{display:block;padding:11px 14px;border-bottom:1px solid var(--line);',
      '  text-decoration:none;color:var(--text)}',
      '.bellmenu .n:last-child{border-bottom:0}',
      '.bellmenu .n:hover{background:var(--panel-2)}',
      '.bellmenu .n.new{background:#F1F8EF}',
      '.bellmenu .n.new:hover{background:#E9F4E6}',
      '.bellmenu .n b{display:block;font-size:12.5px;font-weight:600;line-height:1.45}',
      '.bellmenu .n p{margin:3px 0 0;font-size:11.5px;color:var(--muted);line-height:1.5}',
      '.bellmenu .n time{display:block;margin-top:4px;font-family:var(--mono);',
      '  font-size:10px;color:var(--faint)}',
      '.bellmenu .none{padding:26px 16px;text-align:center;font-size:12.5px;',
      '  color:var(--muted)}',
      '.bellmenu .ask{display:none;padding:12px 14px;border-bottom:1px solid var(--line);',
      '  background:var(--panel-2)}',
      '.bellmenu .ask.on{display:block}',
      '.bellmenu .ask p{margin:0 0 9px;font-size:11.5px;color:var(--muted);line-height:1.55}',
      '.bellmenu .ask button{width:100%;padding:8px;border-radius:7px;border:0;',
      '  background:var(--qbo);color:#fff;font:inherit;font-size:12.5px;cursor:pointer}',
      '.bellmenu .ask button:disabled{opacity:.6;cursor:default}'
    ].join('');
    document.head.appendChild(css);

    function btn(title, body){
      return '<button title="' + title + '"><svg viewBox="0 0 24 24" fill="none" ' +
             'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
             'stroke-linejoin="round">' + body + '</svg></button>';
    }

    var box = document.createElement('div');
    box.className = 'ptools';
    box.innerHTML =
      btn('Back',    '<path d="M15 18l-6-6 6-6"/>') +
      btn('Forward', '<path d="M9 18l6-6-6-6"/>') +
      btn('Refresh this page', '<path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/>');

    // The bell sits beside the gear: what the app has had to tell this person, and
    // nobody else's - a role that changed, a company handed over, an address
    // waiting to be let in if they are the one who lets people in.
    var bell = document.createElement('div');
    bell.className = 'bellwrap';
    bell.innerHTML =
      btn('Notifications', '<path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/>' +
        '<path d="M13.7 21a2 2 0 01-3.4 0"/>') +
      '<span class="belldot" id="bellDot"></span>' +
      '<div class="bellmenu" id="bellMenu">' +
        '<div class="top"><b>Notifications</b>' +
          '<button id="bellClear">Clear</button></div>' +
        '<div class="ask" id="pushAsk"></div>' +
        '<div id="bellList"><div class="none">Loading…</div></div>' +
      '</div>';
    box.appendChild(bell);

    // Settings sits with them, the way QuickBooks keeps its own gear up here: the
    // company's list of people, your own profile, and how the app looks to you.
    var wrap = document.createElement('div');
    wrap.className = 'setwrap';
    wrap.innerHTML =
      btn('Settings', '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.8M12 18.7v2.8' +
        'M2.5 12h2.8M18.7 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M18.8 5.2l-2 2M7.2 16.8l-2 2"/>') +
      '<div class="setmenu" id="setMenu">' +
        '<div class="cap admin-only">Your company</div>' +
        '<a class="admin-only" href="/users.html">Manage users</a>' +
        '<div class="cap">Profile</div>' +
        '<a href="/settings.html#profile">Your profile</a>' +
        '<div class="cap">Custom changes</div>' +
        '<a href="/settings.html#style">Custom form style</a>' +
        '<a href="/settings.html#theme">Custom theme</a>' +
      '</div>';
    box.appendChild(wrap);

    top.appendChild(box);

    // by where they sit, not by how many buttons happen to be in the box - the
    // bell's own menu has one inside it, and counting would have found that first
    var b = box.querySelectorAll(':scope > button');
    var bellBtn = box.querySelector('.bellwrap > button');
    var gearBtn = box.querySelector('.setwrap > button');

    b[0].addEventListener('click', function(){ history.back(); });
    b[1].addEventListener('click', function(){ history.forward(); });
    b[2].addEventListener('click', function(){
      b[2].classList.add('spin');
      location.reload();
    });

    var menu = document.getElementById('setMenu');
    var bellMenu = document.getElementById('bellMenu');

    gearBtn.addEventListener('click', function(ev){
      ev.stopPropagation();
      menu.classList.toggle('open');
      bellMenu.classList.remove('open');
    });
    document.addEventListener('click', function(){
      menu.classList.remove('open');
      bellMenu.classList.remove('open');
    });
    menu.addEventListener('click', function(ev){ ev.stopPropagation(); });
    bellMenu.addEventListener('click', function(ev){ ev.stopPropagation(); });

    /* ---------- what the bell holds ---------- */

    function ago(t){
      var s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
      if(s < 60) return 'just now';
      if(s < 3600) return Math.floor(s / 60) + ' min ago';
      if(s < 86400) return Math.floor(s / 3600) + ' hr ago';
      if(s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
      return new Date(t).toLocaleDateString();
    }

    function paint(d){
      var items = d.items || [];
      var dot = document.getElementById('bellDot');
      dot.textContent = d.unread > 99 ? '99+' : String(d.unread || '');
      dot.classList.toggle('on', !!d.unread);

      document.getElementById('bellList').innerHTML = items.length
        ? items.map(function(n){
            return '<a class="n' + (n.read_at ? '' : ' new') + '" href="' +
              esc(n.link || '#') + '"><b>' + esc(n.title) + '</b>' +
              (n.body ? '<p>' + esc(n.body) + '</p>' : '') +
              '<time>' + esc(ago(n.created_at)) + '</time></a>';
          }).join('')
        : '<div class="none">Nothing to tell you.</div>';
    }

    function load(){
      return fetch('/api/notifications', { cache:'no-store' })
        .then(function(r){ return r.json(); })
        .then(paint)
        .catch(function(){});
    }

    bellBtn.addEventListener('click', function(ev){
      ev.stopPropagation();
      menu.classList.remove('open');
      var opening = !bellMenu.classList.contains('open');
      bellMenu.classList.toggle('open', opening);
      if(!opening) return;

      checkPush();
      load().then(function(){
        // opening the list is reading it
        fetch('/api/notifications/read', { method:'POST' }).then(function(){
          var dot = document.getElementById('bellDot');
          dot.classList.remove('on');
          dot.textContent = '';
        });
      });
    });

    /* ---------- notices on the phone ---------- */
    // The app makes its own keypair and signs with it; there is no account here
    // and no password of anybody's. The phone is asked once, on a press - never
    // on its own, because a browser refuses a prompt nobody asked for, and
    // rightly. Once it has said yes, the notices arrive with the app closed.

    function b64(s){
      var pad = '='.repeat((4 - s.length % 4) % 4);
      var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
      var out = new Uint8Array(raw.length);
      for(var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    function pushReady(){
      return 'serviceWorker' in navigator && 'PushManager' in window &&
             typeof Notification !== 'undefined';
    }

    // An iPhone will not deliver a notice to a page in a Safari tab, however many
    // times it is asked. Apple gives web push only to a site the person has added
    // to their Home Screen, and a tab has no way to ask on its own. So the tab is
    // told what to do rather than shown a button that cannot work.
    function onIPhone(){
      return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function installed(){
      return window.navigator.standalone === true ||
             (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }

    function askBox(){ return document.getElementById('pushAsk'); }

    function showAsk(state){
      var box = askBox();
      if(!box) return;

      if(state === 'hide'){ box.classList.remove('on'); return; }

      if(state === 'blocked'){
        box.classList.add('on');
        box.innerHTML = '<p>Notifications are blocked for this site. Turn them ' +
          'back on in the browser’s settings for this page.</p>';
        return;
      }

      if(state === 'install'){
        box.classList.add('on');
        box.innerHTML =
          '<p><b>On an iPhone or iPad, add this app to the Home Screen first.</b> ' +
          'Apple only sends notifications to an app that has been added — a ' +
          'Safari tab never gets them, whatever it is asked.</p>' +
          '<p>In Safari, press <b>Share</b> (the square with the arrow), choose ' +
          '<b>Add to Home Screen</b>, then open the app from its new icon and ' +
          'turn notifications on from this bell.</p>';
        return;
      }

      if(state === 'unsupported'){
        box.classList.add('on');
        box.innerHTML = '<p>This browser cannot show notifications. The bell still ' +
          'holds everything, and the count is there whenever you open the app.</p>';
        return;
      }

      box.classList.add('on');
      box.innerHTML =
        '<p>Be told on this phone when somebody is waiting to be let in, or when ' +
        'something of yours changes — even with the app closed.</p>' +
        '<button id="pushOn">Turn on notifications</button>';

      document.getElementById('pushOn').addEventListener('click', function(ev){
        ev.stopPropagation();
        var btn = this;
        btn.disabled = true;
        btn.textContent = 'Asking…';

        Notification.requestPermission().then(function(p){
          if(p !== 'granted'){
            btn.disabled = false;
            btn.textContent = 'Turn on notifications';
            if(p === 'denied') showAsk('blocked');
            return;
          }
          return signUp().then(function(ok){
            if(ok) showAsk('hide');
            else {
              btn.disabled = false;
              btn.textContent = 'Turn on notifications';
            }
          });
        }).catch(function(){
          btn.disabled = false;
          btn.textContent = 'Turn on notifications';
        });
      });
    }

    function signUp(){
      return fetch('/api/push/key', { cache:'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(!d.key) return false;
          return navigator.serviceWorker.ready.then(function(reg){
            return reg.pushManager.getSubscription().then(function(had){
              if(had) return had;
              return reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: b64(d.key)
              });
            });
          }).then(function(s){
            return fetch('/api/push/subscribe', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify(s)
            }).then(function(){ return true; });
          });
        })
        .catch(function(){ return false; });
    }

    // Asked for once the bell is opened, so the offer is in front of somebody who
    // is already thinking about notices.
    function checkPush(){
      if(onIPhone() && !installed()) return showAsk('install');
      if(!pushReady()) return showAsk(onIPhone() ? 'install' : 'unsupported');
      if(Notification.permission === 'denied') return showAsk('blocked');
      if(Notification.permission !== 'granted') return showAsk('ask');

      // Already said yes here - but a cleared browser, or a sign-in on a phone
      // this account has not used before, leaves the server without the phone.
      navigator.serviceWorker.ready.then(function(reg){
        return reg.pushManager.getSubscription();
      }).then(function(s){
        if(s) return signUp().then(function(){ showAsk('hide'); });
        showAsk('ask');
      }).catch(function(){ showAsk('hide'); });
    }

    document.getElementById('bellClear').addEventListener('click', function(ev){
      ev.stopPropagation();
      fetch('/api/notifications/clear', { method:'POST' }).then(load);
    });

    /* ---------- keeping the count honest ---------- */
    // What is wanted here is one number, so one number is what is asked for - not
    // the fifty rows behind it, which are fetched when the bell is opened and the
    // person is actually going to read them.
    //
    // And it is asked for rarely. A notice that matters arrives on the phone the
    // moment it happens; this is only so the red mark is right for somebody
    // sitting in front of the app. Every window open across the company asking
    // every twenty seconds was keeping the database awake around the clock, and
    // the database is charged for being awake.
    //
    // Coming back to the window is the moment somebody would look at the bell, so
    // that is when it is worth asking. A window nobody is looking at asks nothing.
    var COUNT_EVERY = 5 * 60 * 1000;
    var beat = null;
    var lastLook = 0;

    function mark(d){
      var dot = document.getElementById('bellDot');
      if(!dot) return;
      dot.textContent = d.unread > 99 ? '99+' : String(d.unread || '');
      dot.classList.toggle('on', !!d.unread);
    }

    function look(force){
      if(document.hidden) return;
      // coming back to a window twice in a moment is still one look
      if(!force && Date.now() - lastLook < 30000) return;
      lastLook = Date.now();

      fetch('/api/notifications/count', { cache:'no-store' })
        .then(function(r){ return r.json(); })
        .then(mark)
        .catch(function(){});
    }

    function start(){
      if(beat) clearInterval(beat);
      beat = setInterval(function(){ look(true); }, COUNT_EVERY);
    }

    document.addEventListener('visibilitychange', function(){
      if(document.hidden){
        if(beat){ clearInterval(beat); beat = null; }
      } else {
        look(false);
        start();
      }
    });

    // a notice that arrived while the app was shut is on the screen as it opens
    look(true);
    start();
  })();

  /* ---------- the courier tree ---------- */

  (function courierTree(){
    var box = document.getElementById('ctree');
    if(!box) return;

    var css = document.createElement('style');
    css.textContent = [
      '.tcar{margin-left:auto;font-size:9px;opacity:.5;transition:transform .15s;',
      '  display:inline-block}',
      '.tcar.open{transform:rotate(90deg)}',
      '.ctree{margin:2px 0 8px 0;display:none}',
      '.ctree.open{display:block}',
      '.ctree a{display:block;padding:6px 14px 6px 46px;font-size:12.5px;',
      '  color:rgba(255,255,255,.62);text-decoration:none;line-height:1.4}',
      '.ctree a:hover{color:#fff;background:rgba(255,255,255,.05)}',
      '.ctree a.on{color:#fff;background:rgba(255,255,255,.09);font-weight:600}',
      '.ctree a.all{font-weight:600;color:rgba(255,255,255,.78);padding-left:34px}',
      '.ctree .grp{display:flex;align-items:center;gap:8px;cursor:pointer;',
      '  padding:7px 14px 7px 34px;font-size:12px;color:rgba(255,255,255,.62);',
      '  user-select:none;line-height:1.4}',
      '.ctree .grp:hover{color:#fff;background:rgba(255,255,255,.05)}',
      '.ctree .grp .car{font-size:9px;opacity:.55;transition:transform .15s;',
      '  display:inline-block;flex:none;width:9px}',
      '.ctree .grp.open{color:#fff}',
      '.ctree .grp.open .car{transform:rotate(90deg)}',
      '.ctree .grp .soon{font-size:10px;opacity:.5}',
      '.ctree .kids{display:none}',
      '.ctree .kids.open{display:block}',
      '.ctree a.add{padding-left:58px;color:rgba(255,255,255,.4);font-size:12px}',
      '.ctree a.add:hover{color:#fff}',
      '.ctree a.wide{padding-left:34px;margin-top:6px;font-size:12px;',
      '  border-top:1px solid rgba(255,255,255,.08);padding-top:10px}'
    ].join('');
    document.head.appendChild(css);

    var link = document.getElementById('couriersLink');
    var car  = document.getElementById('couriersCar');
    var here = location.pathname + location.search;

    // nothing is open until it is asked for - but a page that belongs to an
    // account should show where it sits
    var onCourierPage = path.indexOf('/courier') === 0 || path === '/receipts.html';
    var open = onCourierPage || localStorage.getItem('ctreeOpen') === '1';

    function setOpen(v){
      open = v;
      box.classList.toggle('open', v);
      if(car) car.classList.toggle('open', v);
      localStorage.setItem('ctreeOpen', v ? '1' : '0');
    }
    setOpen(open);

    // Couriers is a folder, not a page - the page is reached from inside it
    if(link){
      link.addEventListener('click', function(e){
        e.preventDefault();
        setOpen(!open);
      });
    }

    fetch('/api/courier/tree', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.error) return;
        var out = '';

        out += '<a class="all' + (here.indexOf('scope=all') > -1 ? ' on' : '') +
               '" href="/courier-dash.html?scope=all">All courier companies</a>';

        (d.couriers || []).forEach(function(c){
          // only the company whose account is on screen opens itself
          var mine = c.accounts.some(function(a){
            return here.indexOf('account=' + a.id) > -1;
          });

          out += '<div class="grp' + (mine ? ' open' : '') + '">' +
                 '<span class="car">\u25B8</span>' + esc(c.name) +
                 (c.ready ? '' : ' <span class="soon">soon</span>') + '</div>';

          out += '<div class="kids' + (mine ? ' open' : '') + '">';
          // An account is one entry here. What can be done with it - orders,
          // payments, receipts - are tabs inside the account's own page, not
          // more lines in this tree.
          c.accounts.forEach(function(a){
            out += '<a class="acc' + (here.indexOf('account=' + a.id) > -1 ? ' on' : '') +
                   '" href="/courier-dash.html?account=' + a.id + '">' +
                   esc(a.label) + '</a>';
          });
          out += '<a class="add" href="/couriers.html?add=' + esc(c.key) + '">+ add an account</a>';
          out += '</div>';
        });

        out += '<a class="add wide" href="/couriers.html">Manage courier accounts</a>';
        box.innerHTML = out;

        box.querySelectorAll('.grp').forEach(function(g){
          g.addEventListener('click', function(){
            var kids = g.nextElementSibling;
            var now = !g.classList.contains('open');

            // one company open at a time keeps the rail short
            box.querySelectorAll('.grp').forEach(function(other){
              other.classList.remove('open');
              if(other.nextElementSibling) other.nextElementSibling.classList.remove('open');
            });

            g.classList.toggle('open', now);
            if(kids) kids.classList.toggle('open', now);
          });
        });
      })
      .catch(function(){});
  })();

  /* ---------- the one door ---------- */
  // Everybody comes in the same way, so there is one button to press and no choice
  // to get wrong. It asks Intuit only who you are. The server knows which addresses
  // are the company's admins, and walks those - and only those - on to QuickBooks'
  // own connect screen when the company still needs connecting. Every other address
  // arrives as a user: reads and downloads everything, changes what the admin says.
  (function oneDoor(){
    var connect = document.getElementById('btnConnect');
    if(!connect) return;

    connect.textContent = 'Sign in with QuickBooks';
    connect.classList.remove('ghost');
    connect.classList.add('solid');

    // Every page still wires this button to /auth/connect further down its own
    // script, and the id has to stay for that line not to break. The press is
    // taken here first instead, on the way down, so the page's own handler never
    // runs and the accounting door is never opened from a button again.
    document.addEventListener('click', function(ev){
      if(!connect.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      location.href = '/auth/signin';
    }, true);

    var note = document.createElement('div');
    note.style.cssText = 'margin-top:12px;font-size:12px;color:var(--muted);line-height:1.6';
    note.textContent = 'Use your own QuickBooks address, and choose the company you ' +
      'work in. What you may do in the app is the admin’s to decide.';
    if(connect.parentNode) connect.parentNode.appendChild(note);

  })();

  /* ---------- connection state ---------- */
  // Signed in as a user rather than the admin, everything that writes is put away
  // from the rail and from the pages. A rule rather than a sweep, so it holds for
  // what the page draws later too.
  (function(){
    var st = document.createElement('style');
    st.textContent =
      'html.as-user .add, html.as-user .admin-only,' +
      ' html.as-user [data-admin] { display: none !important; }' +
      '.readonly-tag { display:none; margin-top:6px; font-size:11px; letter-spacing:.04em;' +
      ' text-transform:uppercase; color:var(--faint,#8a8a8a) }' +
      'html.as-user .readonly-tag { display:block }';
    document.head.appendChild(st);
  })();

  window.APP = window.APP || {};
  window.APP.ready = fetch('/auth/status')
    .then(function(r){ return r.json(); })
    .then(function(s){
      // the cookie said so before the page drew; the server has the last word
      document.documentElement.classList.toggle('signed-out', !s.signedIn);

      // Signed in, but either nobody has let them in yet or no company is picked.
      // Both are the same screen: one waits there until the admin says yes, the
      // other chooses. Neither is a page of the app, so neither is shown one.
      if(s.signedIn && (!s.connected || !s.letIn) && location.pathname !== '/choose.html'){
        location.replace('/choose.html');
        return s;
      }
      document.documentElement.classList.add(s.admin ? 'as-admin' : 'as-user');

      // A button carries the job it belongs to. Only the jobs this person was not
      // given are hidden - never the whole set, because a page shows and hides its
      // own buttons as a run goes, and a rule that forced them back would undo that.
      var mine = (s.rights || []);
      window.APP.rights = mine;
      window.APP.may = function(job){ return !!s.admin || mine.indexOf(job) > -1; };

      // Given areas rather than the whole of the books: the rail is cut to them.
      // A group whose every line has gone takes its heading with it, so there is
      // no empty word left standing over nothing.
      if(s.limited){
        var off = [];
        rail && rail.querySelectorAll('nav a[data-line]').forEach(function(a){
          if(mine.indexOf(a.getAttribute('data-line')) < 0) off.push(a);
        });
        off.forEach(function(a){
          var tree = a.nextElementSibling;
          if(tree && tree.classList.contains('ctree')) tree.remove();
          a.remove();
        });

        rail && rail.querySelectorAll('nav .group').forEach(function(h){
          var n = h.nextElementSibling, any = false;
          while(n && !n.classList.contains('group')){
            if(n.tagName === 'A'){ any = true; break; }
            n = n.nextElementSibling;
          }
          if(!any) h.remove();
        });
      }

      if(!s.admin){
        var notMine = (s.jobs || []).filter(function(k){ return mine.indexOf(k) < 0; });
        if(notMine.length){
          var off = document.createElement('style');
          off.textContent = notMine.map(function(k){
            return '[data-need="' + k + '"]';
          }).join(',') + '{ display: none !important }';
          document.head.appendChild(off);
        }
      }

      var dot = document.getElementById('dot');
      var txt = document.getElementById('connText');
      if(s.connected){
        if(dot) dot.classList.add('on');
        if(txt) txt.textContent = s.companyName || s.realmId;
      } else {
        if(txt) txt.textContent = 'Not connected';
      }

      // Said once, where the company name is, so it is never a surprise later -
      // but only to somebody who really cannot change anything. A standard user
      // holding jobs writes to the books every day; calling that read only is a
      // lie, and it makes them doubt the buttons they were given.
      if(!s.admin && !mine.length && txt && txt.parentNode &&
         !document.querySelector('.readonly-tag')){
        var tag = document.createElement('div');
        tag.className = 'readonly-tag';
        tag.textContent = 'Read only';
        tag.title = 'You were given no jobs on this company. Everything can be ' +
                    'read and downloaded; changes belong to the admin.';
        txt.parentNode.appendChild(tag);
      }
      return s;
    })
    .catch(function(){ return { connected:false }; });

  /* ---------- company switcher ---------- */
  var box = document.getElementById('connBox');
  var sw  = document.getElementById('switcher');

  if(box && sw){
    box.addEventListener('click', function(e){
      e.stopPropagation();
      if(sw.classList.contains('open')){ sw.classList.remove('open'); return; }
      sw.innerHTML = '<div class="head">Loading…</div>';
      sw.classList.add('open');

      fetch('/auth/companies').then(function(r){ return r.json(); }).then(function(d){
        sw.innerHTML = '<div class="head">QuickBooks companies</div>';
        (d.companies || []).forEach(function(c){
          var b = document.createElement('button');
          b.textContent = c.name;
          if(c.realmId === d.current) b.className = 'cur';
          b.addEventListener('click', function(ev){
            ev.stopPropagation();
            if(c.realmId === d.current){ sw.classList.remove('open'); return; }
            fetch('/auth/switch', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ realmId: c.realmId })
            }).then(function(){ location.reload(); });
          });
          sw.appendChild(b);
        });

        // connecting a company is still the admin's, wherever it is offered from
        var add = document.createElement('button');
        add.className = 'add admin-only';
        add.textContent = '+ Connect another company';
        add.addEventListener('click', function(ev){
          ev.stopPropagation(); location.href = '/auth/connect';
        });
        sw.appendChild(add);

        if(d.current){
          var out = document.createElement('button');
          out.className = 'out';
          out.textContent = 'Disconnect this session';
          out.addEventListener('click', function(ev){
            ev.stopPropagation();
            fetch('/auth/disconnect', { method:'POST' }).then(function(){ location.reload(); });
          });
          sw.appendChild(out);
        }
      }).catch(function(){
        sw.innerHTML = '<div class="head">Could not load companies</div>';
      });
    });

    document.addEventListener('click', function(){ sw.classList.remove('open'); });
    sw.addEventListener('click', function(e){ e.stopPropagation(); });
  }

  /* ---------- a new version has landed ---------- */

  // the watcher lives in update.js so pages without the rail can carry it too
  (function(){
    var s = document.createElement('script');
    s.src = '/update.js';
    document.head.appendChild(s);
  })();

  /* ---------- service worker ---------- */
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      // looked at afresh on every load, so a changed worker is never held back
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(function(){});
    });
  }
})();
