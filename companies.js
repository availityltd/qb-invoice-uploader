.conn{position:relative;cursor:pointer;user-select:none}
.conn:hover{border-color:#4d6b62}
.conn .caret{font-size:9px;opacity:.7;margin-left:2px}
.switcher{
  position:absolute;top:calc(100% + 6px);right:0;min-width:250px;
  background:#fff;border:1px solid var(--line-2);border-radius:6px;
  box-shadow:0 8px 28px rgba(0,0,0,.18);z-index:200;overflow:hidden;
  display:none
}
.switcher.open{display:block}
.switcher .head{
  padding:9px 14px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--faint);border-bottom:1px solid var(--line);background:var(--panel-2)
}
.switcher button{
  display:block;width:100%;text-align:left;padding:10px 14px;border:0;background:none;
  font:inherit;font-size:13.5px;color:var(--text);cursor:pointer;
  border-bottom:1px solid var(--line)
}
.switcher button:last-child{border-bottom:0}
.switcher button:hover{background:var(--accent-soft)}
.switcher button.cur{font-weight:600;color:var(--qbo)}
.switcher button.cur::after{content:" ✓";font-size:11px}
.switcher .add{color:var(--accent);font-weight:500}
.switcher .out{color:var(--neg)}
