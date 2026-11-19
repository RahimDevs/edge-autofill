importScripts('vars.js');   // shared variable engine ({{key}} and {{ask:Label}})

// Orchestrates running a profile across several pages:
// for each page -> open its URL (if the tab is not already there) -> wait for load -> fill that page's rules.
const chainTabs = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
// here = { key: full URL (path+query), path: path only }
const urlMatches = (pattern, here) => {
  if (!pattern || !here) return false;
  if (pattern.endsWith('*')) return here.key.startsWith(pattern.slice(0, -1)) || here.path.startsWith(pattern.slice(0, -1));
  return pattern.includes('?') ? trimSlash(pattern) === trimSlash(here.key) : trimSlash(pattern) === trimSlash(here.path);
};

async function getProfiles() {
  const list = (await chrome.storage.local.get('ruleProfiles')).ruleProfiles || [];
  list.forEach(p => {
    if (!p.pages) {
      p.pages = (p.rules && p.rules.length) || p.urlPattern ? [{ url: p.urlPattern || '', rules: p.rules || [] }] : [];
    }
  });
  return list;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

// Send a message to the page's content script, retrying while the page is still loading.
async function toTab(tabId, msg, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { return await chrome.tabs.sendMessage(tabId, msg); }
    catch (_) { await sleep(200); }
  }
  return null;
}

// Wait for a click to cause a page load. Resolves false if nothing starts loading within a few seconds (AJAX-only click).
function waitNav(tabId, startTimeout = 3000, loadTimeout = 30000) {
  return new Promise(resolve => {
    let started = false, done = false, timer;
    const finish = (v) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(v); };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading' && !started) { started = true; clearTimeout(timer); timer = setTimeout(() => finish(false), loadTimeout); }
      else if (info.status === 'complete' && started) finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    timer = setTimeout(() => finish(false), startTimeout);
  });
}

function waitLoaded(tabId, timeout = 30000) {
  return new Promise(resolve => {
    let done = false, timer;
    const finish = (ok) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(ok); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(onUpd);
    timer = setTimeout(() => finish(false), timeout);
  });
}

async function runChain(tabId, profile, only, ctx) {
  if (chainTabs.has(tabId)) return;
  chainTabs.add(tabId);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const notes = [];
  let here0 = null;
  let filled = 0, total = 0;
  let outcome = null;
  try {
    const idxs = only != null ? [only] : profile.pages.map((_, i) => i);
    for (let n = 0; n < idxs.length; n++) {
      const pg = profile.pages[idxs[n]];
      const label = `${profile.name} · page ${n + 1}/${idxs.length}`;     // the toast always names the profile that is filling
      if (!pg || !pg.rules || !pg.rules.length) { notes.push(`${label}: no rules`); continue; }

      const here = await toTab(tabId, { type: 'getKey' }, 5);
      if (here && !here0) here0 = here;
      if (!urlMatches(pg.url, here)) {
        const target = pg.href || pg.url;
        if (!target || target.includes('*')) { notes.push(`${label}: cannot open "${pg.url || 'no URL'}"`); continue; }
        const loaded = waitLoaded(tabId);
        await chrome.tabs.update(tabId, { url: target });
        if (!(await loaded)) notes.push(`${label}: slow to load`);
      }
      const rules = pg.rules.map(r => resolveRule(r, ctx));
      const stuck = rules.filter(r => ['value', 'text'].some(k => typeof r[k] === 'string' && /\{\{[^{}]+\}\}/.test(r[k]))).map(r => r.label || r.name || r.id);
      if (stuck.length) notes.push(`${label}: variables not replaced in ${stuck.join(', ')}`);
      const res = await toTab(tabId, { type: 'runPageRules', rules, label });
      if (!res) { notes.push(`${label}: could not run on page`); continue; }
      filled += res.ok; total += res.total;
      if (res.failed.length) notes.push(`${label}: not found - ${res.failed.join(', ')}`);

      if (pg.after) {                       // press the page's button (e.g. Search), then wait if it loads a new page
        const nav = waitNav(tabId);
        const c = await chrome.tabs.sendMessage(tabId, { type: 'clickAfter', after: pg.after }).catch(() => null);
        if (c && !c.clicked) notes.push(`${label}: button "${pg.after.text || pg.after.tag}" not found`);
        await nav;
      }
    }
    outcome = { filled, total, notes: notes.slice() };
    const ver = chrome.runtime.getManifest().version;
    if (here0 && here0.version && here0.version !== ver) notes.push('this page has an older toolbar loaded - reload the page');
    const text = `"${profile.name}" finished - filled ${filled}/${total} field${total === 1 ? '' : 's'}.` + (notes.length ? ' ' + notes.join(' · ') : '');
    await toTab(tabId, { type: 'toast', text: notes.length ? `${text} (v${ver})` : text, long: notes.length > 0 }, 10);
  } finally {
    clearInterval(keepAlive);
    chainTabs.delete(tabId);
  }
  // tell open extension pages (the Details page) that the run finished, so they can offer "Run next page"
  if (outcome) notifyPages({ type: 'runFinished', profileId: profile.id, name: profile.name, only: only == null ? null : only, tabId, ...outcome });
}

function notifyPages(msg) {
  try { const r = chrome.runtime.sendMessage(msg); if (r && r.catch) r.catch(() => {}); } catch (_) {}   // no Details page open: nothing to tell
}

async function startProfile(tabId, profileId, only, values, auto) {
  const p = (await getProfiles()).find(x => x.id === profileId);
  if (!p) return { error: 'missing' };
  if (auto) {                                   // auto-run is only ever allowed for the ACTIVE profile that has auto-run turned on
    const { activeProfile } = await chrome.storage.local.get('activeProfile');
    if (activeProfile !== profileId || !p.autoRun) return { error: 'not-auto' };
  }
  if (chainTabs.has(tabId)) return { error: 'busy' };
  const saved = (await chrome.storage.local.get('varAnswers')).varAnswers || {};
  let answers = Object.assign({}, values || {});
  const items = neededAsks(p, only, answers);
  if (items.length) {                       // ask for {{ask}} values in a dialog on the page, once per run
    items.forEach(i => { if (saved[i.key] !== undefined) i.def = saved[i.key]; });
    const ans = await toTab(tabId, { type: 'askVars', items, title: p.name }, 3);
    if (!ans) return { error: 'cannot-ask' };
    if (ans.cancelled) { await toTab(tabId, { type: 'toast', text: 'Run cancelled.' }, 3); return { cancelled: true }; }
    Object.assign(answers, ans.values);
  }
  if (Object.keys(answers).length) await chrome.storage.local.set({ varAnswers: Object.assign({}, saved, answers) });   // remembered as the next default
  runChain(tabId, p, only, { vars: varMap(p), values: answers });   // runs in the background; do not await
  return { started: true };
}

// Switch the tab to another page of the profile: open its URL (if needed), then reopen the toolbar with that page's rules active.
async function startSwitch(tabId, profileId, index) {
  const p = (await getProfiles()).find(x => x.id === profileId);
  const pg = p && p.pages[index];
  if (!pg) return { error: 'missing' };
  if (chainTabs.has(tabId)) return { error: 'busy' };
  const here = await toTab(tabId, { type: 'getKey' }, 5);
  const needNav = !urlMatches(pg.url, here);
  const target = pg.href || pg.url;
  if (needNav && (!target || target.includes('*'))) return { error: 'cannot-open' };
  chainTabs.add(tabId);               // keeps auto-run from firing on the page we are about to open
  (async () => {
    try {
      if (needNav) {
        const loaded = waitLoaded(tabId);
        await chrome.tabs.update(tabId, { url: target });
        await loaded;
      }
      await toTab(tabId, { type: 'openBar', profileId, pageIndex: index });
    } finally { chainTabs.delete(tabId); }
  })();
  return { started: true };
}

async function startMatching(tabId) {
  const here = await toTab(tabId, { type: 'getKey' }, 5);
  if (!here) return { error: 'noscript' };
  const { activeProfile } = await chrome.storage.local.get('activeProfile');
  const p = (await getProfiles()).find(x => x.id === activeProfile);
  if (!p) { await toTab(tabId, { type: 'toast', text: 'No active profile. Pick one in the toolbar (Active) or on the Details page.' }, 3); return { none: true }; }
  if (!p.pages.some(pg => urlMatches(pg.url, here))) { await toTab(tabId, { type: 'toast', text: `The active profile “${p.name}” has no saved page for this address.` }, 3); return { none: true }; }
  return startProfile(tabId, p.id);
}

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (!tabId) return;
  if (command === 'toggle-bar') chrome.tabs.sendMessage(tabId, { type: 'toggleBar' }).catch(() => {});
  else if (command === 'run-profile') startMatching(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  if (msg.type === 'runChain') startProfile(tabId, msg.profileId, msg.only, msg.values, msg.auto).then(sendResponse);
  else if (msg.type === 'needVars') {      // lets the Details page ask for {{ask}} values before opening a tab
    getProfiles().then(list => {
      const p = list.find(x => x.id === msg.profileId);
      if (!p) return sendResponse({ items: [], title: '' });
      chrome.storage.local.get('varAnswers').then(({ varAnswers = {} }) => {
        const items = neededAsks(p, msg.only, {});
        items.forEach(i => { if (varAnswers[i.key] !== undefined) i.def = varAnswers[i.key]; });
        sendResponse({ items, title: p.name });
      });
    });
  }
  else if (msg.type === 'switchPage') startSwitch(tabId, msg.profileId, msg.index).then(sendResponse);
  else if (msg.type === 'runMatching') startMatching(tabId).then(sendResponse);
  else if (msg.type === 'canAutoRun') { sendResponse({ ok: !chainTabs.has(tabId) }); return false; }
  else return false;
  return true;
});

// ---- left-click on the extension icon: show/hide the toolbar (falls back to the details page on protected pages) ----
const detailsUrl = (profileId) => chrome.runtime.getURL('details.html') + (profileId ? '#' + profileId : '');

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.tabs.sendMessage(tab.id, { type: 'toggleBar' }); }
  catch (_) { chrome.tabs.create({ url: detailsUrl() }); }     // no toolbar possible here (edge:// page, or tab loaded before install)
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'openDetails') chrome.tabs.create({ url: detailsUrl(msg.profileId) });
});
