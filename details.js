const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const status = (msg, cls) => { const s = $('status'); s.textContent = msg; s.className = cls || ''; };

let selectedId = '';
let activeId = '';
let lastWrite = 0;

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
async function mutate(fn) { const all = await loadProfiles(); fn(all); await saveProfiles(all); }
async function setActive(id) { activeId = id || ''; lastWrite = Date.now(); await chrome.storage.local.set({ activeProfile: activeId }); }
async function setSelected(id) { selectedId = id || ''; await chrome.storage.local.set({ selectedProfile: selectedId }); }
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function describeRule(r) {
  if (r.tag === 'select' && Array.isArray(r.values)) return { text: (r.texts || r.values || []).join(', '), editable: false, kind: 'multi-select' };
  if (r.tag === 'select') return { text: r.text || r.value || '', editable: true, kind: 'dropdown' };
  if (r.type === 'checkbox') return { text: r.checked ? 'checked' : 'unchecked', editable: false, kind: 'checkbox' };
  if (r.type === 'radio') return { text: 'selected: ' + r.value, editable: false, kind: 'radio' };
  return { text: r.value || '', editable: true, kind: r.tag === 'textarea' ? 'textarea' : (r.type || 'text') };
}

// ---------- running (in a new tab) ----------
async function runInNewTab(profileId, only) {
  const tab = await chrome.tabs.create({ url: 'about:blank' });
  const res = await chrome.runtime.sendMessage({ type: 'runChain', profileId, tabId: tab.id, only });
  if (!res || res.error) status('Could not start the run.', 'err');
}
async function openPageInNewTab(profileId, index) {
  const tab = await chrome.tabs.create({ url: 'about:blank' });
  const res = await chrome.runtime.sendMessage({ type: 'switchPage', profileId, index, tabId: tab.id });
  if (!res || res.error) status(res && res.error === 'cannot-open' ? "Can't open a wildcard page — set an exact URL first." : 'Could not open the page.', 'err');
}

// ---------- rendering ----------
async function render() {
  const profiles = await loadProfiles();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && profiles.some(p => p.id === hash)) { await setSelected(hash); history.replaceState(null, '', location.pathname); }
  if (!selectedId) selectedId = (await chrome.storage.local.get('selectedProfile')).selectedProfile || '';
  if (!profiles.some(p => p.id === selectedId)) selectedId = profiles.length ? profiles[0].id : '';
  activeId = (await chrome.storage.local.get('activeProfile')).activeProfile || '';
  if (!profiles.some(p => p.id === activeId)) activeId = '';

  // sidebar
  const list = $('profileList');
  list.innerHTML = '';
  $('noProfiles').hidden = profiles.length > 0;
  profiles.forEach(p => {
    const b = el('button', { className: (p.id === selectedId ? 'sel' : '') + (p.id === activeId ? ' act' : '') },
      el('span', { textContent: (p.id === activeId ? '● ' : '') + p.name }),
      el('span', { className: 'count', textContent: `${p.pages.length} page${p.pages.length === 1 ? '' : 's'}` }));
    b.onclick = async () => { await setSelected(p.id); render(); };
    list.appendChild(el('li', {}, b));
  });

  // detail
  const box = $('detail');
  box.innerHTML = '';
  const pi = profiles.findIndex(p => p.id === selectedId);
  if (pi < 0) { box.append(el('p', { className: 'hint', textContent: 'Select or create a profile on the left.' })); return; }
  const p = profiles[pi];

  const name = el('input', { type: 'text', className: 'name', value: p.name });
  name.onchange = async () => { await mutate(all => { all[pi].name = name.value.trim() || p.name; }); render(); };
  const run = el('button', { className: 'primary', textContent: '▶ Run profile', title: 'Open a new tab, visit each page in order and fill it' });
  run.onclick = () => runInNewTab(p.id);
  const del = el('button', { className: 'danger', textContent: 'Delete', title: 'Delete this profile' });
  del.onclick = async () => {
    if (!confirm(`Delete profile "${p.name}" and all its pages?`)) return;
    await mutate(all => all.splice(pi, 1)); await setSelected('');
    if (p.id === activeId) await setActive('');
    render();
  };
  const isActive = p.id === activeId;
  const act = el('button', { className: 'activebtn' + (isActive ? ' on' : ''), textContent: isActive ? '● Active — click to deactivate' : 'Set as active',
    title: 'Only one profile can be active at a time. Activating this one deactivates the current one.' });
  act.onclick = async () => { await setActive(isActive ? '' : p.id); status(isActive ? 'No profile is active now.' : `“${p.name}” is now the active profile.`, 'ok'); render(); };
  box.append(el('div', { className: 'dhead' }, name, act, run, del));
  const activeName = (profiles.find(x => x.id === activeId) || {}).name;
  box.append(el('p', { className: 'activenote' + (activeId ? '' : ' warn'),
    textContent: activeId ? `Active profile: ${activeName}. Only one profile is active at a time; activating another one switches it.`
                          : 'No profile is active. Auto-run and the Alt+Shift+E shortcut only work for the active profile.' }));

  const cb = el('input', { type: 'checkbox', checked: !!p.autoRun });
  cb.onchange = () => mutate(all => { all[pi].autoRun = cb.checked; });
  box.append(el('label', { className: 'check' }, cb, 'Auto-run when one of its saved pages opens (only while this profile is active)'));

  box.append(el('h3', { textContent: `Pages (${p.pages.length})` }));
  if (!p.pages.length) box.append(el('p', { className: 'hint', textContent: 'No pages yet. Open a page, click the extension icon, fill the form and press Generate Autofill Rules — or add a page URL below.' }));

  p.pages.forEach((pg, gi) => {
    const page = el('div', { className: 'page' });
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

    if (pg.after) {
      const x = el('button', { className: 'small danger', textContent: '×', title: 'Remove click-after' });
      x.onclick = async () => { await mutate(all => { delete all[pi].pages[gi].after; }); render(); };
      page.append(el('div', { className: 'after' }, el('span', { textContent: `Then click: “${pg.after.text || pg.after.tag}”` }), x));
    } else {
      page.append(el('div', { className: 'after', textContent: 'No click-after button. Set one from the toolbar (Set click-after).' }));
    }

    const table = el('table', { className: 'rules' });
    table.append(el('thead', {}, el('tr', {}, el('th', { textContent: 'Field' }), el('th', { textContent: 'Value' }), el('th', { textContent: 'Type' }), el('th'))));
    const tb = el('tbody');
    pg.rules.forEach((r, ri) => {
      const d = describeRule(r);
      const field = el('td', { className: 'field' }, el('span', { textContent: r.label || r.name || r.id || '(unnamed)' }),
        el('small', { textContent: r.id ? '#' + r.id : (r.name ? 'name=' + r.name : '') }));
      let val;
      if (d.editable) {
        val = el('input', { type: 'text', value: d.text });
        val.onchange = () => mutate(all => {
          const rule = all[pi].pages[gi].rules[ri];
          if (rule.tag === 'select') { rule.text = val.value; rule.value = null; } else rule.value = val.value;
        });
      } else val = el('span', { className: 'ro', textContent: d.text });
      const x = el('button', { className: 'small danger', textContent: '×', title: 'Remove rule' });
      x.onclick = async () => { await mutate(all => all[pi].pages[gi].rules.splice(ri, 1)); render(); };
      tb.append(el('tr', {}, field, el('td', {}, val), el('td', { className: 'type', textContent: d.kind }), el('td', { className: 'x' }, x)));
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

// ---------- init ----------
async function init() {
  await render();

  $('newBtn').onclick = () => { $('newRow').hidden = false; $('newName').value = ''; $('newName').focus(); };
  $('cancelBtn').onclick = () => { $('newRow').hidden = true; };
  const create = async () => {
    const name = $('newName').value.trim();
    if (!name) { status('Type a name for the profile.', 'err'); return; }
    const p = { id: newId(), name, autoRun: false, pages: [] };
    await mutate(all => all.push(p));
    await setSelected(p.id);
    if (!activeId) await setActive(p.id);          // the first profile becomes active automatically
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
}
init();
