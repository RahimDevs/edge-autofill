// Variable engine, shared by background.js (importScripts) and the Details page.
// A variable is a Key/Value pair defined on a profile. Use it inside a rule's value as {{key}}.
//   {{exam_year}}          -> the value of the variable "exam_year"
//   {{ask:Roll number}}    -> asks you for the value each time the profile runs
//   {{something_undefined}} -> also asked when the profile runs
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function varMap(profile) {
  const m = new Map();
  (profile.vars || []).forEach(v => { if (v && v.name) m.set(String(v.name).trim().toLowerCase(), v.value == null ? '' : String(v.value)); });
  return m;
}

function parseToken(inner, vars) {
  const t = inner.trim(), low = t.toLowerCase();
  const m = /^ask(?::(.*))?$/i.exec(t);
  if (m) {                                                   // {{ask}}  {{ask:Label}}  {{ask:Label=default}}
    const spec = (m[1] || 'Value').trim(), eq = spec.indexOf('=');
    const label = (eq >= 0 ? spec.slice(0, eq) : spec).trim() || 'Value';
    return { kind: 'ask', key: 'ask:' + label, label, def: eq >= 0 ? spec.slice(eq + 1).trim() : '' };
  }
  if (vars.has(low)) return { kind: 'var', name: low, value: vars.get(low) };
  return { kind: 'ask', key: 'var:' + t, label: t, def: '' };   // no such Key -> asked when the profile runs
}

// Replace tokens in a string. If `asks` is given, unanswered questions are collected into it.
// ctx = { vars: Map, values: { askKey: answer }, preview?: true }  (preview shows ‹Label› for questions)
function expand(str, ctx, asks, depth = 0, stack = []) {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  return str.replace(TOKEN_RE, (_, inner) => {
    let tok = parseToken(inner, ctx.vars);
    if (tok.kind === 'var') {
      // a variable whose value points back to itself (level = {{level}}) is unusable: treat it as "not defined" and ask for it
      if (stack.includes(tok.name) || depth >= 5) tok = { kind: 'ask', key: 'var:' + inner.trim(), label: inner.trim(), def: '' };
      else return expand(tok.value, ctx, asks, depth + 1, stack.concat(tok.name));
    }
    const v = ctx.values[tok.key];
    if (v === undefined) {
      if (asks && !asks.some(a => a.key === tok.key)) asks.push({ key: tok.key, label: tok.label, def: tok.def });
      return ctx.preview ? `‹${tok.label}›` : '';
    }
    return v;
  });
}

function resolveRule(rule, ctx) {
  const r = Object.assign({}, rule);
  ['value', 'text'].forEach(k => { if (typeof r[k] === 'string') r[k] = expand(r[k], ctx); });
  ['values', 'texts'].forEach(k => { if (Array.isArray(r[k])) r[k] = r[k].map(x => expand(x, ctx)); });
  return r;
}

function pagesToRun(profile, only) { return only != null ? [profile.pages[only]].filter(Boolean) : profile.pages; }

function neededAsks(profile, only, values) {
  const ctx = { vars: varMap(profile), values: values || {} };
  const asks = [];
  pagesToRun(profile, only).forEach(pg => (pg.rules || []).forEach(r => {
    ['value', 'text'].forEach(k => expand(r[k], ctx, asks));
    ['values', 'texts'].forEach(k => Array.isArray(r[k]) && r[k].forEach(x => expand(x, ctx, asks)));
  }));
  return asks;
}
