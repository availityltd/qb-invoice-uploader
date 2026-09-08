(function(){
  "use strict";

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
      { href:'/merge.html',    label:'Merge payments',   icon:'merge' },
      { href:'/advance.html',  label:'Advance payments', icon:'wallet' },
      { href:'/charges.html',  label:'Delivery charges', icon:'receipt' },
            { href:'/find.html',     label:'Find orders',      icon:'search' },
      { href:'/couriers.html', label:'Couriers',         icon:'truck', tree:true }
    ]},
    { group: 'Maintenance', items: [
      { href:'/fix.html',      label:'Fix duplicates',   icon:'copy' },
      { href:'/void.html',     label:'Void invoices',    icon:'ban' }
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
    merge:  '<path d="M6 3v6a6 6 0 006 6h6"/><path d="M18 3v6a6 6 0 01-6 6"/>' +
            '<path d="M15 18l3 3-3 3" transform="translate(0,-6)"/>'
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
      var on = (it.href === path) || (it.href !== '/' && path.indexOf(it.href) === 0);
      html += '<a href="' + it.href + '"' + (on ? ' class="on"' : '') +
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
      '@keyframes ptspin{to{transform:rotate(360deg)}}'
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

    top.appendChild(box);

    var b = box.querySelectorAll('button');
    b[0].addEventListener('click', function(){ history.back(); });
    b[1].addEventListener('click', function(){ history.forward(); });
    b[2].addEventListener('click', function(){
      b[2].classList.add('spin');
      location.reload();
    });
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

  /* ---------- connection state ---------- */
  window.APP = window.APP || {};
  window.APP.ready = fetch('/auth/status')
    .then(function(r){ return r.json(); })
    .then(function(s){
      var dot = document.getElementById('dot');
      var txt = document.getElementById('connText');
      if(s.connected){
        if(dot) dot.classList.add('on');
        if(txt) txt.textContent = s.companyName || s.realmId;
      } else {
        if(txt) txt.textContent = 'Not connected';
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

        var add = document.createElement('button');
        add.className = 'add';
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

  /* ---------- service worker ---------- */
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/sw.js').catch(function(){});
    });
  }
})();
