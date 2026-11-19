// Content script (top frame): rule recorder toolbar + profile runner.
(() => {
  if (window.top !== window || window.__aqRules) return;
  window.__aqRules = true;

  const BAR_FALLBACK_H = 48;   // used until the toolbar's real height is measured
  // Speed tuning (milliseconds). Raise these if a slow site skips fields.
  const POLL_MS = 30;            // how often to check that a field/option has appeared
  const AFTER_SELECT_MS = 150;   // pause after a dropdown changes so dependent dropdowns can start loading
  const AFTER_FIELD_MS = 0;      // pause after other fields
  const VERIFY_PASSES = 1;       // re-check passes at the end
  const VERIFY_WAIT_MS = 150;
  const AUTORUN_DELAY_MS = 500;
  const SKIP = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image']);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pageKey = () => location.origin + location.pathname;           // path only
  const fullKey = () => location.origin + location.pathname + location.search;   // path + ?query
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- storage ----------
  // A profile has several pages; each page (URL) has its own field rules:
  //   { id, name, autoRun, pages: [ { url, rules: [...] } ] }
  const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
  // pattern with "?"  -> must equal the full URL;  without "?" -> compared to the path only;  trailing * -> prefix
  const urlMatches = (pattern, full, path) => {
    if (!pattern) return false;
    if (pattern.endsWith('*')) return full.startsWith(pattern.slice(0, -1)) || path.startsWith(pattern.slice(0, -1));
    return pattern.includes('?') ? trimSlash(pattern) === trimSlash(full) : trimSlash(pattern) === trimSlash(path);
  };
  const pageMatches = (pg) => urlMatches(pg.url, fullKey(), pageKey());
  const pageFor = (profile) => (profile.pages || []).find(pageMatches);

  function migrate(list) {   // old format: profile.rules + profile.urlPattern
    let changed = false;
    list.forEach(p => {
      if (!p.pages) {
        p.pages = (p.rules && p.rules.length) || p.urlPattern ? [{ url: p.urlPattern || '', rules: p.rules || [] }] : [];
        delete p.rules; delete p.urlPattern;
        changed = true;
      }
    });
    return changed;
  }
  const getProfiles = async () => {
    const list = (await chrome.storage.local.get('ruleProfiles')).ruleProfiles || [];
    if (migrate(list)) await chrome.storage.local.set({ ruleProfiles: list });
    return list;
  };
  const setProfiles = (p) => chrome.storage.local.set({ ruleProfiles: p });

  // ---------- field helpers ----------
  const isField = (el) => el && el.nodeType === 1 && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  const recordable = (el) => isField(el) && !el.disabled && !SKIP.has((el.type || '').toLowerCase());
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[:*]+\s*$/, '').trim();
  const stableId = (id) => id && !/\d{4,}/.test(id) && !/^(:r|ember|react|ext-|__|mui-)/i.test(id);

  function valueOf(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0';
    if (el.tagName === 'SELECT' && el.multiple) return [...el.selectedOptions].map(o => o.value).join('|');
    return el.value;
  }

  function labelOf(el) {
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    // nearby text: walk back through previous siblings, then up a few levels
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      let s = node.previousElementSibling;
      while (s) {
        if (!s.querySelector || !s.querySelector('input,select,textarea')) {
          const t = clean(s.textContent);
          if (t && t.length <= 60) return t;
        }
        s = s.previousElementSibling;
      }
    }
    return clean(el.placeholder || el.name || el.id);
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (stableId(el.id)) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let n = 1, s = el;
      while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) n++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // ---------- rules ----------
  function buildRule(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    const rule = {
      tag, type,
      id: stableId(el.id) ? el.id : '',
      name: el.name || '',
      label: labelOf(el),
      css: cssPath(el)
    };
    if (rule.name) {
      const same = [...document.getElementsByName(el.name)].filter(x => x.tagName === el.tagName);
      rule.nameIndex = Math.max(0, same.indexOf(el));
    }
    if (tag === 'select' && el.multiple) {
      rule.values = [...el.selectedOptions].map(o => o.value);
      rule.texts = [...el.selectedOptions].map(o => o.text.trim());
    } else if (tag === 'select') {
      rule.value = el.value;
      rule.text = el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '';
    } else if (type === 'checkbox') {
      rule.value = el.value; rule.checked = el.checked;
    } else if (type === 'radio') {
      rule.value = el.value; rule.checked = true;
    } else {
      rule.value = el.value;
    }
    rule.key = (rule.id || rule.name || rule.css) + ((type === 'radio' || type === 'checkbox') ? '=' + rule.value : '');
    return rule;
  }

  function findElement(rule) {
    const ok = (e) => e && e.tagName.toLowerCase() === rule.tag;
    if (rule.id) { const e = document.getElementById(rule.id); if (ok(e)) return e; }
    if (rule.name) {
      const list = [...document.getElementsByName(rule.name)].filter(x => x.tagName.toLowerCase() === rule.tag);
      if (rule.type === 'radio' || rule.type === 'checkbox') {
        const m = list.find(x => x.type === rule.type && x.value === rule.value);
        if (m) return m;
      } else if (list.length) {
        return list[rule.nameIndex] || list[0];
      }
    }
    if (rule.css) { try { const e = document.querySelector(rule.css); if (ok(e)) return e; } catch (_) {} }
    if (rule.label) {
      const m = [...document.querySelectorAll(rule.tag)].find(x => recordable(x) && labelOf(x) === rule.label);
      if (m) return m;
    }
    return null;
  }

  const normTxt = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toLowerCase();
  const findOption = (sel, value, text) => {
    const opts = [...sel.options];
    if (value != null) { const o = opts.find(o => o.value === value); if (o) return o; }     // recorded value (e.g. an id)
    const t = normTxt(text);
    if (!t) return null;
    return opts.find(o => o.text.trim() === String(text).trim())                              // exact visible text
        || opts.find(o => normTxt(o.text) === t)                                              // ignoring case / extra spaces
        || opts.find(o => normTxt(o.value) === t)                                             // the typed value is the option's value
        || (() => { const part = opts.filter(o => o.value !== '' && normTxt(o.text).includes(t)); return part.length === 1 ? part[0] : null; })() || null;   // one option contains it
  };

  function isReady(el, rule) {
    if (el.disabled) return false;
    if (rule.tag !== 'select') return true;
    if (el.multiple) return (rule.values || []).every((v, i) => findOption(el, v, (rule.texts || [])[i]));
    return !!findOption(el, rule.value, rule.text);
  }

  function isApplied(el, rule) {
    if (rule.tag === 'select') {
      if (el.multiple) return [...el.selectedOptions].map(o => o.value).sort().join('|') === [...(rule.values || [])].sort().join('|');
      const opt = findOption(el, rule.value, rule.text);
      return !!opt && el.value === opt.value;
    }
    if (rule.type === 'checkbox') return el.checked === !!rule.checked;
    if (rule.type === 'radio') return el.checked;
    return el.value === rule.value;
  }

  const fire = (el, types) => types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));

  function flash(el) {
    const old = el.style.outline;
    el.style.outline = '2px solid #2e7d32';
    setTimeout(() => { el.style.outline = old; }, 1000);
  }

  // returns 'changed' | 'same' | 'fail'
  function applyRule(el, rule) {
    if (isApplied(el, rule)) return 'same';
    if (rule.tag === 'select') {
      if (el.multiple) {
        [...el.options].forEach(o => { o.selected = (rule.values || []).includes(o.value); });
      } else {
        const opt = findOption(el, rule.value, rule.text);
        if (!opt) return 'fail';
        el.value = opt.value;
      }
      fire(el, ['input', 'change']);
    } else if (rule.type === 'checkbox' || rule.type === 'radio') {
      el.click();   // native click keeps framework state in sync
    } else {
      const proto = rule.tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, rule.value);
      fire(el, ['input', 'change', 'blur']);
    }
    flash(el);
    return 'changed';
  }

  async function waitFor(fn, timeout = 6000) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(POLL_MS);
    }
  }

  async function runProfile(profile, say = () => {}) {
    const rules = profile.rules || [];
    let ok = 0;
    const failed = [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      say(`Filling ${i + 1}/${rules.length}…`);
      const el = await waitFor(() => { const e = findElement(r); return e && isReady(e, r) ? e : null; });
      if (!el) {
        const found = findElement(r), nm = r.label || r.name || r.id || r.css;
        failed.push(found && r.tag === 'select' ? `${nm} (option “${r.text || r.value || ''}” is not in the list)` : nm);
        continue;
      }
      const res = applyRule(el, r);
      if (res !== 'fail') ok++;
      if (res === 'changed') await sleep(r.tag === 'select' ? AFTER_SELECT_MS : AFTER_FIELD_MS);
    }
    // verification passes: re-apply anything a later dropdown reset
    for (let pass = 0; pass < VERIFY_PASSES; pass++) {
      await sleep(VERIFY_WAIT_MS);
      for (const r of rules) {
        const el = findElement(r);
        if (el && isReady(el, r) && !isApplied(el, r)) {
          applyRule(el, r);
          await sleep(r.tag === 'select' ? AFTER_SELECT_MS : AFTER_FIELD_MS);
        }
      }
    }
    return { ok, failed, total: rules.length };
  }

  // ---------- recorder ----------
  const changed = new Set();
  let baseline = new WeakMap();

  function snapshot() {
    baseline = new WeakMap();
    document.querySelectorAll('input,select,textarea').forEach(el => baseline.set(el, valueOf(el)));
  }

  function effectiveChanged() {
    return [...changed].filter(el => {
      if (!el.isConnected || !recordable(el)) return false;
      if (el.type === 'radio' && !el.checked) return false;
      const cur = valueOf(el);
      if (baseline.has(el)) return baseline.get(el) !== cur;
      return el.type === 'checkbox' ? el.checked : cur !== '';
    });
  }

  function onUserEvent(e) {
    if (!e.isTrusted) return;           // ignore our own programmatic fills
    const el = e.target;
    if (!recordable(el)) return;
    changed.delete(el); changed.add(el);   // keep the order you actually edited in
    updateStatus();
  }

  // ---------- UI (shadow DOM so page CSS can't interfere) ----------
  let host = null, root = null, barOpen = false;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:100%;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:"Segoe UI",system-ui,sans-serif}
  #bar{display:flex;flex-wrap:wrap;align-items:center;gap:3px 8px;padding:4px 10px;
       background:linear-gradient(180deg,#0f6b7a,#0b5260);color:#fff;font-size:12px;line-height:1.2;
       box-shadow:0 2px 6px rgba(0,0,0,.35);border-bottom:1px solid rgba(255,255,255,.18)}
  #bar[hidden]{display:none}
  .brand{display:flex;align-items:center;gap:4px;font-weight:700;font-size:13px;white-space:nowrap}
  .logo{color:#ffd166}
  .group{display:flex;align-items:center;flex-wrap:wrap;gap:3px 6px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.11)}
  .gl{font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#bfe9ef}
  select,.btn{height:24px;font:inherit;font-size:12px;border-radius:5px;border:1px solid rgba(0,0,0,.22)}
  select{padding:0 3px;background:#fff;color:#111;max-width:150px}
  #pg{max-width:112px}
  .btn{padding:0 9px;background:#fff;color:#0b5260;font-weight:600;cursor:pointer;white-space:nowrap}
  .btn:hover{background:#e6f6f8}
  .btn.accent{background:#ffd166;color:#3a2a00;border-color:#d6a93a}
  .btn.accent:hover{background:#ffdc85}
  .step{display:flex;align-items:center;gap:4px;white-space:nowrap}
  .step i{width:17px;height:17px;border-radius:50%;background:#f59e0b;color:#fff;font-style:normal;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center}
  .btn.link{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.35)}
  .btn.link:hover{background:rgba(255,255,255,.28)}
  #msg{margin-left:auto;padding:2px 9px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px;background:rgba(0,0,0,.22);color:#ffe08a;font-weight:600}
  #msg:empty{display:none}
  #msg.ok{color:#a7f3c0}
  .ib{width:24px;height:24px;border:none;border-radius:5px;background:transparent;color:#d5f1f5;font-size:16px;line-height:1;cursor:pointer;padding:0}
  .ib:hover{background:rgba(255,255,255,.18);color:#fff}
  #close{font-size:19px}
  #msg:empty + #fold{margin-left:auto}
  #bar.min .rec{display:none}
  #ask{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,30,40,.5)}
  #ask[hidden]{display:none}
  #ask .card{width:min(400px,92vw);background:#fff;color:#1f2933;border-radius:12px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  #ask h3{margin:0 0 10px;font-size:15px}
  #ask label{display:block;font-size:12px;font-weight:600;color:#52606d;margin:8px 0 3px}
  #ask input{width:100%;height:32px;padding:0 8px;border:1px solid #cbd2d9;border-radius:6px;font:inherit;font-size:14px}
  #ask input:focus{outline:2px solid #0f6cbd;outline-offset:-1px}
  #ask .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  #ask .btn{border:1px solid #cbd2d9}
  #toast{position:fixed;top:60px;right:14px;max-width:360px;padding:9px 13px;background:#1f2933;color:#fff;border-radius:8px;font-size:13px;line-height:1.35;box-shadow:0 4px 14px rgba(0,0,0,.35)}
  #toast[hidden]{display:none}
</style>
<div id="bar" hidden>
  <div class="brand"><span class="logo">⚡</span>AutoFill</div>
  <div class="group">
    <span class="gl" title="The active profile is used by auto-run and the Alt+Shift+E shortcut. Only one can be active.">Active</span>
    <select id="exec" title="Active profile - pick another to switch"></select>
    <button id="run" class="btn" title="Run all pages of the profile, in order">▶ Run</button>
    <button id="runPage" class="btn" title="Fill only this page's rules">▶ Page</button>
  </div>
  <div class="group rec">
    <span class="gl">Record</span>
    <span class="step"><i>1</i>Fill form</span>
    <span class="step"><i>2</i><select id="gen" title="Profile to save into"></select><select id="pg" title="Which page of the profile these rules belong to"></select></span>
    <span class="step"><i>3</i><button id="genBtn" class="btn accent" title="Save the fields you changed as rules in the chosen profile and page">Generate Rules</button></span>
    <button id="pickBtn" class="btn" title="Pick the button (e.g. Search) that is clicked after this page is filled">Click-after</button>
  </div>
  <button id="details" class="btn link" title="Open the details page: all profiles, pages and rules">☰ Details</button>
  <span id="msg"></span>
  <button id="fold" class="ib" title="Hide the record tools">⌃</button>
  <button id="close" class="ib" title="Close toolbar">×</button>
</div>
<div id="ask" hidden><div class="card">
  <h3 id="askTitle"></h3>
  <div id="askFields"></div>
  <div class="row"><button id="askOk" class="btn accent">Run</button><button id="askCancel" class="btn">Cancel</button></div>
</div></div>
<div id="toast" hidden></div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    $('close').onclick = () => setBar(false);
    $('fold').onclick = () => setMini(!$('bar').classList.contains('min'), true);
    $('run').onclick = () => execSelected();
    $('runPage').onclick = runThisPage;
    $('details').onclick = () => chrome.runtime.sendMessage({ type: 'openDetails', profileId: $('gen').value || $('exec').value || '' });
    $('pg').onchange = onPgChange;
    $('exec').onchange = () => {            // changing this select switches the one active profile
      const id = $('exec').value;
      chrome.storage.local.set({ activeProfile: id });
      remember(id);
      say(id ? `“${$('exec').selectedOptions[0].text.replace(/^● /, '').replace(/ \(this page\)$/, '')}” is now the active profile.` : 'No active profile.', true);
    };
    $('gen').onchange = async () => { await onGenChange(); remember($('gen').value); renderPageSelect(); };
    $('pickBtn').onclick = startPick;
    $('genBtn').onclick = generate;
    chrome.storage.onChanged.addListener((c) => { if (c.ruleProfiles || c.activeProfile) renderSelects(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (barOpen) layoutPage(); }).observe($('bar'));
  }

  // dialog for {{ask}} variables: resolves { key: value } or null when cancelled
  function askVars(items, title) {
    ensureUI();
    return new Promise((resolve) => {
      $('askTitle').textContent = `Run “${title}” - enter values`;
      const box = $('askFields'); box.innerHTML = '';
      const inputs = items.map((it, i) => {
        const lab = document.createElement('label'); lab.textContent = it.label;
        const inp = document.createElement('input'); inp.type = 'text'; inp.value = it.def || '';
        lab.appendChild(inp); box.appendChild(lab);
        return [it.key, inp];
      });
      const done = (ok) => {
        $('ask').hidden = true;
        $('askOk').onclick = $('askCancel').onclick = null;
        resolve(ok ? Object.fromEntries(inputs.map(([k, inp]) => [k, inp.value])) : null);
      };
      $('askOk').onclick = () => done(true);
      $('askCancel').onclick = () => done(false);
      $('ask').onkeydown = (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
      $('ask').hidden = false;
      if (inputs[0]) inputs[0][1].focus();
    });
  }

  // compact mode: hide the Record tools and keep just the Active/Run controls
  function setMini(mini, persist) {
    $('bar').classList.toggle('min', mini);
    $('fold').textContent = mini ? '⌄' : '⌃';
    $('fold').title = mini ? 'Show the record tools' : 'Hide the record tools';
    if (persist) chrome.storage.local.set({ toolbarMini: mini });
  }

  // remember the profile picked last (shared with the popup)
  const remember = (id) => { if (id && id !== '__new__') chrome.storage.local.set({ selectedProfile: id }); };

  // ----- keep the site fully visible: push the page down by the toolbar's height, incl. fixed/sticky headers -----
  const shifted = new Map();      // element -> { base: original top (px), inline: original inline top, prio }
  let scanTimer = null, prevMargin = '', prevPrio = '';

  function barHeight() { const b = root && root.getElementById('bar'); return (b && Math.round(b.getBoundingClientRect().height)) || BAR_FALLBACK_H; }

  function scanPinned() {
    if (!document.body) return;
    const all = document.body.querySelectorAll('*');
    const limit = Math.min(all.length, 6000);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (shifted.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const top = parseFloat(cs.top);
      if (!isFinite(top) || top > 60) continue;          // only things pinned to the top edge
      shifted.set(el, { base: top, inline: el.style.getPropertyValue('top'), prio: el.style.getPropertyPriority('top') });
    }
  }

  function layoutPage() {
    const h = barHeight();
    document.documentElement.style.setProperty('margin-top', h + 'px', 'important');
    shifted.forEach((o, el) => el.style.setProperty('top', (o.base + h) + 'px', 'important'));
    const t = root.getElementById('toast'); if (t) t.style.top = (h + 10) + 'px';
  }

  function pushPageDown() {
    prevMargin = document.documentElement.style.getPropertyValue('margin-top');
    prevPrio = document.documentElement.style.getPropertyPriority('margin-top');
    scanPinned();
    layoutPage();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { if (barOpen) { scanPinned(); layoutPage(); } }, 1200);   // catch late-rendered headers
  }

  function restorePage() {
    clearTimeout(scanTimer);
    const de = document.documentElement.style;
    if (prevMargin) de.setProperty('margin-top', prevMargin, prevPrio); else de.removeProperty('margin-top');
    shifted.forEach((o, el) => { if (o.inline) el.style.setProperty('top', o.inline, o.prio); else el.style.removeProperty('top'); });
    shifted.clear();
  }

  const $ = (id) => root.getElementById(id);

  function say(msg, ok) { if (!root) return; const m = $('msg'); m.textContent = msg; m.title = msg; m.className = ok ? 'ok' : ''; }
  let toastTimer;
  function toast(msg, sticky, long) {
    ensureUI();
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, long ? 15000 : 5000);
  }

  function updateStatus() {
    if (!barOpen) return;
    const n = effectiveChanged().length;
    say(n ? `${n} field${n > 1 ? 's have' : ' has'} been changed.` : 'No fields have been changed.');
  }

  async function renderSelects() {
    if (!root) return;
    const profiles = await getProfiles();
    const keepGen = $('gen').value;
    const st = await chrome.storage.local.get(['selectedProfile', 'activeProfile']);
    const active = profiles.some(p => p.id === st.activeProfile) ? st.activeProfile : '';
    const mk = (none, extra) => {
      let h = `<option value="">${none}</option>`;
      profiles.forEach(p => {
        const label = (p.id === active ? '● ' : '') + p.name + (pageFor(p) ? ' (this page)' : '');
        h += `<option value="${p.id}">${esc(label)}</option>`;
      });
      return h + (extra || '');
    };
    $('exec').innerHTML = mk('- none -');
    $('exec').value = active;                              // the Active select always shows the active profile
    $('gen').innerHTML = mk('- select -', '<option value="__new__">+ New profile…</option>');
    const remembered = profiles.find(p => p.id === st.selectedProfile);
    const fallback = (profiles.find(p => p.id === active) || remembered || profiles.find(p => pageFor(p)) || {}).id;
    if (profiles.some(p => p.id === keepGen)) $('gen').value = keepGen;
    else if (fallback && !keepGen) $('gen').value = fallback;
    await renderPageSelect();
  }

  const esc = (t) => String(t).replace(/[<&"]/g, c => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' }[c]));
  const shortUrl = (u) => { const t = String(u || '').replace(/^https?:\/\/[^/]+/, '') || '/'; return t.length > 30 ? t.slice(0, 29) + '…' : t; };

  let prevPg = 'auto';
  const setPg = (v) => { $('pg').value = v; prevPg = $('pg').value; };

  async function renderPageSelect() {
    if (!root) return;
    const keep = $('pg').value;
    const p = (await getProfiles()).find(x => x.id === $('gen').value);
    let h = '<option value="auto">Page: auto</option><option value="new">+ New page</option>';
    if (p) p.pages.forEach((pg, i) => { h += `<option value="${i}">${i + 1}. ${esc(shortUrl(pg.url))}</option>`; });
    $('pg').innerHTML = h;
    if ([...$('pg').options].some(o => o.value === keep)) $('pg').value = keep;
    prevPg = $('pg').value;
  }

  // Which page of the profile do new rules go to?  auto = the page matching this URL (or a new one)
  function targetPage(p) {
    const mode = $('pg').value;
    p.pages = p.pages || [];
    if (/^\d+$/.test(mode) && p.pages[+mode]) return p.pages[+mode];
    if (mode !== 'new') {
      const found = p.pages.find(x => !x.url.endsWith('*') && pageMatches(x));
      if (found) return found;
    }
    const pg = { url: fullKey(), rules: [] };
    p.pages.push(pg);
    return pg;
  }

  // Choosing another page of the profile opens that page's URL, then the toolbar comes back with its rules active.
  async function onPgChange() {
    const v = $('pg').value;
    if (!/^\d+$/.test(v)) { prevPg = v; return; }          // auto / new page: stay here
    const idx = +v;
    const n = effectiveChanged().length;
    if (n && !confirm(`${n} changed field${n > 1 ? 's are' : ' is'} not saved yet. Switch page anyway?`)) { setPg(prevPg); return; }
    const p = (await getProfiles()).find(x => x.id === $('gen').value);
    const pg = p && p.pages[idx];
    if (!pg) return;
    if (pageMatches(pg)) { prevPg = v; say(`Page ${idx + 1} active · ${pg.rules.length} rule${pg.rules.length === 1 ? '' : 's'}.`, true); return; }
    say(`Opening page ${idx + 1}…`, true);
    const res = await chrome.runtime.sendMessage({ type: 'switchPage', profileId: p.id, index: idx }).catch(() => null);
    if (!res || res.error) {
      say(res && res.error === 'cannot-open' ? "Can't open a wildcard page - go to it yourself." : 'Could not switch page.');
      setPg(prevPg);
    }
  }

  async function runThisPage() {
    const id = $('exec').value || $('gen').value;
    if (!id) { say('Choose a profile first.'); return; }
    const p = (await getProfiles()).find(x => x.id === id);
    if (!p) return;
    const idx = ($('gen').value === id && /^\d+$/.test($('pg').value)) ? +$('pg').value : p.pages.findIndex(pageMatches);
    if (idx < 0 || !p.pages[idx]) { say('This profile has no rules for this page.'); return; }
    chrome.runtime.sendMessage({ type: 'runChain', profileId: id, only: idx });
    say(`Filling page ${idx + 1}…`, true);
  }

  // ----- "click after filling" (e.g. the Search button) -----
  const CLICKABLE = 'button, input[type=submit], input[type=button], input[type=image], a[href], [role=button]';
  const SWALLOW = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click'];
  const textOf = (e) => clean(e.value || e.textContent || e.title || e.getAttribute('aria-label') || '').slice(0, 60);
  let picking = false;

  function swallow(e) {
    const t = e.target;
    if (t === host || (host && host.contains(t))) return;       // clicks on our own toolbar
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    stopPick();
    const el = t.closest ? (t.closest(CLICKABLE) || t) : t;
    savePick(el);
  }
  function stopPick() { picking = false; SWALLOW.forEach(t => document.removeEventListener(t, swallow, true)); }
  function startPick() {
    const id = $('gen').value;
    if (!id || id === '__new__') { say('Choose a profile first (step 2).'); return; }
    if (picking) { stopPick(); say('Cancelled.'); return; }
    picking = true;
    SWALLOW.forEach(t => document.addEventListener(t, swallow, true));
    say('Now click the button to press after filling (click again here to cancel).');
  }
  async function savePick(el) {
    const profiles = await getProfiles();
    const p = profiles.find(x => x.id === $('gen').value);
    if (!p) { say('Profile not found.'); return; }
    const pg = targetPage(p);
    pg.after = { tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), id: stableId(el.id) ? el.id : '', name: el.name || '', text: textOf(el), css: cssPath(el) };
    await setProfiles(profiles);
    await renderPageSelect();
    setPg(String(p.pages.indexOf(pg)));
    say(`Saved: after filling, click "${pg.after.text || pg.after.tag}".`, true);
  }
  function findAfter(a) {
    const ok = (e) => e && e.tagName.toLowerCase() === a.tag;
    if (a.id) { const e = document.getElementById(a.id); if (ok(e)) return e; }
    const byText = [...document.querySelectorAll(a.tag)].find(x => a.text && textOf(x) === a.text && (!a.name || x.name === a.name));
    if (byText) return byText;
    if (a.css) { try { const e = document.querySelector(a.css); if (ok(e)) return e; } catch (_) {} }
    return null;
  }

  async function onGenChange() {
    if ($('gen').value !== '__new__') return;
    const name = (prompt('Name for the new profile:') || '').trim();
    if (!name) { $('gen').value = ''; return; }
    const profiles = await getProfiles();
    const p = { id: uid(), name, autoRun: false, pages: [] };
    profiles.push(p);
    await setProfiles(profiles);
    const st = await chrome.storage.local.get('activeProfile');
    if (!profiles.some(x => x.id === st.activeProfile)) await chrome.storage.local.set({ activeProfile: p.id });   // first profile becomes active
    await renderSelects();
    $('gen').value = p.id;
  }

  async function generate() {
    const list = effectiveChanged();
    if (!list.length) { say('No fields have been changed.'); return; }
    const id = $('gen').value;
    if (!id || id === '__new__') { say('Choose a profile first (step 2).'); return; }
    const profiles = await getProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) { say('Profile not found.'); return; }
    const fresh = list.map(buildRule);
    p.pages = p.pages || [];
    const page = targetPage(p);               // this profile's rules for THIS page
    fresh.forEach(r => {
      const i = page.rules.findIndex(x => x.key === r.key);
      if (i >= 0) page.rules.splice(i, 1);    // replace older rule for the same field
      page.rules.push(r);                     // keep the order you edited in
    });
    await setProfiles(profiles);
    changed.clear(); snapshot();
    await renderPageSelect();
    setPg(String(p.pages.indexOf(page)));
    say(`Saved ${fresh.length} rule${fresh.length > 1 ? 's' : ''} to "${p.name}" · page ${p.pages.indexOf(page) + 1}.`, true);
  }

  async function execSelected() {
    const id = $('exec').value;
    if (!id) { say('Choose a profile to execute.'); return; }
    chrome.runtime.sendMessage({ type: 'runChain', profileId: id });   // background opens each page in turn
    say('Running profile…', true);
  }

  async function execute(profile) {
    const page = pageFor(profile);
    if (!page || !page.rules.length) { toast(`"${profile.name}" has no rules for this page.`); return { ok: 0, failed: [], total: 0 }; }
    toast(`Running "${profile.name}"…`, true);
    const res = await runProfile({ rules: page.rules }, (m) => toast(m, true));
    toast(res.failed.length
      ? `Filled ${res.ok}/${res.total}. Not found: ${res.failed.join(', ')}`
      : `Done - filled ${res.ok} field${res.ok === 1 ? '' : 's'}.`);
    return res;
  }

  async function setBar(open) {
    ensureUI();
    barOpen = open;
    $('bar').hidden = !open;
    if (open) {
      pushPageDown();
      setMini(!!(await chrome.storage.local.get('toolbarMini')).toolbarMini, false);
      snapshot(); changed.clear();
      await renderSelects();
      updateStatus();
    } else {
      restorePage();
      changed.clear();
    }
  }

  document.addEventListener('input', onUserEvent, true);
  document.addEventListener('change', onUserEvent, true);

  // ---------- messages from popup / background ----------
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    (async () => {
      if (msg.type === 'toggleBar') { setBar(!barOpen); send({ open: barOpen }); }
      else if (msg.type === 'getKey') send({ key: fullKey(), path: pageKey(), version: chrome.runtime.getManifest().version });
      else if (msg.type === 'clickAfter') {
        const el = await waitFor(() => { const e = findAfter(msg.after); return e && !e.disabled ? e : null; }, 6000);
        send({ clicked: !!el });
        if (el) setTimeout(() => el.click(), 30);      // reply first: the click may navigate away
      }
      else if (msg.type === 'openBar') {
        if (!barOpen) await setBar(true); else await renderSelects();
        $('gen').value = msg.profileId;
        await renderPageSelect();
        const p = (await getProfiles()).find(x => x.id === msg.profileId);
        if (msg.pageIndex == null) {
          setPg('auto');
          say(`${p ? p.name : 'Profile'} selected - fill the form, then press Generate Rules.`, true);
        } else {
          setPg(String(msg.pageIndex));
          const pg = p && p.pages[msg.pageIndex];
          say(pg ? `Page ${msg.pageIndex + 1} active · ${pg.rules.length} rule${pg.rules.length === 1 ? '' : 's'}.` : '', true);
        }
        send({ ok: true });
      }
      else if (msg.type === 'askVars') {
        const values = await askVars(msg.items, msg.title);
        send(values ? { values } : { cancelled: true });
      }
      else if (msg.type === 'toast') { toast(msg.text, false, msg.long); send({ ok: true }); }
      else if (msg.type === 'runPageRules') {
        toast(`${msg.label} · filling…`, true);
        const res = await runProfile({ rules: msg.rules }, (m) => toast(`${msg.label} · ${m}`, true));
        send(res);
      }
    })();
    return true;
  });

  // ---------- auto-run ----------
  (async () => {
    const key = pageKey();
    const activeId = (await chrome.storage.local.get('activeProfile')).activeProfile;
    const list = (await getProfiles()).filter(p => p.id === activeId && p.autoRun && pageFor(p));   // only the active profile auto-runs
    if (!list.length) return;
    const gate = await chrome.runtime.sendMessage({ type: 'canAutoRun' }).catch(() => null);
    if (gate && gate.ok === false) return;    // a multi-page run is already driving this tab
    await sleep(AUTORUN_DELAY_MS);
    for (const p of list) {
      const idx = p.pages.findIndex(pageMatches);
      chrome.runtime.sendMessage({ type: 'runChain', profileId: p.id, only: idx, auto: true });   // background fills variables, runs this page only
    }
  })();
})();
