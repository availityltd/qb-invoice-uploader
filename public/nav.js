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
      'html.signed-out .main { margin-left:0 !important }';
    (document.head || document.documentElement).appendChild(st);

    if(!/(?:^|;\s*)signed=1(?:;|$)/.test(document.cookie)){
      document.documentElement.classList.add('signed-out');
    }
  })();

  var ITEMS = [
    { group: null, items: [
      { href:'/',              label:'Dashboard',        icon:'grid' }
    ]},
    { group: 'Import invoices', items: [
      { href:'/convert.html',  label:'Convert',          icon:'shuffle' },
      { href:'/upload.html',   label:'Upload',           icon:'up' }
    ]},
    { group: 'Payments', items: [
      { href:'/payments.html', label:'Receive payments', icon:'cash' },
      { href:'/advance.html',  label:'Advance payments', icon:'wallet' },
      { href:'/charges.html',  label:'Delivery charges', icon:'receipt' },
            { href:'/find.html',     label:'Find orders',      icon:'search' },
      { href:'/couriers.html', label:'Couriers',         icon:'truck', tree:true }
    ]},
    { group: 'Products', items: [
      // cost, stock, duplicates and the reports behind them are tabs of one page
      { href:'/products.html',  label:'Product health',  icon:'tag' },
      { href:'/purchases.html', label:'Purchases',       icon:'cart' }
    ]},
    { group: 'Maintenance', items: [
      { href:'/fix.html',      label:'Fix duplicates',   icon:'copy' },
      // Product, Category and Description are tabs of one page, not three
      // lines in the rail - a new kind of change is a new tab, not a new link
      { href:'/replace.html',  label:'Changes',          icon:'swap' },
      { href:'/void.html',     label:'Void invoices',    icon:'ban' }
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
      // Merge payments is a tab of Receive payments, so that is what lights up
      var on = (it.href === path) || (it.href !== '/' && path.indexOf(it.href) === 0) ||
               (it.href === '/payments.html' && path === '/merge.html') ||
               // every tab of the changes page lights up the one link
               (it.href === '/replace.html' &&
                (path === '/swap.html' || path === '/recat.html' || path === '/desc.html'));
      html += '<a href="' + it.href + '"' +
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
      '.setmenu a:hover{background:var(--panel-2);color:var(--qbo)}'
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

    var b = box.querySelectorAll('button');
    b[0].addEventListener('click', function(){ history.back(); });
    b[1].addEventListener('click', function(){ history.forward(); });
    b[2].addEventListener('click', function(){
      b[2].classList.add('spin');
      location.reload();
    });

    var menu = document.getElementById('setMenu');
    b[3].addEventListener('click', function(ev){
      ev.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function(){ menu.classList.remove('open'); });
    menu.addEventListener('click', function(ev){ ev.stopPropagation(); });
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
    note.textContent = 'Use your own QuickBooks address. What you may do in the app ' +
      'is decided by the company admin.';
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
      document.documentElement.classList.add(s.admin ? 'as-admin' : 'as-user');

      // A button carries the job it belongs to. Only the jobs this person was not
      // given are hidden - never the whole set, because a page shows and hides its
      // own buttons as a run goes, and a rule that forced them back would undo that.
      var mine = (s.rights || []);
      window.APP.rights = mine;
      window.APP.may = function(job){ return !!s.admin || mine.indexOf(job) > -1; };
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

      // said once, where the company name is, so it is never a surprise later
      if(!s.admin && txt && txt.parentNode && !document.querySelector('.readonly-tag')){
        var tag = document.createElement('div');
        tag.className = 'readonly-tag';
        tag.textContent = 'Read only';
        tag.title = 'You are signed in as a user. Everything can be read and ' +
                    'downloaded; changes belong to the admin.';
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
