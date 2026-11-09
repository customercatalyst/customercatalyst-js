// Checks for the support form widget. No dependencies, no network, no browser:
// run with `node widgets/form/test.js`. form.js runs inside a tiny fake DOM (only
// the calls form.js makes) via new Function, with fetch/location/storage stubbed.
const fs = require('fs');
const path = require('path');
// The same bundle the Worker serves (worker/src/index.js widgetJs): kit + form in one closure.
const SRC = "(function () {\n'use strict';\n" + fs.readFileSync(path.join(__dirname, '../shared/kit.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(__dirname, 'form.js'), 'utf8') + '\n})();\n';
const HOST = 'https://cc.example';

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const tick = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ── fake DOM ────────────────────────────────────────────────────────────────
class Node {
  constructor(tag) { this.tagName = tag; this.attrs = {}; this.children = []; this.parent = null; this.listeners = {}; this.style = {}; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) { this.appendChild(c); this.children.pop(); this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, c); return c; }
  replaceChildren(...k) { this.children.forEach(c => { c.parent = null; }); this.children = []; k.forEach(c => this.appendChild(c)); }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tagName === '#text' ? this.text : this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v) this.appendChild(Object.assign(new Node('#text'), { text: String(v) })); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, ev) { ev = Object.assign({ type: t, preventDefault() { ev.prevented = true; } }, ev); (this.listeners[t] || []).forEach(fn => fn(ev)); return ev; }
  focus() { focused = this; }
  click() { this.fire('click'); }
  attachShadow() { this.shadowRoot = new Node('#shadow'); this.shadowRoot.host = this; return this.shadowRoot; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
}
let focused = null;
const all = (n, out = []) => { out.push(n); (n.shadowRoot ? [n.shadowRoot] : []).concat(n.children).forEach(c => all(c, out)); return out; };
const find = (root, pred) => all(root).filter(pred);
const tag = t => n => n.tagName === t;
const byText = (t, s) => n => n.tagName === t && n.textContent.includes(s);

function fakeScript(src, attrs) { return { src, getAttribute: n => (n in attrs ? attrs[n] : null), setAttribute: (n, v) => { attrs[n] = String(v); } }; }

function load({ attrs, config, submit, location, current, scripts }) {
  const body = new Node('body');
  const target = body.appendChild(new Node('div'));
  const button = body.appendChild(new Node('button'));
  const document = {
    readyState: 'complete', body, title: '',
    currentScript: current !== undefined ? current : fakeScript(HOST + '/v1/form.js', attrs),
    getElementsByTagName: t => (t === 'script' ? scripts || [] : []),
    createElement: t => { const n = new Node(t); if (t === 'iframe') n.contentWindow = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } }; return n; },
    createTextNode: s => Object.assign(new Node('#text'), { text: s }),
    querySelector: s => (s === '#target' ? target : s === '#btn' ? button : null),
    addEventListener() {},
  };
  const parentWin = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } };
  const window = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    parent: parentWin, scrollY: 120, scrolled: null, scrollTo(x, y) { this.scrolled = y; } };
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const r = url.includes('/v1/form/config') ? config : submit;
    return { status: r.status || 200, json: async () => r.body };
  };
  const mem = {};
  const localStorage = { getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; } };
  const loc = Object.assign({ origin: 'https://shop.example', assigned: null, assign(u) { this.assigned = u; } }, location);
  new Function('window', 'document', 'location', 'localStorage', 'fetch', SRC)(window, document, loc, localStorage, fetch);
  const post = (data, origin = HOST, source) => (window.listeners.message || []).forEach(fn => fn({ origin, source, data }));
  const fromParent = (config, source = parentWin, origin = 'https://app.bubble.example') => post({ type: 'cc-form-preview', config }, origin, source);
  return { window, document, body, target, button, calls, mem, loc, post, fromParent };
}

const CFG = {
  enabled: true, org_name: 'Sightl', color: '#FFE066', corners: 'pill', font: 'inter',
  title: '<img src=x onerror=alert(1)>', description: 'Tell us what happened.',
  button_text: '', help_site_url: 'https://help.sightl.com', help_mode: 'link',
  after_send: 'text', thank_you_text: 'Ticket *TICKET_NUMBER* for *REQUESTER_NAME* ({name}), copy to *REQUESTER_EMAIL*.', redirect_url: '',
  topics: [
    { id: 't1', name: 'Login problem', short_text: 'Try a password reset.', article_url: 'https://help.sightl.com/reset' },
    { id: 't2', name: 'Billing', short_text: '', article_url: 'javascript:alert(1)' },
  ],
  fields: [
    { id: 'f1', label: 'Order number', hint: 'Starts with NW', kind: 'short', required: true },
    { id: 'f2', label: 'Urgency', kind: 'list', options: ['Low', 'High'], required: false },
    { id: 'f3', label: 'I agree', kind: 'checkbox', required: false },
  ],
};
const ok = cfg => ({ body: { success: true, config: cfg } });
const PARENTS = 'https://app.bubble.example https://x.bubbleapps.io javascript:alert(1) *';
const control = (root, label) => {
  const l = find(root, n => n.tagName === 'label' && n.textContent.startsWith(label))[0];
  if (!l) return null;
  const id = l.getAttribute('for');
  return id ? find(root, n => n.getAttribute('id') === id)[0] : find(l, tag('input'))[0];
};
function fillIn(root) {
  control(root, 'Name').value = 'Maria';
  control(root, 'Email').value = 'maria@lund.no';
  control(root, 'Subject').value = 'Code never arrives';
  control(root, 'Message').value = 'Since this morning…';
  const o = control(root, 'Order number'); if (o) o.value = 'NW-1';
}

(async () => {
  // ── embedded ────────────────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'a'.repeat(48), 'data-target': '#target' }, config: ok(CFG), submit: {} });
    await flush();
    const root = t.target.children[0] && t.target.children[0].shadowRoot;
    check('embedded: renders into a shadow root inside the target', !!root);
    check('config fetched by key without credentials', t.calls[0].url === HOST + '/v1/form/config?key=pk_' + 'a'.repeat(48) && t.calls[0].opts.credentials === 'omit');
    check('org text goes in as text, not markup', find(root, tag('h2'))[0].textContent === CFG.title && !find(root, tag('img')).length);
    check('description shown', !!find(root, byText('p', 'Tell us what happened.')).length);
    check('help line links to the help site', find(root, n => n.tagName === 'a' && n.getAttribute('href') === 'https://help.sightl.com/').length === 1);
    ['Name', 'Email', 'Subject', 'Message', 'Order number', 'Urgency', 'I agree'].forEach(l => check('field ' + l + ' has a real label', !!control(root, l)));
    check('topic chips are radios in a fieldset', find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'radio').length === 2 && find(root, tag('legend')).length === 1);
    check('file upload shown when files_on missing', !!find(root, byText('button', 'Add file')).length);
    check('Turnstile frame on our host, told the page origin', find(root, tag('iframe'))[0].getAttribute('src') === HOST + '/v1/turnstile?origin=' + encodeURIComponent('https://shop.example'));
    check('managed Turnstile: line shown, frame visible, no privacy link', root.textContent.includes('Protected by Cloudflare Turnstile') && root.textContent.includes('Powered by CustomerCatalyst')
      && find(root, tag('iframe'))[0].getAttribute('class') === 'ts' && !find(root, byText('a', 'Privacy')).length);
    const style = find(root, tag('style'))[0].textContent;
    check('managed footer: one line "Protected by Cloudflare Turnstile · Powered by CustomerCatalyst"',
      find(root, n => n.getAttribute('class') === 'fine')[0].textContent === 'Protected by Cloudflare Turnstile · Powered by CustomerCatalyst');
    check('selects get their own chevron with room for it', /select\.in\{[^}]*appearance:none;padding-right:40px/.test(style) && style.includes('right 13px center'));
    check('light org colour (#FFE066) gets #13231F on the button and logo tile', /\.send\{[^}]*background:#ffe066;color:#13231F/.test(style) && /\.lg\{[^}]*background:#ffe066;color:#13231F/.test(style));
    check('pill corners', style.includes('border-radius:999px'));
    check('focus is subtle: org-colour 1px border + 3px ring at 15%, no thick outline', /\.in:focus\{border-color:#ffe066;outline:none;box-shadow:0 0 0 3px rgba\(255,224,102,\.15\)\}/.test(style) && !/outline:2px/.test(style));
    check('Inter font stack', style.includes('font-family:Inter'));
    check('no SDK globals touched', !('CustomerCatalyst' in t.window) && !('customercatalyst' in t.window) && t.window.CustomerCatalystForm.version === '1');

    // topics: short answer + article link, unsafe link dropped
    const radios = find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'radio');
    radios[0].fire('change');
    const ans = find(root, n => n.getAttribute('class') === 'ans')[0];
    check('picked topic shows its short answer and article link', !ans.hidden && ans.textContent.includes('Try a password reset.') && find(ans, tag('a'))[0].getAttribute('href') === 'https://help.sightl.com/reset');
    radios[1].fire('change');
    check('javascript: article link never rendered', ans.hidden && !find(ans, tag('a')).length);

    // validation
    const form = find(root, tag('form'))[0];
    control(root, 'Email').value = 'maria@lund-freight';
    form.fire('submit');
    const email = control(root, 'Email');
    const err = find(root, n => n.getAttribute('id') === email.getAttribute('aria-describedby'))[0];
    check('invalid email: aria-invalid + described-by error text', email.getAttribute('aria-invalid') === 'true' && err && err.textContent.includes('Check the email'));
    const order = control(root, 'Order number');
    check('required extra field: hint and error both described', order.getAttribute('aria-invalid') === 'true' && order.getAttribute('aria-describedby').split(' ').length === 2);
    check('focus moves to the first invalid field', focused === control(root, 'Name'));
    check('nothing sent while invalid', t.calls.length === 1);

    // files
    const picker = find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'file')[0];
    const MB = 1024 * 1024;
    const filesErr = () => find(root, n => n.getAttribute('id') && n.getAttribute('id').endsWith('-files-err'))[0];
    picker.files = [{ name: 'virus.exe', size: 10 }]; picker.fire('change');
    check('wrong file kind refused', filesErr().textContent.includes("can't be sent"));
    picker.files = [{ name: 'big.pdf', size: 10 * MB + 1 }]; picker.fire('change');
    check('file over 10 MB refused', filesErr().textContent.includes('over 10 MB'));
    picker.files = [{ name: 'a.pdf', size: 9 * MB }, { name: 'b.pdf', size: 9 * MB }, { name: 'c.pdf', size: 9 * MB }]; picker.fire('change');
    check('over 25 MB in total refused, first two kept', filesErr().textContent.includes('25 MB') && find(root, tag('li')).length === 2);
    find(root, n => n.tagName === 'button' && (n.getAttribute('aria-label') || '').startsWith('Remove'))
      .forEach(b => b.click());
    picker.files = Array.from({ length: 11 }, (_, i) => ({ name: 'p' + i + '.png', size: 1 })); picker.fire('change');
    check('more than 10 files refused', filesErr().textContent.includes('Up to 10') && find(root, tag('li')).length === 10);
  }

  // ── submit + thank-you, Turnstile origin check ────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'b'.repeat(48), 'data-target': '#target' }, config: ok(CFG),
      submit: { body: { success: true, ticket_id_label: 'SUP-59', name: 'Maria', email: 'maria@lund.no' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    const iframe = find(root, tag('iframe'))[0];
    fillIn(root);
    find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'radio')[0].fire('change');
    const picker = find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'file')[0];
    picker.files = [new File(['hi'], 'shot.png', { type: 'image/png' })]; picker.fire('change');
    t.post({ type: 'cc-turnstile', token: 'evil' }, 'https://evil.example', iframe.contentWindow);
    t.post({ type: 'cc-turnstile', token: 'evil' }, HOST, {});
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('token from another origin or frame ignored', t.calls.length === 1 && root.textContent.includes('security check is still running'));
    t.post({ type: 'cc-turnstile', token: 'tok-1' }, HOST, iframe.contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    const sub = t.calls[1];
    const fd = sub && sub.opts.body;
    check('submit posts multipart to our host', sub && sub.url === HOST + '/v1/form/submit' && fd instanceof FormData);
    check('multipart field names', fd && fd.get('key') === 'pk_' + 'b'.repeat(48) && fd.get('name') === 'Maria' && fd.get('email') === 'maria@lund.no'
      && fd.get('topic') === 't1' && fd.get('subject') === 'Code never arrives' && fd.get('field_f1') === 'NW-1' && fd.get('field_f3') === 'no'
      && fd.get('turnstile_token') === 'tok-1' && fd.getAll('files').length === 1);
    check('thank-you text fills *TICKET_NUMBER*, *REQUESTER_NAME*, *REQUESTER_EMAIL*; {name} left alone',
      root.textContent.includes('Ticket SUP-59 for Maria ({name}), copy to maria@lund.no.') && root.textContent.includes("We've got it."));
    check('ticket pill + summary', !!find(root, byText('span', 'SUP-59')).length && !!find(root, byText('dd', 'Code never arrives')).length);
    check('Turnstile asked for a fresh token after use', iframe.contentWindow.posted.some(([m, o]) => m.type === 'cc-turnstile-reset' && o === HOST));
    check('nothing about the visitor kept in storage', Object.keys(t.mem).length === 0);
  }

  // ── dark org colour gets white text ─────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'k'.repeat(48), 'data-target': '#target' }, config: ok(Object.assign({}, CFG, { color: '#0E6B5C' })) });
    await flush();
    const style = find(t.target.children[0].shadowRoot, tag('style'))[0].textContent;
    check('dark org colour (#0E6B5C) gets white on the button and logo tile', /\.send\{[^}]*background:#0e6b5c;color:#ffffff/.test(style) && /\.lg\{[^}]*background:#0e6b5c;color:#ffffff/.test(style));
  }

  // ── invisible Turnstile ──────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'i'.repeat(48), 'data-target': '#target' },
      config: ok(Object.assign({}, CFG, { turnstile_mode: 'invisible', privacy_url: 'https://customercatalyst.io/privacy' })),
      submit: { status: 400, body: { success: false, error: 'turnstile_failed' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    const iframe = find(root, tag('iframe'))[0];
    check('invisible: no Turnstile line, frame takes no space and is hidden', !root.textContent.includes('Protected by Cloudflare Turnstile')
      && iframe.getAttribute('class') === 'ts inv' && iframe.getAttribute('aria-hidden') === 'true');
    check('invisible footer: one line "Powered by CustomerCatalyst · Privacy"', find(root, n => n.getAttribute('class') === 'fine')[0].textContent === 'Powered by CustomerCatalyst · Privacy');
    check('invisible: Privacy link next to Powered by', find(root, n => n.tagName === 'a' && n.textContent === 'Privacy')[0].getAttribute('href') === 'https://customercatalyst.io/privacy');
    fillIn(root);
    find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'radio')[0].fire('change');
    t.post({ type: 'cc-turnstile', token: null, error: true }, HOST, iframe.contentWindow);
    find(root, tag('form'))[0].fire('submit');
    check('invisible failure: clear error, frame reset, nothing sent', root.textContent.includes("We couldn't verify this browser. Please try again.")
      && t.calls.length === 1 && iframe.contentWindow.posted.length === 1);
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, iframe.contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('server turnstile_failed shows the same error', t.calls.length === 2 && root.textContent.includes("We couldn't verify this browser."));
    const t2 = load({ attrs: { 'data-key': 'pk_' + 'j'.repeat(48), 'data-target': '#target' }, config: ok(Object.assign({}, CFG, { turnstile_mode: 'invisible', privacy_url: '' })) });
    await flush();
    check('invisible + empty PRIVACY_URL: no Privacy link', !find(t2.target.children[0].shadowRoot, n => n.tagName === 'a' && n.textContent === 'Privacy').length);
  }

  // ── default thank-you text ───────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'n'.repeat(48), 'data-target': '#target' },
      config: ok(Object.assign({}, CFG, { thank_you_text: '', topics: [], fields: [] })),
      submit: { body: { success: true, ticket_id_label: 'SUP-7', name: '<b>Ola</b>', email: 'ola@x.no' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    fillIn(root);
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, find(root, tag('iframe'))[0].contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('empty thank-you text: default, filled as text', root.textContent.includes("Thanks, <b>Ola</b>. Your request is SUP-7. We'll reply by email.") && !find(root, tag('b')).length);
  }

  // ── server field errors shown inline ─────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'c'.repeat(48), 'data-target': '#target' }, config: ok(CFG),
      submit: { status: 400, body: { success: false, error: 'validation', errors: { subject: 'Too long.' } } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    fillIn(root);
    find(root, n => n.tagName === 'input' && n.getAttribute('type') === 'radio')[0].fire('change');
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, find(root, tag('iframe'))[0].contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('server field error lands under the field', control(root, 'Subject').getAttribute('aria-invalid') === 'true' && root.textContent.includes('Too long.'));
  }

  // ── org daily cap ─────────────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'q'.repeat(48), 'data-target': '#target' }, config: ok(Object.assign({}, CFG, { topics: [], fields: [] })),
      submit: { status: 429, body: { success: false, error: 'daily_limit' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    fillIn(root);
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, find(root, tag('iframe'))[0].contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('daily_limit (429): "please email us", not "wait a minute"', root.textContent.includes("We can't take more messages right now. Please email us instead.") && !root.textContent.includes('Wait a minute'));
  }

  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'r'.repeat(48), 'data-target': '#target' }, config: ok(Object.assign({}, CFG, { topics: [], fields: [] })),
      submit: { status: 503, body: { success: false, error: 'try_again' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    fillIn(root);
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, find(root, tag('iframe'))[0].contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('try_again (503): "Something went wrong. Please try again.", input kept', root.textContent.includes('Something went wrong. Please try again.') && control(root, 'Subject').value === 'Code never arrives');
  }

  // ── redirect after send ──────────────────────────────────────────────────
  {
    const t = load({ attrs: { 'data-slug': 'sightl', 'data-target': '#target' },
      config: ok(Object.assign({}, CFG, { after_send: 'redirect', redirect_url: 'https://sightl.com/thanks', topics: [], fields: [] })),
      submit: { body: { success: true, ticket_id_label: 'SUP-1' } } });
    await flush();
    const root = t.target.children[0].shadowRoot;
    check('slug mode fetches by slug', t.calls[0].url.endsWith('?slug=sightl'));
    check('live (non-preview) fetch has no preview flag', !t.calls[0].url.includes('preview'));
    check('no topics: no chips', !find(root, tag('fieldset')).length);
    fillIn(root);
    t.post({ type: 'cc-turnstile', token: 'tok' }, HOST, find(root, tag('iframe'))[0].contentWindow);
    find(root, tag('form'))[0].fire('submit');
    await flush();
    check('no topics: topic not required, submit goes through', t.calls.length === 2 && !t.calls[1].opts.body.has('topic'));
    check('redirect after send', t.loc.assigned === 'https://sightl.com/thanks');
  }

  // ── optional parts hidden when off or empty ──────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'd'.repeat(48), 'data-target': '#target' },
      config: ok(Object.assign({}, CFG, { files_on: false, help_mode: 'none', topics: [], fields: [] })) });
    await flush();
    const root = t.target.children[0].shadowRoot;
    check('files_on=false hides the upload', !find(root, byText('button', 'Add file')).length && !find(root, n => n.getAttribute('type') === 'file').length);
    check('help none, no extra fields: hidden', !root.textContent.includes('Looking for an answer') && !control(root, 'Order number'));
  }
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'o'.repeat(48), 'data-target': '#target' },
      config: ok(Object.assign({}, CFG, { title: '', description: '', button_text: '' })) });
    await flush();
    const root = t.target.children[0].shadowRoot;
    check('empty texts use the settings placeholders: title, description, button', find(root, tag('h2'))[0].textContent === 'Contact support'
      && !!find(root, n => n.tagName === 'p' && n.textContent === "Tell us what happened. We'll reply by email.").length
      && find(root, n => n.getAttribute('type') === 'submit')[0].textContent === 'Send');
  }

  // ── closed / refused ─────────────────────────────────────────────────────
  for (const [label, config] of [['refused', { status: 403, body: { success: false, error: 'origin_not_allowed' } }], ['off', ok(Object.assign({}, CFG, { enabled: false }))]]) {
    const t = load({ attrs: { 'data-key': 'pk_' + 'e'.repeat(48), 'data-target': '#target' }, config });
    await flush();
    check('embedded renders nothing when ' + label, t.target.children.length === 0);
  }
  {
    const t = load({ attrs: { 'data-slug': 'sightl', 'data-target': '#target', 'data-mode': 'hosted' }, config: ok(Object.assign({}, CFG, { enabled: false })) });
    await flush();
    check('hosted page says closed when off', t.target.children[0].shadowRoot.textContent.includes('This form is closed right now.'));
  }
  {
    const t = load({ attrs: { 'data-slug': 'sightl', 'data-target': '#target', 'data-mode': 'hosted', 'data-preview': '1' }, config: ok(Object.assign({}, CFG, { enabled: false })) });
    await flush();
    const root = t.target.children[0].shadowRoot;
    const send = find(root, n => n.tagName === 'button' && n.getAttribute('type') === 'submit')[0];
    check('preview shows the form while off, Send disabled, no Turnstile', send && send.disabled && !find(root, tag('iframe')).length && root.textContent.includes('Preview'));
    check('hosted header shows the org', root.textContent.includes('Sightl support') && t.document.title === 'Sightl support');
  }
  {
    const t = load({ attrs: { 'data-key': 'nope', 'data-target': '#target' }, config: ok(CFG) });
    await flush();
    check('malformed key: no request, nothing rendered', t.calls.length === 0 && t.target.children.length === 0);
  }

  // ── popup from the org's own button ──────────────────────────────────────
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'f'.repeat(48), 'data-open': '#btn' }, config: ok(CFG) });
    await flush();
    const root = t.body.children[2].shadowRoot;
    const dialog = find(root, tag('dialog'))[0];
    check('popup: dialog labelled by the form title', dialog && dialog.getAttribute('aria-labelledby') && !dialog.open);
    check('popup: nothing loaded before the first open', !find(root, tag('iframe')).length);
    check('popup: opener announces a dialog', t.button.getAttribute('aria-haspopup') === 'dialog');
    const ev = t.button.fire('click');
    check('popup: click opens a modal with the form', dialog.open && ev.prevented && find(root, tag('form')).length === 1
      && find(root, n => n.getAttribute('id') === dialog.getAttribute('aria-labelledby'))[0].tagName === 'h2');
    find(root, n => n.getAttribute('aria-label') === 'Close')[0].click();
    check('popup: close returns focus to the button', !dialog.open && focused === t.button);
  }

  // ── live settings preview (postMessage from the framing settings page) ───
  {
    const t = load({ attrs: { 'data-key': 'pk_' + 'm'.repeat(48), 'data-target': '#target' }, config: ok(CFG) });
    await flush();
    t.fromParent({ title: 'Hacked' });
    check('no ready handshake outside preview mode', t.window.parent.posted.length === 0);
    check('preview message ignored outside preview mode', find(t.target.children[0].shadowRoot, tag('h2'))[0].textContent === CFG.title);
  }
  {
    const t = load({ attrs: { 'data-slug': 'sightl', 'data-target': '#target', 'data-mode': 'hosted', 'data-preview': '1', 'data-parents': PARENTS }, config: ok(CFG) });
    await flush();
    const root = () => t.target.children[0].shadowRoot;
    check('preview: tells each listed settings origin it is ready, with no data, never "*"', JSON.stringify(t.window.parent.posted)
      === JSON.stringify([[{ type: 'cc-form-preview-ready' }, 'https://app.bubble.example'], [{ type: 'cc-form-preview-ready' }, 'https://x.bubbleapps.io']]));
    t.fromParent({ title: 'Not from parent' }, {});
    check('preview: message from another window ignored', find(root(), tag('h2'))[0].textContent === CFG.title);
    t.fromParent({ title: 'Wrong origin' }, undefined, 'https://evil.example');
    check('preview: message from the parent on an unlisted origin ignored', find(root(), tag('h2'))[0].textContent === CFG.title);
    t.fromParent({ title: '<b>New title</b>', color: 'red;}*{display:none', help_site_url: 'javascript:alert(1)', help_mode: 'link', enabled: 'yes',
      topics: [{ id: 't9', name: 'Returns', short_text: 'x', article_url: 'javascript:alert(1)' }, 'junk'], fields: 'nope' });
    const r = root();
    const style = find(r, tag('style'));
    check('preview: merged and re-rendered in place (one host, one style)', t.target.children.length === 1 && style.length === 1
      && find(r, tag('h2'))[0].textContent === '<b>New title</b>' && !find(r, tag('b')).some(b => b.textContent === 'New title'));
    check('preview: bad colour falls back, no CSS injection', style[0].textContent.includes('background:#0e6b5c') && !style[0].textContent.includes('red;'));
    check('preview: javascript: links dropped, help line gone', !find(r, n => n.tagName === 'a' && /^javascript/i.test(n.getAttribute('href') || '')).length && !r.textContent.includes('Looking for an answer'));
    check('preview: fields kept from saved config when the update has none valid', !!control(r, 'Order number'));
    find(r, n => n.tagName === 'input' && n.getAttribute('type') === 'radio')[0].fire('change');
    check('preview: sent topics replace saved ones, junk entries skipped', find(r, n => n.getAttribute('type') === 'radio').length === 1 && !find(find(r, n => n.getAttribute('class') === 'ans')[0], tag('a')).length);
    t.fromParent({ description: 'Second update' });
    check('preview: updates accumulate', find(root(), tag('h2'))[0].textContent === '<b>New title</b>' && root().textContent.includes('Second update'));
    check('preview: Send still disabled, scroll kept, nothing sent', find(root(), n => n.getAttribute('type') === 'submit')[0].disabled && t.window.scrolled === 120 && t.calls.length === 1);
  }
  {
    const t = load({ attrs: { 'data-target': '#target', 'data-mode': 'hosted', 'data-preview': '1', 'data-parents': PARENTS }, config: ok(CFG) });
    await flush();
    const root = () => t.target.children[0].shadowRoot;
    check('/v1/preview (no key/slug): defaults rendered, no request', t.calls.length === 0 && find(root(), tag('h2'))[0].textContent === 'Contact support');
    t.fromParent({ org_name: 'Sightl', title: 'Help us help you', files_on: false });
    check('/v1/preview: settings page fills it in', root().textContent.includes('Sightl support') && find(root(), tag('h2'))[0].textContent === 'Help us help you' && !find(root(), byText('button', 'Add file')).length);
    check('page header defaults: "<org> support" + "We\'ll reply by email."', !!find(root(), n => n.tagName === 'b' && n.textContent === 'Sightl support').length
      && !!find(root(), n => n.tagName === 'small' && n.textContent === "We'll reply by email.").length);
    t.fromParent({ page_title: 'Help\ncentre <b>', page_subtitle: 'x'.repeat(200) });
    check('page_title / page_subtitle from a preview message: one line, capped at 120, as text',
      !!find(root(), n => n.tagName === 'b' && n.textContent === 'Help centre <b>').length
      && find(root(), tag('small'))[0].textContent.length === 120 && t.document.title === 'Help centre <b>');
    const t2 = load({ attrs: { 'data-target': '#target', 'data-mode': 'hosted' }, config: ok(CFG) });
    await flush();
    const t3 = load({ attrs: { 'data-target': '#target', 'data-preview': '1' }, config: ok(CFG) });
    await flush();
    check('/v1/preview embedded layout: card only, no page header', t3.calls.length === 0 && !!find(t3.target.children[0].shadowRoot, tag('form')).length
      && !find(t3.target.children[0].shadowRoot, n => n.getAttribute('class') === 'page').length);
    check('no key/slug outside preview: nothing', t2.calls.length === 0 && t2.target.children.length === 0);
  }

  // ── loaded by jQuery (Bubble/Webflow HTML element): currentScript null or a bare copy ─────────
  {
    const K = 'pk_' + 'a'.repeat(48);
    const pasted = fakeScript(HOST + '/v1/form.js', { 'data-key': K, 'data-target': '#target' });
    const t = load({ attrs: {}, config: ok(CFG), submit: {}, current: null, scripts: [fakeScript(HOST + '/v1/form.js.map', { 'data-key': K }), pasted] });
    await flush();
    check('jQuery eval (no currentScript): finds the pasted tag, renders', t.calls[0] && t.calls[0].url === HOST + '/v1/form/config?key=' + K && t.target.children.length === 1);
    check('the tag it used is marked taken (a second form takes the next tag)', pasted.getAttribute('data-cc-taken') === '');
    const t2 = load({ attrs: {}, config: ok(CFG), submit: {}, current: fakeScript(HOST + '/v1/form.js', {}), scripts: [fakeScript(HOST + '/v1/form.js', { 'data-key': K, 'data-target': '#target' })] });
    await flush();
    check('jQuery script-transport copy without attributes: falls back to the pasted tag', t2.calls.length === 1 && t2.target.children.length === 1);
    // No data-target / data-open: the form is drawn right where the tag was pasted.
    const box = new Node('div'), tagEl = fakeScript(HOST + '/v1/form.js', { 'data-key': K });
    box.appendChild(tagEl); tagEl.parentNode = box;
    const t5 = load({ attrs: {}, config: ok(CFG), submit: {}, current: tagEl });
    await flush();
    check('no target given: form drawn just before its own tag', box.children.length === 2 && box.children[1] === tagEl && !!box.children[0].children[0] && !!box.children[0].children[0].shadowRoot);
    // Already-taken tags are skipped:
    const taken = fakeScript(HOST + '/v1/form.js', { 'data-key': K, 'data-target': '#target', 'data-cc-taken': '' });
    const t4 = load({ attrs: {}, config: ok(CFG), submit: {}, current: null, scripts: [taken] });
    await flush();
    check('a tag another widget already took is not reused', t4.calls.length === 0);
  }

  check('form.js never uses innerHTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
