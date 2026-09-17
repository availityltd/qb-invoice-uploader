// Every open copy of the app - the installed app, a browser tab, on any computer -
// is told when a new version has landed, and loads it. Kept on its own so a page
// that does not carry the rail still gets it: nav.js loads it, and a page without
// nav.js includes it directly.
(function(){
  "use strict";
  if(window.__appUpdates) return;
  window.__appUpdates = true;

  /* ---------- a new version has landed ---------- */

  // The app is open on more than one computer, in the installed app and in a
  // browser tab, often for hours. A deploy changes the server at once but not the
  // page already sitting open - which is how one computer came to show a Stop
  // button while the other did not. So every page asks the server which build it
  // is running, now and then and whenever the window comes back into view, and
  // when the answer changes it says so at the top and loads the new version.
  (function updates(){
    var css = document.createElement('style');
    css.textContent = [
      '.upd{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;',
      '  display:flex;align-items:center;gap:12px;padding:10px 14px 10px 16px;border-radius:9px;',
      '  background:#0F2E24;color:#fff;font:500 13px/1.35 var(--sans,system-ui,sans-serif);',
      '  box-shadow:0 8px 24px rgba(0,0,0,.22);max-width:calc(100vw - 28px)}',
      '.upd .dot{width:8px;height:8px;border-radius:50%;background:#7BD88F;flex:none}',
      '.upd small{display:block;font-weight:400;opacity:.75;font-size:11.5px;margin-top:1px}',
      '.upd button{border:1px solid rgba(255,255,255,.35);background:none;color:#fff;border-radius:6px;',
      '  font:inherit;font-size:12px;padding:5px 10px;cursor:pointer;white-space:nowrap}',
      '.upd button.go{background:#fff;color:#0F2E24;border-color:#fff}'
    ].join('');
    document.head.appendChild(css);

    var KEY = 'appUpdated';
    var known = null, box = null, timer = null, later = false;

    function toast(html, buttons){
      if(box) box.remove();
      box = document.createElement('div');
      box.className = 'upd';
      box.setAttribute('role', 'status');
      box.innerHTML = '<span class="dot"></span><div>' + html + '</div>' + (buttons || '');
      document.body.appendChild(box);
      return box;
    }

    // someone halfway through typing into a box would lose it to a reload, so the
    // page waits for them to press the button instead
    function busyTyping(){
      var el = document.activeElement;
      if(!el) return false;
      var tag = (el.tagName || '').toLowerCase();
      return tag === 'textarea' || (tag === 'input' && !/^(button|checkbox|radio|submit)$/i.test(el.type || ''));
    }

    function reloadNow(){
      try { sessionStorage.setItem(KEY, '1'); } catch(e){ /* the reload still happens */ }
      location.reload();
    }

    function landed(){
      if(later) return;
      var wait = 10;
      var b = toast('Update installed<small>Refreshing in <b id="updSecs">' + wait +
        '</b>s to show the latest changes</small>',
        '<button class="go" id="updNow">Refresh now</button><button id="updLater">Later</button>');
      b.querySelector('#updNow').addEventListener('click', reloadNow);
      b.querySelector('#updLater').addEventListener('click', function(){
        later = true;
        clearInterval(timer);
        toast('Update installed<small>Refresh the page when you are ready</small>',
          '<button class="go" id="updNow2">Refresh now</button>')
          .querySelector('#updNow2').addEventListener('click', reloadNow);
      });

      clearInterval(timer);
      timer = setInterval(function(){
        if(busyTyping()) return;
        wait--;
        var n = document.getElementById('updSecs');
        if(n) n.textContent = wait;
        if(wait <= 0){ clearInterval(timer); reloadNow(); }
      }, 1000);
    }

    function check(){
      fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          if(!d || !d.version) return;
          if(known === null){ known = d.version; return; }
          if(d.version !== known){ known = d.version; landed(); }
        })
        // while a deploy is under way the server is briefly not there - the next
        // look finds the new one
        .catch(function(){});
    }

    // said once more after the reload, so every computer shows it landed
    try {
      if(sessionStorage.getItem(KEY)){
        sessionStorage.removeItem(KEY);
        var shown = toast('Update installed<small>You are on the latest version</small>');
        setTimeout(function(){ if(box === shown){ shown.remove(); box = null; } }, 4000);
      }
    } catch(e){ /* nothing to say */ }

    check();
    setInterval(check, 60000);
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) check(); });
    window.addEventListener('focus', check);
  })();

})();
