const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const status = (msg, cls) => { const s = $('status'); s.textContent = msg; s.className = cls || ''; };

let selectedId = '';
let activeId = '';
let lastWrite = 0;
let view = 'profile';          // 'profile' | 'help'
let helpOpen = 'start';        // which help section is expanded
let nextRun = null;            // { profileId, doneIndex, nextIndex, tabId, filled, total, notes } after a single-page run finishes

// ---------- storage ----------
function migrate(list) {
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
async function loadProfiles() {
  const list = (await chrome.storage.local.get('ruleProfiles')).ruleProfiles || [];
  if (migrate(list)) await chrome.storage.local.set({ ruleProfiles: list });
  return list;
}
async function saveProfiles(list) { lastWrite = Date.now(); await chrome.storage.local.set({ ruleProfiles: list }); }

let writeQueue = Promise.resolve();      // edits are applied one after another so two quick changes cannot overwrite each other
function mutate(fn) {
  const run = async () => { const all = await loadProfiles(); fn(all); await saveProfiles(all); };
  writeQueue = writeQueue.then(run).catch((e) => {          // a failed edit must not block the edits after it
    console.error('Quick AutoFill: could not save', e);
    status('Could not save that change - reload this page and try again.', 'err');
  });
  return writeQueue;
}
async function setActive(id) { activeId = id || ''; lastWrite = Date.now(); await chrome.storage.local.set({ activeProfile: activeId }); }
async function setSelected(id) { selectedId = id || ''; await chrome.storage.local.set({ selectedProfile: selectedId }); }
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// MTIS-25 Mark Assign -> MTIS-26 Mark Assign (bumps the last number); otherwise adds "(copy)"
function suggestCopyName(name) {
  const m = /(\d+)(?!.*\d)/.exec(name);
  if (!m) return `${name} (copy)`;
  const next = String(parseInt(m[1], 10) + 1).padStart(m[1].length, '0');
  return name.slice(0, m.index) + next + name.slice(m.index + m[1].length);
}

function describeRule(r) {
  if (r.tag === 'select' && Array.isArray(r.values)) return { text: (r.texts || r.values || []).join(', '), editable: false, kind: 'multi-select' };
  if (r.tag === 'select') return { text: r.text || r.value || '', editable: true, kind: 'dropdown' };
  if (r.type === 'checkbox') return { text: r.checked ? 'checked' : 'unchecked', editable: false, kind: 'checkbox' };
  if (r.type === 'radio') return { text: 'selected: ' + r.value, editable: false, kind: 'radio' };
  return { text: r.value || '', editable: true, kind: r.tag === 'textarea' ? 'textarea' : (r.type || 'text') };
}

// ---------- dialogs ----------
function openDialog(dlg) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
function closeDialog(dlg) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }

// values for {{ask:…}} when a profile runs -> resolves { key: value } or null when cancelled
function askDialog(items, heading, okText = 'Run') {
  return new Promise((resolve) => {
    const dlg = $('askDlg');
    $('askTitle').textContent = heading;
    $('askOk').textContent = okText;
    const box = $('askFields'); box.innerHTML = '';
    const inputs = items.map(it => {
      const inp = el('input', { type: 'text', value: it.def || '' });
      box.append(el('label', { className: 'asklabel' }, it.label, inp));
      return [it.key, inp];
    });
    let finished = false;
    const done = (ok) => {
      if (finished) return; finished = true;
      closeDialog(dlg);
      resolve(ok ? Object.fromEntries(inputs.map(([k, inp]) => [k, inp.value])) : null);
    };
    $('askOk').onclick = (e) => { e.preventDefault(); done(true); };
    $('askCancel').onclick = () => done(false);
    dlg.oncancel = () => done(false);                        // Esc
    openDialog(dlg);
    if (inputs[0]) inputs[0][1].focus();
  });
}

// Key / Value / Action table. Edits `vars` in place; hooks.input() fires while typing, hooks.commit() when an edit is finished.
function buildVarTable(vars, hooks = {}) {
  const wrap = el('div', { className: 'vtable' });
  const selfRef = (v) => {
    const k = String(v.name || '').trim();
    return !!k && new RegExp('\\{\\{\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}\\}', 'i').test(v.value || '');
  };
  const build = (focusLast) => {
    wrap.innerHTML = '';
    wrap.append(el('div', { className: 'vrow vhead' }, el('span', { textContent: 'Key' }), el('span', { textContent: 'Value' }), el('span', { className: 'act', textContent: 'Action' })));
    if (!vars.length) wrap.append(el('div', { className: 'vempty', textContent: hooks.emptyText || 'No variables yet.' }));
    let lastKey = null;
    vars.forEach((v, i) => {
      const key = el('input', { type: 'text', value: v.name || '', placeholder: 'e.g. exam_year', spellcheck: false });
      const val = el('input', { type: 'text', value: v.value || '', placeholder: 'e.g. 2027' });
      const warn = el('div', { className: 'vwarn' });
      const check = () => {
        warn.textContent = selfRef(v) ? `The value of “${v.name}” points back to itself. Type the real value (for example 2027), otherwise you will be asked for it when you run.` : '';
        warn.hidden = !warn.textContent;
      };
      key.oninput = () => { v.name = key.value.trim(); check(); hooks.input && hooks.input(); };
      val.oninput = () => { v.value = val.value; check(); hooks.input && hooks.input(); };
      key.onchange = val.onchange = () => hooks.commit && hooks.commit();
      const rm = el('button', { className: 'small danger', textContent: 'Remove', title: 'Remove this variable' });
      rm.onclick = () => { vars.splice(i, 1); build(); hooks.input && hooks.input(); hooks.commit && hooks.commit(); };
      wrap.append(el('div', { className: 'vitem' }, el('div', { className: 'vrow' }, key, val, rm), warn));
      check();
      lastKey = key;
    });
    const add = el('button', { className: 'small', textContent: '+ Add variable' });
    add.onclick = () => { vars.push({ name: '', value: '' }); build(true); };
    wrap.append(el('div', { className: 'vfoot' }, add));
    if (focusLast && lastKey) lastKey.focus();
  };
  build();
  return wrap;
}

// duplicate: name and variables are separate sections -> resolves { name, vars } or null
function duplicateDialog(p) {
  return new Promise((resolve) => {
    const dlg = $('dupDlg');
    $('dupSub').textContent = `Create a copy of “${p.name}” with all its pages, rules and click-after buttons.`;
    $('dupName').value = suggestCopyName(p.name);
    const vars = (p.vars || []).filter(v => v.name).map(v => ({ name: v.name, value: v.value }));
    const holder = $('dupVars'); holder.innerHTML = '';
    holder.append(buildVarTable(vars, { emptyText: 'This profile has no variables.' }));
    let finished = false;
    const done = (ok) => {
      if (finished) return; finished = true;
      closeDialog(dlg);
      resolve(ok ? { name: $('dupName').value.trim() || `${p.name} (copy)`, vars: vars.filter(v => v.name) } : null);
    };
    $('dupOk').onclick = (e) => { e.preventDefault(); done(true); };
    $('dupCancel').onclick = () => done(false);
    dlg.oncancel = () => done(false);
    openDialog(dlg);
    $('dupName').focus(); $('dupName').select();
  });
}

// ---------- running (in a new tab) ----------
// Run a profile (or one page of it). With tabId the run continues in that tab; otherwise a new tab is opened.
async function runInTab(profileId, only, tabId) {
  const need = await chrome.runtime.sendMessage({ type: 'needVars', profileId, only });
  let values;
  if (need && need.items && need.items.length) {
    values = await askDialog(need.items, `Run “${need.title}” - enter values`, 'Run');
    if (!values) { status('Run cancelled.'); return; }
  }
  let tab = null;
  if (tabId != null) { try { tab = await chrome.tabs.get(tabId); } catch (_) { tab = null; } }      // the tab may have been closed
  if (!tab) tab = await chrome.tabs.create({ url: 'about:blank' });
  else {                                                                                            // bring the tab you are continuing in to the front
    try { await chrome.tabs.update(tab.id, { active: true }); if (tab.windowId != null && chrome.windows) await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  if (nextRun) { nextRun = null; render(); }                                                       // a new run starts: clear the old "next page" line
  const res = await chrome.runtime.sendMessage({ type: 'runChain', profileId, tabId: tab.id, only, values });
  if (!res || res.error || res.cancelled) status('Could not start the run.', 'err');
}
const runInNewTab = (profileId, only) => runInTab(profileId, only, null);
async function openPageInNewTab(profileId, index) {
  const tab = await chrome.tabs.create({ url: 'about:blank' });
  const res = await chrome.runtime.sendMessage({ type: 'switchPage', profileId, index, tabId: tab.id });
  if (!res || res.error) status(res && res.error === 'cannot-open' ? "Can't open a wildcard page - set an exact URL first." : 'Could not open the page.', 'err');
}

// ---------- help ----------
const code = (t) => el('code', { textContent: t });
const kbd = (t) => el('kbd', { textContent: t });
const para = (...k) => el('p', {}, ...k);
const list = (tag, items) => el(tag, {}, ...items.map(it => el('li', {}, ...(Array.isArray(it) ? it : [it]))));

function helpSections() {
  const exampleTable = el('table', { className: 'extable' },
    el('thead', {}, el('tr', {}, ...['Key', 'Value', 'Rule value you type', 'What gets filled'].map(t => el('th', { textContent: t })))),
    el('tbody', {},
      ...[['exam_year', '2027', '{{exam_year}}', '2027'], ['level', 'First Year', '{{level}}', 'First Year'], ['-', '-', 'Sem {{level}} / {{exam_year}}', 'Sem First Year / 2027']]
        .map(r => el('tr', {}, ...r.map((t, i) => el('td', {}, i >= 2 && t !== '-' && i === 2 ? code(t) : t))))));
  return [
    { id: 'start', icon: '🚀', title: 'Quick start', body: [
      list('ol', [
        ['Press ', el('b', { textContent: '+ New profile' }), ' and give it a name, e.g. “MTIS-2027 Mark Assign”.'],
        ['Open the page you want to fill and ', el('b', { textContent: 'click the extension icon' }), '. A toolbar appears at the top of the page.'],
        ['Fill the form by hand. In the toolbar choose your profile (step 2) and press ', el('b', { textContent: 'Generate Rules' }), '. Every field you changed becomes a rule.'],
        ['Go to the next page and repeat. If the page keeps the same address after you press Search, choose ', el('b', { textContent: '+ New page' }), ' in the toolbar before generating.'],
        ['To fill later press ', el('b', { textContent: '▶ Run' }), ' in the toolbar (all pages) or ', el('b', { textContent: '▶ Page' }), ' (this page only).']
      ])] },
    { id: 'profiles', icon: '👤', title: 'Profiles, active profile and auto-run', body: [
      para('A profile is a named set of pages, each with its own field rules.'),
      list('ul', [
        [el('b', { textContent: 'Active: ' }), 'only one profile is active at a time. The toolbar’s Run buttons, the shortcut ', kbd('Alt+Shift+E'), ' and auto-run all use the active profile.'],
        [el('b', { textContent: 'Auto-run: ' }), 'fills a page by itself when you open one of the profile’s saved pages. Only one profile can have it on; turning it on makes that profile active.'],
        [el('b', { textContent: 'Duplicate: ' }), 'makes a copy of a profile, for example for the next semester. In the same window you give the copy a name and change its variable values.']
      ])] },
    { id: 'pages', icon: '📄', title: 'Pages, rules and click-after', body: [
      list('ul', [
        ['Pages run in the order shown. Use ▲ ▼ to reorder. The address is where a run opens the page. End it with ', code('*'), ' to match several addresses (such a page can be filled when you are already on it, but a run cannot open it).'],
        ['Each rule is one field and its value. Edit the value here to change what gets filled.'],
        [el('b', { textContent: 'Click-after: ' }), 'in the toolbar press Click-after, then click the button on the page (e.g. Search). After filling, the run presses it and waits for the next page.'],
        [el('b', { textContent: '↗ Open' }), ' opens a page in a new tab with the toolbar ready. ', el('b', { textContent: '▶ Run page' }), ' fills only that page.'],
        [el('b', { textContent: 'Run next page: ' }), 'when a single page finishes, a green line appears under that page on this Details page. Press ', el('b', { textContent: 'Run next page ▶' }), ' to continue in the same tab: it opens and fills the next page. Check the page or press a button yourself first, then continue.']
      ])] },
    { id: 'variables', icon: '🔤', title: 'Variables - how to use them', body: [
      para('A variable is a named value you define once and reuse in many rules. Change it in one place and every rule that uses it changes - handy when the same profile is used again next semester.'),
      list('ol', [
        ['In the profile’s ', el('b', { textContent: 'Variables' }), ' table press ', el('b', { textContent: '+ Add variable' }), '. Type a ', el('b', { textContent: 'Key' }), ' such as ', code('exam_year'), ' and its ', el('b', { textContent: 'Value' }), ' such as ', code('2027'), '.'],
        ['In the rules table, type ', code('{{exam_year}}'), ' into the Value box of a rule (for example the Exam Year dropdown). The purple line under the box shows what will be filled.'],
        ['Run the profile. ', code('{{exam_year}}'), ' is replaced by ', code('2027'), '.'],
        ['Next semester press ', el('b', { textContent: 'Duplicate' }), ' and change the value in the copy. No rule needs editing.']
      ]),
      el('h5', { textContent: 'Example' }), exampleTable,
      el('h5', { textContent: 'Good to know' }),
      list('ul', [
        ['Keys are not case-sensitive. Use letters, numbers and underscores (no spaces) to avoid typing mistakes.'],
        ['For a dropdown, the value must match the option’s visible text (capitals and extra spaces do not matter) or the option’s own value.'],
        ['You can mix text and variables: ', code('Sem {{level}}'), '.'],
        ['A value cannot be its own key: ', code('level'), ' = ', code('{{level}}'), ' has no real value, so you will be asked for it when you run.'],
        [el('b', { textContent: 'Ask when running: ' }), 'type ', code('{{ask:Roll number}}'), ' and a small window asks for the value every time you run (your last answer is pre-filled). A ', code('{{name}}'), ' with no matching Key is asked the same way.']
      ])] },
    { id: 'shortcuts', icon: '⌨️', title: 'Shortcuts and backup', body: [
      list('ul', [
        ['Click the extension icon, or press ', kbd('Alt+Shift+R'), ', to show or hide the toolbar. Press ', kbd('Alt+Shift+E'), ' to run the active profile on the current page. Change the keys at ', code('edge://extensions/shortcuts'), '.'],
        [el('b', { textContent: 'Export all / Import' }), ' (top right) save your profiles to a file and restore them. Your data is stored only in this browser, so export now and then.']
      ])] },
    { id: 'trouble', icon: '🛠️', title: 'If something does not fill', body: [
      list('ul', [
        ['Read the message after a run - it names the field that failed. “option … is not in the list” means the dropdown has no matching option: check the value or variable.'],
        ['After updating the extension, click refresh on ', code('edge://extensions'), ' and reload the page. The version is shown next to the title above.'],
        ['Dependent dropdowns are waited for up to 6 seconds. Fields must be visible on the page.'],
        ['Passwords are never recorded.']
      ])] }
  ];
}

function renderHelp(box) {
  box.append(el('div', { className: 'helphead' },
    el('h2', { textContent: 'Help' }),
    (() => { const b = el('button', { textContent: '← Back to profiles' }); b.onclick = () => { view = 'profile'; render(); }; return b; })()));
  helpSections().forEach(s => {
    const d = el('details', { className: 'card helpcard', open: s.id === helpOpen });
    d.append(el('summary', {}, el('span', { className: 'hico', textContent: s.icon }), s.title), el('div', { className: 'helpbody' }, ...s.body));
    d.addEventListener('toggle', () => { if (d.open) helpOpen = s.id; });
    box.append(d);
  });
}

// ---------- profile view ----------
function renderProfile(box, profiles, pi) {
  const p = profiles[pi];
  p.vars = p.vars || [];
  const isActive = p.id === activeId;
  const vctx = { vars: varMap(p), values: {}, preview: true };
  const refreshers = [];                                  // previews under rule values, variable count
  const refreshAll = () => { vctx.vars = varMap(p); refreshers.forEach(f => f()); };

  // ----- header card -----
  const name = el('input', { type: 'text', className: 'name', value: p.name, title: 'Rename the profile' });
  name.onchange = async () => { await mutate(all => { all[pi].name = name.value.trim() || p.name; }); render(); };
  const badges = el('div', { className: 'badges' });
  if (isActive) badges.append(el('span', { className: 'badge on', textContent: '● Active' }));
  if (p.autoRun) badges.append(el('span', { className: 'badge auto', textContent: '⟳ Auto-run' }));

  const act = el('button', { className: 'activebtn' + (isActive ? ' on' : ''), textContent: isActive ? '● Active - click to deactivate' : 'Set as active',
    title: 'Only one profile can be active at a time. Activating this one deactivates the current one.' });
  act.onclick = async () => { await setActive(isActive ? '' : p.id); status(isActive ? 'No profile is active now.' : `“${p.name}” is now the active profile.`, 'ok'); render(); };
  const run = el('button', { className: 'primary', textContent: '▶ Run profile', title: 'Open a new tab, visit each page in order and fill it' });
  run.onclick = () => runInNewTab(p.id);
  const dup = el('button', { textContent: 'Duplicate', title: 'Copy this profile - pages, rules and variables - e.g. for next semester' });
  dup.onclick = async () => {
    const res = await duplicateDialog(p);
    if (!res) { status('Duplicate cancelled.'); return; }
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = newId(); copy.name = res.name; copy.vars = res.vars; copy.autoRun = false;     // a copy is never active by itself
    await mutate(all => all.splice(pi + 1, 0, copy));
    await setSelected(copy.id); render();
    status(`Created “${copy.name}” from “${p.name}”. Set it active when you are ready.`, 'ok');
  };
  const del = el('button', { className: 'danger', textContent: 'Delete', title: 'Delete this profile' });
  del.onclick = async () => {
    if (!confirm(`Delete profile "${p.name}" and all its pages?`)) return;
    await mutate(all => all.splice(pi, 1)); await setSelected('');
    if (p.id === activeId) await setActive('');
    render();
  };

  const cb = el('input', { type: 'checkbox', checked: !!p.autoRun });
  cb.onchange = async () => {
    const on = cb.checked;
    await mutate(all => { all.forEach((x, i) => { x.autoRun = on && i === pi; }); });       // only one profile can auto-run
    if (on) await setActive(p.id);                                                         // auto-run works for the active profile, so this one becomes active
    await render();
    status(on ? `Auto-run is ON for “${p.name}” - it is now the active profile. Auto-run is off for every other profile.` : 'Auto-run is off for all profiles.', 'ok');
  };
  const sw = el('label', { className: 'switch' }, cb, el('span', { className: 'slider' }), el('span', { className: 'swtext', textContent: 'Auto-run when one of its saved pages opens' }));

  const activeName = (profiles.find(x => x.id === activeId) || {}).name;
  const note = el('p', { className: 'activenote' + (activeId ? '' : ' warn'),
    textContent: activeId ? `Active profile: ${activeName}. Only one profile is active at a time.` : 'No profile is active. Auto-run and the Alt+Shift+E shortcut only work for the active profile.' });

  box.append(el('section', { className: 'card head' },
    el('div', { className: 'headrow' }, name, badges),
    el('div', { className: 'actions' }, act, run, dup, del),
    el('div', { className: 'swrow' }, sw, el('span', { className: 'hint', textContent: 'Only one profile can auto-run; turning it on makes this profile active.' })),
    note));

  // ----- variables card -----
  const count = el('span', { className: 'count', textContent: String(p.vars.length) });
  refreshers.push(() => { count.textContent = String(p.vars.filter(v => v.name).length); });
  const helpLink = el('button', { className: 'linkbtn', textContent: 'How do variables work?' });
  helpLink.onclick = () => { view = 'help'; helpOpen = 'variables'; render(); };
  const table = buildVarTable(p.vars, {
    emptyText: 'No variables yet. Add one to reuse a value in several rules.',
    input: refreshAll,
    commit: () => mutate(all => { all[pi].vars = p.vars.filter(v => v.name || v.value).map(v => ({ name: v.name, value: v.value })); })
  });
  box.append(el('section', { className: 'card' },
    el('div', { className: 'ctitle' }, el('h3', { textContent: 'Variables' }), count, helpLink),
    el('p', { className: 'hint', textContent: 'Define a value once (Key and Value), then type {{key}} in a rule’s Value below - for example Key exam_year, Value 2027, rule value {{exam_year}}.' }),
    table));

  // ----- pages -----
  box.append(el('div', { className: 'ctitle plain' }, el('h3', { textContent: 'Pages' }), el('span', { className: 'count', textContent: String(p.pages.length) })));
  if (!p.pages.length) box.append(el('p', { className: 'hint', textContent: 'No pages yet. Open a page, click the extension icon, fill the form and press Generate Rules - or add a page URL below.' }));

  p.pages.forEach((pg, gi) => {
    const page = el('div', { className: 'card page' });
    const url = el('input', { type: 'text', value: pg.url, placeholder: 'Page URL (end with * for a wildcard)' });
    url.onchange = () => mutate(all => { const g = all[pi].pages[gi]; g.url = url.value.trim(); g.href = g.url.includes('*') ? '' : g.url; });
    const runOne = el('button', { className: 'small', textContent: '▶ Run page', title: 'Open a new tab and fill only this page' });
    runOne.onclick = () => runInNewTab(p.id, gi);
    const open = el('button', { className: 'small', textContent: '↗ Open', title: 'Open this page in a new tab with the toolbar ready' });
    open.onclick = () => openPageInNewTab(p.id, gi);
    const up = el('button', { className: 'small', textContent: '▲', title: 'Move up', disabled: gi === 0 });
    up.onclick = async () => { await mutate(all => { const a = all[pi].pages; [a[gi - 1], a[gi]] = [a[gi], a[gi - 1]]; }); render(); };
    const dn = el('button', { className: 'small', textContent: '▼', title: 'Move down', disabled: gi === p.pages.length - 1 });
    dn.onclick = async () => { await mutate(all => { const a = all[pi].pages; [a[gi + 1], a[gi]] = [a[gi], a[gi + 1]]; }); render(); };
    const rm = el('button', { className: 'small danger', textContent: '✕', title: 'Remove this page' });
    rm.onclick = async () => {
      if (!confirm('Remove this page and its rules from the profile?')) return;
      await mutate(all => all[pi].pages.splice(gi, 1)); render();
    };
    page.append(el('div', { className: 'pagehead' }, el('span', { className: 'num', textContent: String(gi + 1) }), url, runOne, open, up, dn, rm));

    if (nextRun && nextRun.profileId === p.id && nextRun.doneIndex === gi) {
      const hasNext = !!p.pages[nextRun.nextIndex];
      const warn = nextRun.notes && nextRun.notes.length;
      const bar = el('div', { className: 'nextbar' + (warn ? ' warn' : '') },
        el('span', { className: 'ntext', textContent: `✔ Page ${gi + 1} finished - filled ${nextRun.filled}/${nextRun.total}.` + (warn ? ' ' + nextRun.notes.join('; ') : '') + (hasNext ? '' : ' This was the last page.') }));
      if (hasNext) {
        const go = el('button', { className: 'nextlink', textContent: `Run next page (${nextRun.nextIndex + 1}) ▶`, title: 'Continue in the same tab: open and fill the next page of this profile' });
        go.onclick = () => runInTab(p.id, nextRun.nextIndex, nextRun.tabId);
        bar.append(go);
      }
      const dismiss = el('button', { className: 'linkbtn', textContent: 'Dismiss' });
      dismiss.onclick = () => { nextRun = null; render(); };
      bar.append(el('span', { className: 'spacer' }), dismiss);
      page.append(bar);
    }

    if (pg.after) {
      const x = el('button', { className: 'small danger', textContent: '×', title: 'Remove click-after' });
      x.onclick = async () => { await mutate(all => { delete all[pi].pages[gi].after; }); render(); };
      page.append(el('div', { className: 'after' }, el('span', { textContent: `Then click: “${pg.after.text || pg.after.tag}”` }), x));
    } else {
      page.append(el('div', { className: 'after muted', textContent: 'No click-after button. Set one with the toolbar’s Click-after button.' }));
    }

    const table = el('table', { className: 'rules' });
    table.append(el('thead', {}, el('tr', {}, el('th', { textContent: 'Field' }), el('th', { textContent: 'Value' }), el('th', { textContent: 'Type' }), el('th'))));
    const tb = el('tbody');
    pg.rules.forEach((r, ri) => {
      const d = describeRule(r);
      const field = el('td', { className: 'field' }, el('span', { textContent: r.label || r.name || r.id || '(unnamed)' }),
        el('small', { textContent: r.id ? '#' + r.id : (r.name ? 'name=' + r.name : '') }));
      let cell;
      if (d.editable) {
        const val = el('input', { type: 'text', value: d.text });
        const preview = el('div', { className: 'preview' });
        const showPreview = () => {
          val.classList.toggle('usesvar', val.value.includes('{{'));
          preview.textContent = val.value.includes('{{') ? '→ will fill: ' + expand(val.value, vctx) : '';
        };
        showPreview();
        refreshers.push(showPreview);
        val.oninput = showPreview;
        val.onchange = () => mutate(all => {
          const rule = all[pi].pages[gi].rules[ri];
          if (rule.tag === 'select') { rule.text = val.value; rule.value = null; } else rule.value = val.value;
        });
        cell = el('div', { className: 'valcell' }, val, preview);
      } else cell = el('span', { className: 'ro', textContent: d.text });
      const x = el('button', { className: 'small danger', textContent: '×', title: 'Remove rule' });
      x.onclick = async () => { await mutate(all => all[pi].pages[gi].rules.splice(ri, 1)); render(); };
      tb.append(el('tr', {}, field, el('td', {}, cell), el('td', { className: 'type', textContent: d.kind }), el('td', { className: 'x' }, x)));
    });
    if (!pg.rules.length) tb.append(el('tr', {}, el('td', { colSpan: 4, className: 'hint', textContent: 'No rules on this page yet.' })));
    table.append(tb);
    page.append(table);
    box.append(page);
  });

  const newUrl = el('input', { type: 'text', placeholder: 'https://… URL of a page to add' });
  const add = el('button', { textContent: '+ Add page' });
  add.onclick = async () => {
    const u = newUrl.value.trim();
    if (!u) { status('Type the page URL first.', 'err'); return; }
    await mutate(all => all[pi].pages.push({ url: u, rules: [] })); render();
  };
  box.append(el('div', { className: 'addpage' }, newUrl, add));
}

// ---------- page ----------
async function render() {
  const profiles = await loadProfiles();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === 'help' || hash.startsWith('help-')) { view = 'help'; helpOpen = hash.slice(5) || helpOpen; history.replaceState(null, '', location.pathname); }
  else if (hash && profiles.some(p => p.id === hash)) { await setSelected(hash); view = 'profile'; history.replaceState(null, '', location.pathname); }
  if (!selectedId) selectedId = (await chrome.storage.local.get('selectedProfile')).selectedProfile || '';
  if (!profiles.some(p => p.id === selectedId)) selectedId = profiles.length ? profiles[0].id : '';
  activeId = (await chrome.storage.local.get('activeProfile')).activeProfile || '';
  if (!profiles.some(p => p.id === activeId)) activeId = '';
  const autos = profiles.filter(x => x.autoRun);              // older data may have auto-run on for several profiles: keep one
  if (autos.length > 1) {
    const keep = (autos.find(x => x.id === activeId) || autos[0]).id;
    profiles.forEach(x => { x.autoRun = x.id === keep; });
    await saveProfiles(profiles);
  }

  // sidebar
  const listEl = $('profileList');
  listEl.innerHTML = '';
  $('noProfiles').hidden = profiles.length > 0;
  profiles.forEach(p => {
    const b = el('button', { className: (p.id === selectedId && view === 'profile' ? 'sel' : '') + (p.id === activeId ? ' act' : '') },
      el('span', { className: 'pname', textContent: (p.id === activeId ? '● ' : '') + p.name }),
      el('span', { className: 'count', textContent: `${p.pages.length} page${p.pages.length === 1 ? '' : 's'}` }));
    b.onclick = async () => { view = 'profile'; await setSelected(p.id); render(); };
    listEl.appendChild(el('li', {}, b));
  });
  $('helpBtn').classList.toggle('on', view === 'help');

  const box = $('detail');
  box.innerHTML = '';
  if (view === 'help') { renderHelp(box); return; }
  const pi = profiles.findIndex(p => p.id === selectedId);
  if (pi < 0) { box.append(el('div', { className: 'card empty' }, el('p', { textContent: 'Select or create a profile on the left.' }))); return; }
  renderProfile(box, profiles, pi);
}

// ---------- init ----------
async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  await render();

  $('helpBtn').onclick = () => { view = view === 'help' ? 'profile' : 'help'; render(); };
  $('newBtn').onclick = () => { $('newRow').hidden = false; $('newName').value = ''; $('newName').focus(); };
  $('cancelBtn').onclick = () => { $('newRow').hidden = true; };
  const create = async () => {
    const name = $('newName').value.trim();
    if (!name) { status('Type a name for the profile.', 'err'); return; }
    const p = { id: newId(), name, autoRun: false, vars: [], pages: [] };
    await mutate(all => all.push(p));
    await setSelected(p.id);
    if (!activeId) await setActive(p.id);          // the first profile becomes active automatically
    view = 'profile';
    $('newRow').hidden = true;
    await render();
    status(`Profile “${name}” created. Open a page, click the extension icon and record its rules.`, 'ok');
  };
  $('createBtn').onclick = create;
  $('newName').onkeydown = (e) => { if (e.key === 'Enter') create(); };

  $('exportBtn').onclick = async () => {
    const all = await chrome.storage.local.get('ruleProfiles');
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quick-autofill-backup.json';
    a.click();
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.ruleProfiles)) throw new Error('no profiles');
      if (!confirm('Import replaces your current profiles. Continue?')) return;
      await saveProfiles(data.ruleProfiles);
      render();
      status('Imported.', 'ok');
    } catch { status('Invalid file.', 'err'); }
  };

  // pick up rules recorded in another tab (but not our own edits, which would steal focus)
  chrome.storage.onChanged.addListener((c) => { if ((c.ruleProfiles || c.activeProfile) && Date.now() - lastWrite > 600) render(); });
  window.addEventListener('hashchange', render);

  // a run finished (started here, from the toolbar, or by auto-run): after a single page, offer "Run next page"
  const onRunFinished = async (msg) => {
    if (!msg || msg.type !== 'runFinished') return;
    if (msg.only == null) {
      status(`“${msg.name}” finished - filled ${msg.filled}/${msg.total}.` + (msg.notes && msg.notes.length ? ' ' + msg.notes.join('; ') : ''), msg.notes && msg.notes.length ? 'err' : 'ok');
      return;
    }
    nextRun = { profileId: msg.profileId, doneIndex: msg.only, nextIndex: msg.only + 1, tabId: msg.tabId, filled: msg.filled, total: msg.total, notes: msg.notes || [] };
    view = 'profile';
    await setSelected(msg.profileId);                  // show the profile whose page just finished
    status(`Page ${msg.only + 1} of “${msg.name}” finished. Use “Run next page” on its card to continue.`, 'ok');
    render();
  };
  chrome.runtime.onMessage.addListener((msg) => { onRunFinished(msg); });
}
init();
