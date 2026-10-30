// Checks for the Messenger widget. No dependencies, no network, no browser:
// run with `node widgets/messenger/test.js`. The same bundle the Worker serves (kit + messenger)
// runs inside a tiny fake DOM (only the calls it makes) via new Function, with fetch/location/storage stubbed.
const fs = require('fs');
const path = require('path');
const SRC = "(function () {\n'use strict';\n" + fs.readFileSync(path.join(__dirname, '../shared/kit.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(__dirname, 'messenger.js'), 'utf8') + '\n})();\n';
const HOST = 'https://cc.example';
const KEY = 'pk_' + 'a'.repeat(48);

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const tick = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ── fake DOM ────────────────────────────────────────────────────────────────
let focused = null;
class Node {
  constructor(tag) { this.tagName = tag; this.attrs = {}; this.children = []; this.parent = null; this.listeners = {}; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); return c; }
  replaceChild(n, old) { const i = this.children.indexOf(old); if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); this.children[i] = n; n.parent = this; old.parent = null; return old; }
  replaceChildren(...k) { this.children.forEach(c => { c.parent = null; }); this.children = []; k.forEach(c => this.appendChild(typeof c === "string" ? Object.assign(new Node("#text"), { text: c }) : c)); }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.tagName === 'body' || n.tagName === '#shadow'; }
  get textContent() { return this.tagName === '#text' ? this.text : this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v) this.appendChild(Object.assign(new Node('#text'), { text: String(v) })); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, ev) { ev = Object.assign({ type: t, target: this, preventDefault() { ev.prevented = true; } }, ev); (this.listeners[t] || []).forEach(fn => fn(ev)); return ev; }
  focus() { focused = this; }
  click() { return this.fire('click'); }
  closest(sel) { const a = sel.match(/^\[([\w-]+)\]$/)[1]; let n = this; while (n) { if (n.getAttribute && n.getAttribute(a) !== null) return n; n = n.parent; } return null; }
  attachShadow() { return (this.shadowRoot = new Node('#shadow')); }
}
const all = (n, out = []) => { out.push(n); (n.shadowRoot ? [n.shadowRoot] : []).concat(n.children).forEach(c => all(c, out)); return out; };
const find = (root, pred) => all(root).filter(pred);
const tag = t => n => n.tagName === t;
const cls = c => n => (n.getAttribute('class') || '').split(' ').includes(c);
const byText = (t, s) => n => n.tagName === t && n.textContent.includes(s);
const visible = n => { for (; n; n = n.parent) if (n.hidden) return false; return true; };

function load({ attrs = {}, config, submit = {}, settings, stored, parentOrigin, routes = {} } = {}) {
  const body = new Node('body');
  const own = body.appendChild(new Node('button'));
  own.setAttribute('data-ccm-open', 'new');
  const ownInner = own.appendChild(new Node('span'));
  const ownHome = body.appendChild(new Node('a'));
  ownHome.setAttribute('data-ccm-open', 'home');
  const docListeners = {};
  const document = {
    readyState: 'complete', body, get activeElement() { return focused; }, visibilityState: 'visible',
    currentScript: { src: HOST + '/v1/messenger.js', getAttribute: n => (n in attrs ? attrs[n] : null) },
    createElement: t => { const n = new Node(t); if (t === 'iframe') n.contentWindow = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } }; return n; },
    createElementNS: (ns, t) => Object.assign(new Node(t), { ns }),
    createTextNode: s => Object.assign(new Node('#text'), { text: s }),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  const clickPage = el => { const ev = { target: el, prevented: false, preventDefault() { this.prevented = true; } }; (docListeners.click || []).forEach(fn => fn(ev)); return ev; };
  const mem = Object.assign({}, stored);
  const localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const parentWin = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } };
  const window = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    parent: attrs['data-preview'] ? parentWin : null, localStorage, CustomerCatalystForm: { version: '1' } };
  if (window.parent === null) window.parent = window;
  if (settings) window.ccMessengerSettings = settings;
  const calls = [];
  // routes: '/v1/messenger/<name>' → { status, body } or (request body) → { status, body }.
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const route = Object.keys(routes).find(k => url === HOST + k);
    let r = route ? routes[route] : url.includes('/v1/messenger/config') ? config : submit;
    if (typeof r === 'function') r = r(opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts && opts.body);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return { status: r.status || 200, ok: (r.status || 200) < 300, json: async () => r.body, blob: async () => new Blob(['x']) };
  };
  const loc = { origin: 'https://shop.example' };
  // Timers run only when the test says so.
  const timers = [];
  const setT = (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; };
  const clearT = t => { if (t) t.on = false; };
  const runTimers = () => { const due = timers.filter(t => t.on); due.forEach(t => { t.on = false; t.fn(); }); return due.map(t => t.ms); };
  const pending = () => timers.filter(t => t.on).map(t => t.ms);
  const downloads = [];
  class FakeURL extends URL { static createObjectURL() { downloads.push('blob'); return 'blob:x'; } static revokeObjectURL() {} }
  new Function('window', 'document', 'location', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'URL', SRC)(window, document, loc, localStorage, fetch, setT, clearT, FakeURL);
  const setVisible = v => { document.visibilityState = v ? 'visible' : 'hidden'; (docListeners.visibilitychange || []).forEach(fn => fn({})); };
  const post = (data, origin = HOST, source) => (window.listeners.message || []).forEach(fn => fn({ origin, source, data }));
  const fromParent = (data, source = parentWin, origin = parentOrigin || 'https://app.bubble.example') => post(data, origin, source);
  const root = () => { const host = body.children.find(c => c.getAttribute('data-cc-messenger') !== null); return host && host.shadowRoot; };
  const q = pred => find(root(), pred);
  const panel = () => q(cls('w'))[0];
  const launcher = () => q(cls('launch'))[0];
  const style = () => q(tag('style'))[0].textContent;
  return { window, document, body, own, ownInner, ownHome, calls, mem, post, fromParent, root, q, panel, launcher, style, clickPage, runTimers, pending, setVisible, downloads };
}

const CFG = {
  enabled: true, org_name: 'Sightl', color: '#0E6B5C', corners: 'rounded', font: 'inter',
  help_site_url: 'https://help.sightl.com/docs', help_mode: 'link',
  topics: [
    { id: 't1', name: 'Billing', short_text: 'Invoices are under Settings › Billing.', article_url: 'https://help.sightl.com/invoices' },
    { id: 't2', name: 'Bug', short_text: '', article_url: 'javascript:alert(1)' },
  ],
  fields: [
    { id: 'f1', label: 'How urgent is it?', kind: 'list', options: ['Low', 'High'], required: true },
    { id: 'f2', label: 'Order number', kind: 'short', required: false },
  ],
  messenger: { position: 'right', launcher_shown: true, icon: 'bubble', texts: {} },
};
const ok = cfg => ({ body: { success: true, config: cfg } });
const withM = (mm, extra) => Object.assign({}, CFG, extra, { messenger: Object.assign({}, CFG.messenger, mm) });
const ME = JSON.stringify({ name: 'Ali Yılmaz', email: 'ali@northwind.io' });
const input = (t, ph) => t.q(n => (n.tagName === 'input' || n.tagName === 'textarea' || n.tagName === 'select') && n.getAttribute('aria-label') === ph)[0];
const form = t => t.q(tag('form'))[0];
const turn = t => t.q(tag('iframe'))[0];
const pathsOf = svg => svg.children.map(p => p.getAttribute('d')).join('|');

(async () => {
  // ── launcher + Home ───────────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG) });
    await flush();
    check('config fetched by key without credentials', t.calls[0].url === HOST + '/v1/messenger/config?key=' + KEY && t.calls[0].opts.credentials === 'omit');
    check('shadow root on a host in <body>', !!t.root());
    const l = t.launcher();
    check('launcher shown: a real button with an aria-label and aria-expanded=false', l && l.tagName === 'button' && l.getAttribute('aria-label') === 'Open messenger' && l.getAttribute('aria-expanded') === 'false');
    check('panel closed until opened', t.panel().hidden === true);
    check('launcher right by default (CSS), 56 round', /\.launch\{position:fixed;bottom:24px;right:24px;[^}]*width:56px;height:56px;border-radius:50%/.test(t.style()));
    check('default icon: message bubble, stroke SVG', l.children[0].tagName === 'svg' && l.children[0].getAttribute('stroke') === 'currentColor' && pathsOf(l.children[0]) === 'M4 5h16v11H8l-4 4z');
    check('dark org colour → white on the launcher, header and buttons', /\.launch\{[^}]*background:#0e6b5c;color:#ffffff/.test(t.style()) && /\.wh\{background:#0e6b5c;color:#ffffff/.test(t.style()) && /\.wbtn\{[^}]*background:#0e6b5c;color:#ffffff/.test(t.style()));
    check('panel per canvas: 368 wide, radius 16, above the launcher', /\.w\{position:fixed;right:24px;bottom:96px;[^}]*width:368px;[^}]*border-radius:16px/.test(t.style()));
    check('header padding 22/20/60, cards overlap by 40, radius 12', /\.wh\{[^}]*padding:22px 20px 60px/.test(t.style()) && /\.wb\{margin-top:-40px/.test(t.style()) && /\.wc\{[^}]*border-radius:12px/.test(t.style()));
    check('phones: open panel full screen, launcher steps aside', /@media \(max-width:480px\)\{\.w\{left:0;right:0;top:0;bottom:0/.test(t.style()) && t.style().includes('.launch[aria-expanded=true]{display:none}'));
    check('font: Inter stack on the host and the root (font "site" inherits the page font through :host)', t.style().startsWith(':host{all:initial;font-family:Inter'));
    check('focus: subtle 1px org border + 3px ring at 15%', /\.in:focus\{border-color:#0e6b5c;outline:none;box-shadow:0 0 0 3px rgba\(14,107,92,\.15\)\}/.test(t.style()));
    check('fields: light #CFD8D5 border, #727776 placeholder, own chevron 13px in with room', t.style().includes('border:1px solid #CFD8D5') && t.style().includes('.in::placeholder{color:#727776') && /select\.in\{[^}]*padding-right:40px/.test(t.style()) && t.style().includes('right 13px center'));
    l.click();
    check('launcher opens Home; shows X with "Close messenger"', !t.panel().hidden && l.getAttribute('aria-expanded') === 'true' && l.getAttribute('aria-label') === 'Close messenger' && pathsOf(l.children[0]) === 'M6 6l12 12M18 6L6 18');
    check('panel is a labelled dialog', t.panel().getAttribute('role') === 'dialog' && t.panel().getAttribute('aria-label') === 'Sightl support');
    const p = t.panel();
    check('Home defaults: title, greeting, reply time, button', p.textContent.includes("Hi, we're Sightl") && p.textContent.includes('Ask us anything. We read every message.')
      && p.textContent.includes('We usually reply within a few hours') && !!find(p, byText('button', 'Send us a message')).length);
    check('focus moves to the Home title', focused && focused.tagName === 'h2' && focused.textContent === "Hi, we're Sightl");
    check('logo tile: org initial when no logo', find(p, cls('lg'))[0].textContent === 'S');
    const help = find(p, n => n.tagName === 'a' && cls('wc')(n))[0];
    check('Help center card: link mode + URL → "Help center" + host, new tab, noopener', help && help.getAttribute('href') === 'https://help.sightl.com/docs' && help.textContent.includes('Help center')
      && help.textContent.includes('help.sightl.com') && help.getAttribute('rel') === 'noopener noreferrer');
    check('no conversations card, no team avatars in 1b', !p.textContent.includes('Your conversations') && !find(p, cls('team')).length);
    check('Powered by line on Home', find(p, cls('foot'))[0].textContent === 'Powered by CustomerCatalyst');
    check('nothing loaded for Turnstile before New', !t.q(tag('iframe')).length);
    find(p, cls('wbtn'))[0].click();
    check('"Send us a message" goes to New', t.panel().textContent.includes('New conversation') && !!form(t));
    t.panel().fire('keydown', { key: 'Escape' });
    check('Esc closes, focus back to the launcher', t.panel().hidden && focused === l && l.getAttribute('aria-expanded') === 'false');
    l.click(); l.click();
    check('launcher toggles closed again', t.panel().hidden);
  }

  // ── launcher hidden, left, icons ─────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(withM({ launcher_shown: false, position: 'left' })) });
    await flush();
    check('launcher hidden: no corner button', !t.launcher());
    check('launcher hidden: panel sits at the corner, left, with its own close button', /\.w\{position:fixed;left:24px;bottom:24px/.test(t.style()) && /\.x\{display:grid/.test(t.style()));
    const ev = t.clickPage(t.ownInner);
    check('org button data-ccm-open="new" (click on a child) opens New', ev.prevented && !t.panel().hidden && !!form(t));
    find(t.panel(), n => n.getAttribute('aria-label') === 'Close messenger')[0].click();
    check('close returns focus to the org button', t.panel().hidden && focused === t.own);
    t.clickPage(t.ownHome);
    check('data-ccm-open="home" opens Home', !t.panel().hidden && t.panel().textContent.includes("Hi, we're Sightl"));
    t.window.CustomerCatalystMessenger.close();
    check('CustomerCatalystMessenger.close()', t.panel().hidden);
    t.window.CustomerCatalystMessenger.open('new');
    check('CustomerCatalystMessenger.open("new")', !t.panel().hidden && !!form(t));
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(withM({ position: 'left' })) });
    await flush();
    check('position left: launcher and panel on the left', /\.launch\{position:fixed;bottom:24px;left:24px/.test(t.style()) && /\.w\{position:fixed;left:24px;bottom:96px/.test(t.style()) && /\.x\{display:none/.test(t.style()));
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { corners: 'square' })) });
    await flush();
    const t2 = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { corners: 'pill' })) });
    await flush();
    check('corners square: launcher a soft rounded square (radius 14, still 56×56); pill stays round', /\.launch\{[^}]*width:56px;height:56px;border-radius:14px;/.test(t.style())
      && /\.launch\{[^}]*border-radius:50%;/.test(t2.style()));
  }
  const seen = new Set();
  for (const name of ['bubble', 'question', 'headset', 'dots', 'envelope']) {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(withM({ icon: name })) });
    await flush();
    const svg = t.launcher().children[0];
    seen.add(pathsOf(svg));
    check('icon ' + name + ': inline stroke SVG, hidden from AT', svg.tagName === 'svg' && svg.ns === 'http://www.w3.org/2000/svg' && svg.getAttribute('aria-hidden') === 'true' && svg.getAttribute('fill') === 'none');
  }
  check('the five icons all differ', seen.size === 5);
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(withM({ icon: '<script>' })) });
    await flush();
    check('unknown icon → bubble', pathsOf(t.launcher().children[0]) === 'M4 5h16v11H8l-4 4z');
  }

  // ── contrast ─────────────────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { color: '#FFE066' })) });
    await flush();
    check('light org colour (#FFE066) → #13231F on launcher, header, buttons', /\.launch\{[^}]*background:#ffe066;color:#13231F/.test(t.style()) && /\.wh\{background:#ffe066;color:#13231F/.test(t.style())
      && /\.send\{[^}]*background:#ffe066;color:#13231F/.test(t.style()));
    const t2 = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { color: 'red;}*{display:none' })) });
    await flush();
    check('bad colour → default, no CSS injection', t2.style().includes('background:#0e6b5c') && !t2.style().includes('red;'));
  }

  // ── open() before the config arrives; off / refused ─────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG) });
    check('global API exists at once', typeof t.window.CustomerCatalystMessenger.open === 'function');
    t.window.CustomerCatalystMessenger.open('new');
    await flush();
    check('open("new") before the config arrived opens New once it does', !t.panel().hidden && !!form(t));
  }
  for (const [label, config] of [['refused', { status: 403, body: { success: false, error: 'origin_not_allowed' } }], ['off', ok(Object.assign({}, CFG, { enabled: false }))],
    ['closed (messenger_closed)', { status: 403, body: { success: false, error: 'messenger_closed' } }]]) {
    const t = load({ attrs: { 'data-key': KEY }, config });
    await flush();
    t.window.CustomerCatalystMessenger.open();
    const ev = t.clickPage(t.own);
    check('renders nothing when ' + label + ' (no host, no launcher, org buttons inert)', !t.root() && !ev.prevented);
  }
  {
    const t = load({ attrs: { 'data-key': 'nope' }, config: ok(CFG) });
    await flush();
    check('malformed key: no request, nothing rendered, no global', t.calls.length === 0 && !t.root() && !t.window.CustomerCatalystMessenger);
    const t2 = load({ attrs: {}, settings: { key: KEY }, config: ok(CFG) });
    await flush();
    check('ccMessengerSettings.key works without data-key', t2.calls.length === 1 && !!t2.launcher());
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG) });
    await flush();
    check('no global clash: only CustomerCatalystMessenger added; SDK + form globals untouched', !('CustomerCatalyst' in t.window) && !('customercatalyst' in t.window)
      && JSON.stringify(t.window.CustomerCatalystForm) === '{"version":"1"}' && t.window.CustomerCatalystMessenger.version === '1');
    check('nothing stored before a send', Object.keys(t.mem).length === 0);
  }

  // ── New: topics, fields, validation, files ──────────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG) });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    const p = t.panel();
    check('New: back bar + title, focus on it', p.textContent.includes('New conversation') && focused.tagName === 'h2');
    const radios = t.q(n => n.tagName === 'input' && n.getAttribute('type') === 'radio');
    check('topic chips are radios in a labelled radiogroup', radios.length === 2 && t.q(n => n.getAttribute('role') === 'radiogroup' && n.getAttribute('aria-labelledby')).length === 1);
    radios[0].fire('change');
    const ans = t.q(cls('ans'))[0];
    check('picked topic shows its short answer and article link', visible(ans) && ans.textContent.includes('Invoices are under') && find(ans, tag('a'))[0].getAttribute('href') === 'https://help.sightl.com/invoices');
    radios[1].fire('change');
    check('javascript: article link never rendered', ans.hidden && !find(ans, tag('a')).length);
    check('not remembered: name + email inputs with labels', !!input(t, 'Your name') && input(t, 'Your email').getAttribute('type') === 'email');
    check('subject, list field (placeholder = label), optional short field, message with the default hint', !!input(t, 'Subject') && input(t, 'How urgent is it?').tagName === 'select'
      && input(t, 'Order number').getAttribute('placeholder') === 'Order number (optional)' && input(t, 'Message').getAttribute('placeholder') === 'Write your message…');
    check('Turnstile frame on our host, told the page origin', turn(t).getAttribute('src') === HOST + '/v1/turnstile?origin=' + encodeURIComponent('https://shop.example'));
    check('footer: one short line (fits 336px at 12px), "Powered by CustomerCatalyst" included', t.q(cls('foot'))[0].textContent === "We'll reply by email · Powered by CustomerCatalyst");
    form(t).fire('submit');
    const email = input(t, 'Your email');
    check('empty submit: errors, focus on the first, nothing sent', email.getAttribute('aria-invalid') === 'true' && input(t, 'Subject').getAttribute('aria-invalid') === 'true'
      && input(t, 'How urgent is it?').getAttribute('aria-invalid') === 'true' && focused === input(t, 'Your name') && t.calls.length === 1);
    email.value = 'ali@northwind';
    form(t).fire('submit');
    const err = t.q(n => n.getAttribute('id') === email.getAttribute('aria-describedby'))[0];
    check('invalid email: described-by error text', err && err.textContent.includes('Check the email'));
    check('optional field not flagged', input(t, 'Order number').getAttribute('aria-invalid') === null);

    const picker = t.q(n => n.tagName === 'input' && n.getAttribute('type') === 'file')[0];
    const MB = 1024 * 1024;
    const filesErr = () => t.q(n => (n.getAttribute('id') || '').endsWith('-files-err'))[0];
    check('"+ Attach a file" is a real button', !!t.q(byText('button', '+ Attach a file')).length);
    picker.files = [{ name: 'virus.exe', size: 10 }]; picker.fire('change');
    check('wrong file kind refused', filesErr().textContent.includes("can't be sent"));
    picker.files = [{ name: 'big.pdf', size: 10 * MB + 1 }]; picker.fire('change');
    check('file over 10 MB refused', filesErr().textContent.includes('over 10 MB'));
    picker.files = [{ name: 'a.pdf', size: 9 * MB }, { name: 'b.pdf', size: 9 * MB }, { name: 'c.pdf', size: 9 * MB }]; picker.fire('change');
    check('over 25 MB in total refused, first two kept', filesErr().textContent.includes('25 MB') && t.q(tag('li')).filter(n => n.parent && cls('files')(n.parent)).length === 2);
    t.q(n => n.tagName === 'button' && (n.getAttribute('aria-label') || '').startsWith('Remove')).forEach(b => b.click());
    picker.files = Array.from({ length: 11 }, (_, i) => ({ name: 'p' + i + '.png', size: 1 })); picker.fire('change');
    check('more than 10 files refused', filesErr().textContent.includes('Up to 10') && t.q(n => n.tagName === 'li' && n.parent && cls('files')(n.parent)).length === 10);

    find(p, n => n.getAttribute('aria-label') === 'Back')[0].click();
    t.window.CustomerCatalystMessenger.open('new');
    check('Back → Home, New again keeps the draft', input(t, 'Your email').value === 'ali@northwind');
  }

  // ── submit, Sent, remembered identity, Not you? ──────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG),
      submit: { body: { success: true, ticket_id_label: 'SUP-58', name: 'Ali Yılmaz', email: 'ali@northwind.io' } } });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    t.q(n => n.getAttribute('type') === 'radio')[0].fire('change');
    input(t, 'Your name').value = 'Ali Yılmaz'; input(t, 'Your email').value = 'ali@northwind.io';
    input(t, 'Subject').value = 'Invoice for October shows the wrong VAT number';
    input(t, 'How urgent is it?').value = 'High';
    input(t, 'Message').value = 'Can you reissue it?';
    const picker = t.q(n => n.tagName === 'input' && n.getAttribute('type') === 'file')[0];
    picker.files = [new File(['hi'], 'shot.png', { type: 'image/png' })]; picker.fire('change');
    const frame = turn(t);
    t.post({ type: 'cc-turnstile', token: 'evil' }, 'https://evil.example', frame.contentWindow);
    t.post({ type: 'cc-turnstile', token: 'evil' }, HOST, {});
    form(t).fire('submit');
    check('token from another origin or frame ignored', t.calls.length === 1 && t.panel().textContent.includes('security check is still running'));
    t.post({ type: 'cc-turnstile', token: 'tok-1' }, HOST, frame.contentWindow);
    form(t).fire('submit');
    await flush();
    const sub = t.calls[1], fd = sub && sub.opts.body;
    check('submit posts multipart to /v1/messenger/submit without credentials', sub && sub.url === HOST + '/v1/messenger/submit' && fd instanceof FormData && sub.opts.credentials === 'omit');
    check('multipart field names', fd && fd.get('key') === KEY && fd.get('name') === 'Ali Yılmaz' && fd.get('email') === 'ali@northwind.io' && fd.get('topic') === 't1'
      && fd.get('subject').startsWith('Invoice') && fd.get('field_f1') === 'High' && fd.get('field_f2') === '' && fd.get('message') === 'Can you reissue it?'
      && fd.get('turnstile_token') === 'tok-1' && fd.getAll('files').length === 1 && !fd.has('slug'));
    const p = t.panel();
    check('Sent: check, title, ticket card (id · topic, subject, Open)', !!find(p, cls('okc')).length && find(p, tag('h3'))[0].textContent === "Thanks! We've got it."
      && find(p, cls('card'))[0].textContent === 'SUP-58 · BillingInvoice for October shows the wrong VAT numberOpen');
    check('Sent: steps say email only (copy to the address; answer by email)', find(p, cls('steps'))[0].textContent === "1A copy is on its way to ali@northwind.io.2We'll answer by email. Just reply to it.");
    check('Sent: no "See your conversations", has "Back to start" + Powered by', !p.textContent.includes('conversations') && !!find(p, byText('button', 'Back to start')).length && p.textContent.includes('Powered by CustomerCatalyst'));
    check('Turnstile asked for a fresh token after use', frame.contentWindow.posted.some(([m, o]) => m.type === 'cc-turnstile-reset' && o === HOST));
    check('remembers name + email under ccm_ only', Object.keys(t.mem).join() === 'ccm_visitor' && t.mem.ccm_visitor === ME);
    find(p, byText('button', 'Back to start'))[0].click();
    check('Back to start → Home', t.panel().textContent.includes("Hi, we're Sightl"));
    t.window.CustomerCatalystMessenger.open('new');
    check('next New starts empty, as the remembered visitor', t.panel().textContent.includes('Writing as Ali Yılmaz · ali@northwind.io') && !input(t, 'Your name') && input(t, 'Subject').value === undefined);
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { topics: [], fields: [] })), stored: { ccm_visitor: ME },
      submit: { body: { success: true, ticket_id_label: 'SUP-59' } } });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    const who = t.q(cls('who'))[0];
    check('remembered: "Writing as <name> · <email>" + a real "Not you?" button', who && who.textContent === 'Writing as Ali Yılmaz · ali@northwind.ioNot you?' && find(who, tag('button'))[0].textContent === 'Not you?');
    check('remembered: name/email as text, no inputs', !find(who, tag('img')).length && !input(t, 'Your name'));
    input(t, 'Subject').value = 's'; input(t, 'Message').value = 'm';
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, turn(t).contentWindow);
    form(t).fire('submit');
    await flush();
    check('remembered visitor sends the stored name/email; no topics → no topic', t.calls[1].opts.body.get('email') === 'ali@northwind.io' && !t.calls[1].opts.body.has('topic'));
    check('Sent without a topic: card shows the id only', find(t.panel(), cls('card'))[0].textContent.startsWith('SUP-59s'));
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CFG), stored: { ccm_visitor: ME } });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    find(t.q(cls('who'))[0], tag('button'))[0].click();
    check('Not you? forgets the visitor, shows empty inputs, focus on name', !('ccm_visitor' in t.mem) && !t.q(cls('who')).length && input(t, 'Your name').value === '' && focused === input(t, 'Your name'));
    const t2 = load({ attrs: { 'data-key': KEY }, config: ok(CFG), stored: { ccm_visitor: '{"name":"x","email":"not-an-email"}' } });
    await flush();
    t2.window.CustomerCatalystMessenger.open('new');
    check('junk in storage ignored', !t2.q(cls('who')).length && !!input(t2, 'Your name'));
    const t3 = load({ attrs: { 'data-key': KEY }, config: ok(CFG), settings: { name: 'Pre Fill', email: 'pre@fill.io' } });
    await flush();
    t3.window.CustomerCatalystMessenger.open('new');
    check('ccMessengerSettings name/email only prefill the inputs', input(t3, 'Your name').value === 'Pre Fill' && input(t3, 'Your email').value === 'pre@fill.io' && !t3.q(cls('who')).length);
  }

  // ── server answers ────────────────────────────────────────────────────────
  for (const [label, submit, expect] of [
    ['field error lands under the field', { status: 400, body: { success: false, error: 'validation', errors: { subject: 'Too long.' } } }, t => input(t, 'Subject').getAttribute('aria-invalid') === 'true' && t.panel().textContent.includes('Too long.')],
    ['daily_limit → friendly "please email us"', { status: 429, body: { success: false, error: 'daily_limit' } }, t => t.panel().textContent.includes("We can't take more messages right now. Please email us instead.")],
    ['rate limited → wait a minute', { status: 429, body: { success: false, error: 'rate_limited' } }, t => t.panel().textContent.includes('Wait a minute')],
    ['messenger_closed → switched off', { status: 403, body: { success: false, error: 'messenger_closed' } }, t => t.panel().textContent.includes('switched off')],
    ['try_again (503) → please try again', { status: 503, body: { success: false, error: 'try_again' } }, t => t.panel().textContent.includes('Something went wrong. Please try again.') && input(t, 'Subject').value === 's' && input(t, 'Message').value === 'm'],
    ['turnstile_failed → could not verify', { status: 400, body: { success: false, error: 'turnstile_failed' } }, t => t.panel().textContent.includes("couldn't verify")],
  ]) {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { topics: [], fields: [] })), stored: { ccm_visitor: ME }, submit });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    input(t, 'Subject').value = 's'; input(t, 'Message').value = 'm';
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, turn(t).contentWindow);
    form(t).fire('submit');
    await flush();
    check('server: ' + label + ', still on New, nothing remembered anew', expect(t) && !!form(t) && t.mem.ccm_visitor === ME);
  }

  // ── no confirmation mail → no promise of a copy ───────────────────────────
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(Object.assign({}, CFG, { topics: [], fields: [] })), stored: { ccm_visitor: ME },
      submit: { body: { success: true, ticket_id_label: 'SUP-60', email: 'ali@northwind.io', confirmation: false } } });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    input(t, 'Subject').value = 's'; input(t, 'Message').value = 'm';
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, turn(t).contentWindow);
    form(t).fire('submit');
    await flush();
    const steps = find(t.panel(), cls('steps'))[0].textContent;
    check('confirmation:false: "We\'ll answer by email at <email>.", no copy promised', steps === "1We'll answer by email at ali@northwind.io. Just reply to it." && !t.panel().textContent.includes('A copy'));
  }

  // ── texts, invisible Turnstile, files off ────────────────────────────────
  {
    const texts = { title: '<img src=x onerror=alert(1)>\nline', greeting: 'Hello\r\nthere' + 'x'.repeat(1500), reply_time: 'Within a day', new_button: 'Write to us', message_hint: 'What happened?', after_send: 'Got it!' };
    const t = load({ attrs: { 'data-key': KEY }, config: ok(withM({ texts }, { files_on: false, help_mode: 'none', turnstile_mode: 'invisible', privacy_url: 'https://customercatalyst.io/privacy', logo_url: '//cdn.bubble.io/logo.png' })) });
    await flush();
    t.window.CustomerCatalystMessenger.open();
    const p = t.panel();
    check('custom texts as text (no markup); title one line', find(p, tag('h2'))[0].textContent === '<img src=x onerror=alert(1)> line' && !find(p, n => n.tagName === 'img' && n.getAttribute('src') === 'x').length);
    check('greeting keeps its line break (pre-line) and up to 2000 chars', find(p, n => n.tagName === 'p')[0].textContent === 'Hello\nthere' + 'x'.repeat(1500) && /\.wh p\{[^}]*white-space:pre-line/.test(t.style()) && /\.sent h3\{[^}]*white-space:pre-line/.test(t.style()));
    check('custom reply time + button text', p.textContent.includes('Within a day') && !!find(p, byText('button', 'Write to us')).length);
    check('logo_url (protocol-relative) → https img', find(p, n => n.tagName === 'img')[0].getAttribute('src') === 'https://cdn.bubble.io/logo.png');
    check('help mode none: no Help center card', !p.textContent.includes('Help center'));
    t.window.CustomerCatalystMessenger.open('new');
    check('custom message hint', input(t, 'Message').getAttribute('placeholder') === 'What happened?');
    check('files off: no attach', !t.q(byText('button', 'Attach')).length && !t.q(n => n.getAttribute('type') === 'file').length);
    check('invisible Turnstile: hidden frame, Privacy link, no Turnstile line', turn(t).getAttribute('aria-hidden') === 'true'
      && t.q(cls('foot'))[0].textContent === 'Powered by CustomerCatalyst · Privacy');
  }

  // ── settings preview ──────────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-preview': '1', 'data-parents': 'https://app.bubble.example https://x.bubbleapps.io * javascript:x' }, config: ok(CFG), stored: { ccm_visitor: ME } });
    await flush();
    check('preview: no request, open on Home with defaults', t.calls.length === 0 && !t.panel().hidden && t.panel().textContent.includes('Hi there'));
    check('preview: ready ping to each listed settings origin, never "*"', JSON.stringify(t.window.parent.posted)
      === JSON.stringify([[{ type: 'cc-messenger-preview-ready' }, 'https://app.bubble.example'], [{ type: 'cc-messenger-preview-ready' }, 'https://x.bubbleapps.io']]));
    check('preview: no phone full-screen rule (the settings frame is narrow)', !t.style().includes('@media (max-width:480px)'));
    t.fromParent({ type: 'cc-messenger-preview', config: { org_name: 'Evil' } }, {});
    t.fromParent({ type: 'cc-messenger-preview', config: { org_name: 'Evil' } }, undefined, 'https://evil.example');
    check('preview: messages from another window or an unlisted origin ignored', !t.panel().textContent.includes('Evil'));
    t.fromParent({ type: 'cc-messenger-preview', config: Object.assign({}, CFG, { messenger: { position: 'left', icon: 'headset', texts: { title: 'Hey' } } }) });
    check('preview: config applied in place (one host)', t.body.children.filter(c => c.getAttribute('data-cc-messenger') !== null).length === 1 && t.panel().textContent.includes('Hey') && /left:24px/.test(t.style()));
    t.fromParent({ type: 'cc-messenger-preview', config: { messenger: { texts: { greeting: 'Second' } } } });
    check('preview: updates accumulate (texts merged)', t.panel().textContent.includes('Hey') && t.panel().textContent.includes('Second'));
    check('preview: a re-render does not replay the open animation (no flicker)', t.panel().getAttribute('class') === 'w still' && t.style().includes('.w.still{animation:none}'));
    t.q(cls('wbtn'))[0].click();
    const send = t.q(n => n.getAttribute('type') === 'submit')[0];
    check('preview New: Send disabled, no Turnstile, inputs (storage not read)', send.disabled && !t.q(tag('iframe')).length && !t.q(cls('who')).length && t.panel().textContent.includes('sending is off'));
    form(t).fire('submit');
    t.fromParent({ type: 'cc-messenger-preview', config: { messenger: { texts: { message_hint: 'Hint 2' } } } });
    check('preview: a re-render keeps the screen the settings page is looking at', input(t, 'Message').getAttribute('placeholder') === 'Hint 2');
    check('preview: nothing sent, nothing stored', t.calls.length === 0 && t.mem.ccm_visitor === ME && Object.keys(t.mem).length === 1);
  }

  // ── phase 2: conversations, thread, replies ──────────────────────────────
  const TA = 'A'.repeat(43), TB = 'B'.repeat(43), TC = 'C'.repeat(43);
  const iso = (daysAgo, h = 10, m = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const STORED = JSON.stringify([{ t: TA, label: 'SUP-51', subject: 'Export stops at 500 rows', read_at: iso(3) }, { t: TB, label: 'SUP-37', subject: 'Second address', read_at: iso(0, 23, 59) }, { t: 'D'.repeat(43), label: 'SUP-21', subject: 'Login', read_at: '' }]);
  const LIST = { body: { success: true, conversations: [
    { index: 0, label: 'SUP-51', subject: 'Export stops at 500 rows', status: 'open', last_at: iso(1, 16, 22), last_from: 'team', last_preview: "It's fixed on our side.", last_team_at: iso(1, 16, 22), last_author: 'Can', last_initials: 'CD' },
    { index: 1, label: 'SUP-37', subject: 'Second address', status: 'solved', last_at: iso(5), last_from: 'you', last_preview: 'Thanks!', last_team_at: iso(6), last_author: 'Utku', last_initials: 'UD' },
    { index: 2, label: 'SUP-21', subject: 'Login', status: 'closed', last_at: iso(9), last_from: 'you', last_kind: 'email', last_preview: '', last_team_at: null }] } };
  const THREAD = { body: { success: true, ticket: { label: 'SUP-51', subject: 'Export stops at 500 rows', status: 'open' }, messages: [
    { id: 'm1', from: 'you', text: 'When I export it stops at 500 rows.', at: iso(2, 9, 12), kind: 'message', files: [{ id: 'f1', name: 'export-oct.csv', size: 49152 }] },
    { id: 'm2', from: 'team', author: 'Can', initials: 'CD', text: 'Thanks Ali, I can reproduce it.', at: iso(2, 10, 40), kind: 'message', files: [{ id: 'f9', name: 'fix.png', size: null }] },
    { id: 'm3', from: 'you', text: 'SECRET owner mail text', at: iso(1, 8, 5), kind: 'email', files: [] },
    { id: 'm4', from: 'team', author: 'Can', initials: 'CD', text: "It's fixed on our side.\n<b>Try</b> again?", at: iso(0, 9, 0), kind: 'message', files: [] }] } };
  const CONV_CFG = Object.assign({}, CFG, { topics: [], fields: [] });
  const sent = (t, path) => t.calls.filter(c => c.url === HOST + path);
  const lastBody = (t, path) => { const c = sent(t, path).at(-1); return c && JSON.parse(c.opts.body); };
  const allText = t => JSON.stringify(t.calls.map(c => c.url)) + all(t.root()).map(n => JSON.stringify(n.attrs)).join('');
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST } });
    await flush();
    const c = sent(t, '/v1/messenger/conversations');
    check('one conversations call at load: POST JSON with the stored tokens, no credentials', c.length === 1 && c[0].opts.method === 'POST' && c[0].opts.credentials === 'omit'
      && JSON.stringify(lastBody(t, '/v1/messenger/conversations')) === JSON.stringify({ key: KEY, tokens: [TA, TB, 'D'.repeat(43)] }));
    check('panel closed: no timers', t.pending().length === 0);
    check('unread team reply → dot on the launcher, aria-label says so', !!find(t.launcher(), cls('ldot')).length && t.launcher().getAttribute('aria-label') === 'Open messenger, new reply');
    check('tokens never in a URL or a DOM attribute', !allText(t).includes(TA) && !allText(t).includes(TB));
    t.launcher().click();
    const p = t.panel();
    const card = find(p, n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0];
    check('Home: "Your conversations" card (a button) with the new reply and See all, after the message card', card && card.textContent.includes('New reply on "Export stops at 500 rows"') && card.textContent.includes('See all')
      && find(p, cls('wb'))[0].children.findIndex(n => n.textContent.includes('Your conversations')) === 1);
    check('launcher open: no dot', !find(t.launcher(), cls('ldot')).length);
    card.click();
    await flush();
    const items = t.q(cls('it'));
    check('list: last message by email → "Replied by email", Closed chip', items[2].textContent.includes('Replied by email') && find(items[2], cls('stc'))[0].textContent === 'Closed');
    check('list: newest first, subject, time, last line with the author, status chip, label', items.length === 3 && items[0].textContent.includes('Export stops at 500 rows') && items[0].textContent.includes('Yesterday')
      && items[0].textContent.includes("Can: It's fixed on our side.") && find(items[0], cls('stc'))[0].textContent === 'Open' && items[0].textContent.includes('SUP-51'));
    check('list: "You: …" for the visitor\'s last line, Solved chip, initials avatar', items[1].textContent.includes('You: Thanks!') && find(items[1], cls('stc'))[0].textContent === 'Solved' && find(items[1], cls('ava'))[0].textContent === 'UD');
    check('list: unread dot = last team reply newer than read_at (only the first)', cls('unread')(items[0]) && !cls('unread')(items[1]) && !!find(items[0], cls('dot')).length && items[0].textContent.includes('new reply'));
    check('list: footer with Send us a message + email + Not you?', t.panel().textContent.includes('ali@northwind.io') && !!t.q(byText('button', 'Not you?')).length && !!t.q(n => n.tagName === 'button' && cls('wbtn')(n)).length);
    check('list open: refreshed at once, then every 30 s', sent(t, '/v1/messenger/conversations').length === 2 && JSON.stringify(t.pending()) === '[30000]');
    t.runTimers(); await flush();
    check('list poll runs again after 30 s', sent(t, '/v1/messenger/conversations').length === 3 && JSON.stringify(t.pending()) === '[30000]');
    t.setVisible(false);
    check('hidden tab: list timer stopped', t.pending().length === 0);
    t.setVisible(true); await flush();
    check('visible again: refreshed at once and timer back', sent(t, '/v1/messenger/conversations').length === 4 && JSON.stringify(t.pending()) === '[30000]');
  }
  {
    const routes = { '/v1/messenger/conversations': LIST, '/v1/messenger/thread': THREAD, '/v1/messenger/file': { body: null } };
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: STORED }, routes });
    await flush();
    t.launcher().click();
    t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click();
    await flush();
    t.q(cls('it'))[0].click();
    await flush();
    const p = t.panel();
    check('thread: POST with the token in the body, seen:true while open + visible', JSON.stringify(lastBody(t, '/v1/messenger/thread')) === JSON.stringify({ key: KEY, token: TA, seen: true }));
    check('thread header: subject, label · status', find(p, tag('h2'))[0].textContent === 'Export stops at 500 rowsSUP-51 · Open');
    const mine = find(p, n => cls('m')(n) && cls('me')(n)), theirs = find(p, n => cls('m')(n) && cls('them')(n));
    check('bubbles: visitor right (me), team left (them) with initials + first name + time', mine.length === 1 && theirs.length === 2 && find(theirs[0], cls('ava'))[0].textContent === 'CD'
      && find(theirs[0], cls('by'))[0].textContent === 'CDCan · 10:40');
    check('team text as text (markup shown literally, line break kept)', find(theirs[1], tag('p'))[0].textContent === "It's fixed on our side.\n<b>Try</b> again?" && !find(theirs[1], tag('b')).length);
    const ev = find(p, cls('ev'));
    check('email-arrived message: neutral line "Replied by email · <time>", never its text', ev.length === 1 && ev[0].textContent === 'Replied by email · 08:05' && !p.textContent.includes('SECRET'));
    const days = find(p, cls('day')).map(n => n.textContent);
    check('day separators: a date, Yesterday, Today', days.length === 3 && days[1] === 'Yesterday' && days[2] === 'Today' && /\d/.test(days[0]));
    const chip = find(mine[0], cls('fc'))[0];
    check('file chip: name · size, a real button; no size from the server → name only', chip && chip.tagName === 'button' && chip.textContent === 'export-oct.csv · 48 KB'
      && find(theirs[0], cls('fc'))[0].textContent === 'fix.png');
    check('bubble CSS: radius 14, 4px tail corner, visitor in the org colour with auto text', /\.m p\{[^}]*border-radius:14px/.test(t.style()) && /\.me p\{background:#0e6b5c;color:#ffffff;border-bottom-right-radius:4px\}/.test(t.style())
      && /\.them p\{[^}]*border-bottom-left-radius:4px/.test(t.style()));
    check('composer: attach + textarea + send, 40px buttons', !!t.q(n => n.getAttribute('aria-label') === 'Attach a file').length && !!t.q(n => n.getAttribute('aria-label') === 'Write a reply').length
      && /\.sb\{width:40px;height:40px/.test(t.style()) && /\.cin\{[^}]*min-height:40px;max-height:96px/.test(t.style()));
    check('read: read_at moved to the newest shown message, launcher dot gone', JSON.parse(t.mem.ccm_conversations)[0].read_at === THREAD.body.messages[3].at);
    check('thread polls every 10 s', JSON.stringify(t.pending()) === '[10000]');
    t.runTimers(); await flush();
    check('second poll appends nothing twice', sent(t, '/v1/messenger/thread').length === 2 && find(t.panel(), cls('m')).length === 3);
    THREAD.body.messages.push({ id: 'm5', from: 'team', author: 'Can', initials: 'CD', text: 'Anything else?', at: iso(0, 9, 30), kind: 'message', files: [] });
    t.runTimers(); await flush();
    check('new team reply appended in place', find(t.panel(), cls('m')).length === 4 && t.panel().textContent.includes('Anything else?'));
    THREAD.body.messages.pop();
    chip.click(); await flush();
    check('file download: POST /file with token + file id in the body, blob → object URL', JSON.stringify(lastBody(t, '/v1/messenger/file')) === JSON.stringify({ key: KEY, token: TA, file_id: 'f1' }) && t.downloads.length === 1);
    t.setVisible(false);
    check('hidden tab: thread timer stopped', !t.pending().includes(10000));
    const before = sent(t, '/v1/messenger/thread').length;
    t.setVisible(true); await flush();
    check('visible again: fetched at once with seen:true', sent(t, '/v1/messenger/thread').length === before + 1 && lastBody(t, '/v1/messenger/thread').seen === true);
    t.window.CustomerCatalystMessenger.close();
    check('closed: no poll timers', !t.pending().includes(10000) && !t.pending().includes(30000));
    check('tokens never in a URL or DOM attribute (thread)', !allText(t).includes(TA));
  }
  {
    const replies = [];
    const routes = { '/v1/messenger/conversations': LIST, '/v1/messenger/thread': THREAD,
      '/v1/messenger/reply': fd => { replies.push(fd); return replies.length === 1 ? { status: 400, body: { success: false, error: 'validation', errors: { message: 'Too long.' } } }
        : replies.length === 2 ? { body: { success: true, files_failed: 1 } } : { body: { success: true, ticket_id_label: 'SUP-60', conversation_token: TC } }; } };
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: STORED }, routes });
    await flush();
    t.launcher().click();
    t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click(); await flush();
    t.q(cls('it'))[0].click(); await flush();
    const comp = () => t.q(cls('comp'))[0], ta = () => t.q(n => n.getAttribute('aria-label') === 'Write a reply')[0];
    comp().fire('submit');
    check('empty reply refused locally', replies.length === 0 && t.panel().textContent.includes('Write a message.'));
    const picker = find(comp(), n => n.getAttribute('type') === 'file')[0];
    picker.files = [{ name: 'virus.exe', size: 1 }]; picker.fire('change');
    check('reply files: same kinds/limits as New', t.panel().textContent.includes("can't be sent"));
    picker.files = [new File(['hi'], 'shot.png', { type: 'image/png' })]; picker.fire('change');
    check('picked file listed with a remove button', t.q(n => n.tagName === 'li').length === 1 && !!t.q(n => (n.getAttribute('aria-label') || '') === 'Remove shot.png').length);
    ta().value = 'Still broken';
    comp().fire('submit'); await flush();
    const fd = replies[0];
    check('reply: multipart key + token + message + files to /v1/messenger/reply, no Turnstile', fd instanceof FormData && fd.get('key') === KEY && fd.get('token') === TA && fd.get('message') === 'Still broken'
      && fd.getAll('files').length === 1 && !fd.has('turnstile_token') && sent(t, '/v1/messenger/reply')[0].opts.credentials === 'omit');
    check('refused reply: field error shown, text and file kept', t.panel().textContent.includes('Too long.') && ta().value === 'Still broken' && t.q(n => n.tagName === 'li').length === 1);
    const threadCalls = sent(t, '/v1/messenger/thread').length;
    ta().fire('keydown', { key: 'Enter', shiftKey: false }); await flush();
    check('Enter sends; success clears the composer and refreshes the thread', replies.length === 2 && ta().value === '' && t.q(n => n.tagName === 'li').length === 0 && sent(t, '/v1/messenger/thread').length === threadCalls + 1);
    ta().fire('keydown', { key: 'Enter', shiftKey: true });
    check('Shift+Enter does not send', replies.length === 2);
    check('files_failed: "1 file could not be attached." in the error style', t.q(cls('alert')).some(n => n.textContent === '1 file could not be attached.' && n.getAttribute('role') === 'alert'));
    ta().value = 'Reopen please';
    const listCalls = sent(t, '/v1/messenger/conversations').length;
    comp().fire('submit'); await flush();
    const st = JSON.parse(t.mem.ccm_conversations);
    check('follow-up: same token kept, its label updated (newest first), no new token stored', st.length === 3 && st[0].t === TA && st[0].label === 'SUP-60' && !st.some(c => c.t === TC));
    check('follow-up: list refreshed, thread reloaded on the same token, composer focused', sent(t, '/v1/messenger/conversations').length === listCalls + 1
      && lastBody(t, '/v1/messenger/thread').token === TA && focused === ta() && !t.q(cls('alert')).some(n => n.textContent));
  }
  {
    // reply errors: daily limit, rate limit, offline
    for (const [label, r, expect] of [['daily_limit', { status: 429, body: { success: false, error: 'daily_limit' } }, 'Please email us instead'],
      ['rate limit', { status: 429, body: { success: false, error: 'rate_limited' } }, 'Wait a minute'], ['offline', 'offline', 'Could not reach us']]) {
      const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST, '/v1/messenger/thread': THREAD, '/v1/messenger/reply': r } });
      await flush();
      t.launcher().click();
      t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click(); await flush();
      t.q(cls('it'))[0].click(); await flush();
      t.q(n => n.getAttribute('aria-label') === 'Write a reply')[0].value = 'x';
      t.q(cls('comp'))[0].fire('submit'); await flush();
      check('reply error (' + label + ') shown with kit wording', t.panel().textContent.includes(expect));
    }
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST, '/v1/messenger/thread': { status: 404, body: { success: false, error: 'not_found' } } } });
    await flush();
    t.launcher().click();
    t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click(); await flush();
    t.q(cls('it'))[0].click(); await flush();
    check('refused thread: "not available", no crash', t.panel().textContent.includes('This conversation is not available.'));
    check('404 not_found: the token is dropped from storage, the others kept', JSON.parse(t.mem.ccm_conversations).map(c => c.t).join() === [TB, 'D'.repeat(43)].join());
  }
  {
    // Hidden tab at open: the thread loads nothing until visible; seen only when visible.
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST, '/v1/messenger/thread': THREAD } });
    await flush();
    t.launcher().click();
    t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click(); await flush();
    t.document.visibilityState = 'hidden';
    t.q(cls('it'))[0].click(); await flush();
    check('hidden tab: thread not fetched, nothing marked seen', sent(t, '/v1/messenger/thread').length === 0 && t.pending().length === 0);
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST } });
    await flush();
    t.launcher().click();
    t.q(n => n.tagName === 'button' && n.textContent.startsWith('Your conversations'))[0].click(); await flush();
    t.q(byText('button', 'Not you?'))[0].click();
    check('Not you? with conversations asks first: nothing forgotten yet, Forget + Cancel', 'ccm_conversations' in t.mem && 'ccm_visitor' in t.mem
      && t.panel().textContent.includes('on this device? You can still reply by email.') && !!t.q(byText('button', 'Forget')).length);
    t.q(byText('button', 'Cancel'))[0].click();
    check('Cancel keeps everything and shows Not you? again', 'ccm_conversations' in t.mem && !!t.q(byText('button', 'Not you?')).length);
    t.q(byText('button', 'Not you?'))[0].click();
    t.q(byText('button', 'Forget'))[0].click();
    check('Not you? (list) forgets identity AND conversations, no card, no dot', !('ccm_visitor' in t.mem) && !('ccm_conversations' in t.mem)
      && !t.panel().textContent.includes('Your conversations') && !find(t.launcher(), cls('ldot')).length);
    const t2 = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: STORED }, routes: { '/v1/messenger/conversations': LIST } });
    await flush();
    t2.window.CustomerCatalystMessenger.open('new');
    find(t2.q(cls('who'))[0], tag('button'))[0].click();
    t2.q(byText('button', 'Forget'))[0].click();
    check('Not you? (New) forgets the conversations too', !('ccm_conversations' in t2.mem));
  }
  {
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_conversations: JSON.stringify([{ t: 'short' }, { t: TA, subject: 5 }, 'x']) + '' }, routes: { '/v1/messenger/conversations': { body: { success: true, conversations: [] } } } });
    await flush();
    check('junk entries ignored; only well-formed tokens asked for', JSON.stringify(lastBody(t, '/v1/messenger/conversations').tokens) === JSON.stringify([TA]));
    t.launcher().click();
    check('server knows none of them → no card', !t.panel().textContent.includes('Your conversations'));
    const t2 = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG) });
    await flush();
    check('no stored tokens → no conversations call', !sent(t2, '/v1/messenger/conversations').length);
  }
  {
    // Sent with a conversation token: stored, "Open conversation", 20 max.
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ t: String.fromCharCode(97 + i).repeat(43), label: 'L' + i, subject: 's' + i, read_at: '' })));
    const t = load({ attrs: { 'data-key': KEY }, config: ok(CONV_CFG), stored: { ccm_visitor: ME, ccm_conversations: many },
      submit: { body: { success: true, ticket_id_label: 'SUP-61', email: 'ali@northwind.io', conversation_token: TC, files_failed: 2 } },
      routes: { '/v1/messenger/conversations': b => ({ body: { success: true, conversations: [{ index: b.tokens.indexOf(TC), label: 'SUP-61', subject: 'New one', status: 'open', last_at: iso(0), last_from: 'you', last_preview: 'm' }] } }), '/v1/messenger/thread': THREAD } });
    await flush();
    t.window.CustomerCatalystMessenger.open('new');
    input(t, 'Subject').value = 'New one'; input(t, 'Message').value = 'm';
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, turn(t).contentWindow);
    form(t).fire('submit'); await flush();
    const st = JSON.parse(t.mem.ccm_conversations);
    check('submit token stored first, max 20 kept', st.length === 20 && st[0].t === TC && st[0].label === 'SUP-61' && st[0].subject === 'New one' && st[0].read_at === '');
    const p = t.panel();
    check('Sent: "We\'ll reply here and by email", steps per the design, Open conversation + Back to start', p.textContent.includes("We'll reply here and by email.")
      && p.textContent.includes("you'll see it in this window") && !!find(p, byText('button', 'Open conversation')).length && !!find(p, byText('button', 'Back to start')).length);
    check('Sent: "2 files could not be attached." in the error style', find(p, cls('alert')).some(n => n.textContent === '2 files could not be attached.' && n.getAttribute('role') === 'alert'));
    find(p, byText('button', 'Open conversation'))[0].click(); await flush();
    check('Open conversation → thread of the returned token', lastBody(t, '/v1/messenger/thread').token === TC && !!t.q(cls('msgs')).length);
    find(t.panel(), n => n.getAttribute('aria-label') === 'Back')[0].click(); await flush();
    check('thread Back → list with the new conversation', t.panel().textContent.includes('Your conversations') && t.q(cls('it')).length === 1 && t.q(cls('it'))[0].textContent.includes('You: m'));
  }
  {
    const t = load({ attrs: { 'data-preview': '1', 'data-parents': 'https://app.bubble.example' }, config: ok(CFG), stored: { ccm_conversations: STORED } });
    await flush();
    check('preview: no conversations card, no calls, no timers', !t.panel().textContent.includes('Your conversations') && t.calls.length === 0 && t.pending().length === 0);
  }

  check('messenger.js never uses innerHTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(SRC));
  check('postMessage never targets "*"', !/postMessage\([^)]*'\*'\)/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
