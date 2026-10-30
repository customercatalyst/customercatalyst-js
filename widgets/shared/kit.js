/*
 * Shared by form.js and messenger.js. Not a script of its own: the Worker serves each widget as
 *   (function(){ 'use strict'; <this file> <widget file> })();
 * (worker/src/index.js widgetJs), so these names are private to that one bundle and never global.
 * The tests build the same bundle (form/test.js, messenger/test.js). No build step.
 */
// Mirrors the messenger function (and _shared/attachments.ts ATTACHMENT_MIME);
// change both together. The server checks again; this only saves a wasted upload.
var LIMITS = { fileBytes: 10 * 1024 * 1024, files: 10, totalBytes: 25 * 1024 * 1024,
  name: 200, email: 254, subject: 200, message: 20000, short: 500, long: 5000 };
var KINDS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt'];
var KEY_RE = /^pk_[A-Za-z0-9]{16,64}$/;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
var FILE_HINT = 'Images, PDF, CSV, text and Office files · up to 10 MB each, 10 files, 25 MB in total';
var NOT_VERIFIED = 'We couldn\'t verify this browser. Please try again.';
// The org's daily cap (form + Messenger together) is reached: the function answers 429 daily_limit.
var DAILY_LIMIT = 'We can\'t take more messages right now. Please email us instead.';
var POWERED = 'https://customercatalyst.io';

// ── DOM + text ──────────────────────────────────────────────────────────────
function h(tag, attrs, kids) {
  var el = document.createElement(tag);
  for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
  (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return el;
}
// The widget's own <script> tag. document.currentScript is it for a normal tag, async/defer and
// createElement. jQuery-inserted HTML (Bubble/Webflow HTML elements, $.html) runs the file by eval
// (currentScript null) or through its own copy of the tag without our attributes; then the tag the
// site pasted is still in the page, so take the first one for this file that no widget took yet.
// ponytail: a script tag set as raw HTML text (not via jQuery) never runs at all; nothing to fix here.
function ownScript(file) {
  var mine = function (s) {
    if (!s || !s.src || s.getAttribute('data-cc-taken') !== null) return false;
    try { if (new URL(s.src, location.href).pathname !== '/v1/' + file) return false; } catch (e) { return false; }
    return s.getAttribute('data-key') !== null || s.getAttribute('data-slug') !== null || s.getAttribute('data-preview') !== null;
  };
  var s = document.currentScript;
  if (!mine(s)) {
    s = null;
    var all = document.getElementsByTagName ? document.getElementsByTagName('script') : [];
    for (var i = 0; i < all.length && !s; i++) if (mine(all[i])) s = all[i];
  }
  if (s) s.setAttribute('data-cc-taken', '');
  return s || document.currentScript;
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function safeUrl(u) {
  u = str(u);
  if (u.indexOf('//') === 0) u = 'https:' + u; // Bubble file URLs are protocol-relative
  try { var x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
}
function link(href, label, cls) {
  return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', 'class': cls }, [label]);
}
function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
// One centred line; it may only break between the parts (at the dot), never inside one.
function fineLine(parts, cls) {
  var fine = h('div', { 'class': cls || 'fine' });
  parts.filter(Boolean).forEach(function (x, i) { if (i) fine.appendChild(document.createTextNode(' · ')); fine.appendChild(h('span', {}, [x])); });
  return fine;
}
function poweredBy() { return link(POWERED, 'Powered by CustomerCatalyst'); }

// ── colours ─────────────────────────────────────────────────────────────────
// The org's colour on buttons, a darkened copy for text, so both stay at 4.5:1.
function rgb(hex) { return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); }
function lum(c) {
  c = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
// Text/icon on anything filled with the org colour: white or near-black, whichever contrasts more.
function onColor(c) { return contrast(c, [255, 255, 255]) >= contrast(c, [19, 35, 31]) ? '#ffffff' : '#13231F'; }
function mix(c, d, t) { return c.map(function (v, i) { return v + (d[i] - v) * t; }); }
function palette(color) {
  var c = /^#[0-9a-f]{6}$/i.test(str(color)) ? str(color) : /^#[0-9a-f]{3}$/i.test(str(color)) ? '#' + str(color).slice(1).replace(/./g, '$&$&') : '#0E6B5C';
  var brand = rgb(c), white = [255, 255, 255];
  var tint = mix(white, brand, 0.1), soft = mix(white, brand, 0.05), ink = brand;
  for (var i = 0; i < 20 && contrast(ink, tint) < 4.5; i++) ink = mix(ink, [0, 0, 0], 0.12);
  return { brand: hex(brand), on: onColor(brand), ink: hex(ink), tint: hex(tint), soft: hex(soft), ring: 'rgba(' + brand.join(',') + ',.15)' };
}
// Own select chevron, 13px in from the right; the select keeps padding-right:40px so text never runs under it.
var CHEVRON = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath d=%27M1 1.5l5 5 5-5%27 fill=%27none%27 stroke=%27%235F6B67%27 stroke-width=%271.6%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") no-repeat right 13px center';

// ── files ───────────────────────────────────────────────────────────────────
// Adds what fits to `files` (in place); returns the first problem as a sentence, or ''.
function takeFiles(files, list) {
  var problem = '';
  Array.prototype.forEach.call(list || [], function (f) {
    var ext = (f.name.lastIndexOf('.') > 0 ? f.name.slice(f.name.lastIndexOf('.') + 1) : '').toLowerCase();
    var total = files.reduce(function (s, x) { return s + x.size; }, 0);
    if (KINDS.indexOf(ext) === -1) problem = problem || f.name + ' can\'t be sent. Use images, PDF, CSV, text or Office files.';
    else if (f.size > LIMITS.fileBytes) problem = problem || f.name + ' is over 10 MB.';
    else if (files.length >= LIMITS.files) problem = problem || 'Up to 10 files.';
    else if (total + f.size > LIMITS.totalBytes) problem = problem || 'Files can add up to 25 MB in total.';
    else files.push(f);
  });
  return problem;
}
function filePicker() {
  var picker = h('input', { type: 'file', multiple: '', accept: KINDS.map(function (k) { return '.' + k; }).join(','), tabindex: '-1', 'aria-hidden': 'true' });
  picker.hidden = true;
  return picker;
}

// ── Turnstile ───────────────────────────────────────────────────────────────
// Turnstile runs in a frame on our host (/v1/turnstile); the token comes back by postMessage,
// accepted only from that frame and that origin. Invisible mode: the frame takes no space and
// is hidden from assistive tech.
function turnstile(HOST, invisible, onChange) {
  var st = { token: null, error: false };
  st.frame = h('iframe', { 'class': invisible ? 'ts inv' : 'ts', title: 'Security check', tabindex: invisible ? '-1' : null, 'aria-hidden': invisible ? 'true' : null,
    src: HOST + '/v1/turnstile?origin=' + encodeURIComponent(location.origin) });
  window.addEventListener('message', function (e) {
    if (e.origin !== HOST || e.source !== st.frame.contentWindow || !e.data || e.data.type !== 'cc-turnstile') return;
    st.token = typeof e.data.token === 'string' && e.data.token ? e.data.token : null;
    st.error = !!e.data.error;
    if (onChange) onChange(st);
  });
  // Tokens are single use: ask the frame for a fresh one.
  st.reset = function () { st.token = null; if (st.frame.contentWindow) st.frame.contentWindow.postMessage({ type: 'cc-turnstile-reset' }, HOST); };
  return st;
}

// ── submit ──────────────────────────────────────────────────────────────────
// The multipart body both widgets send (field names: worker/README.md). id = ['key'|'slug', value];
// v = { name, email, topic, subject, message }; extra fields read from their rows' controls.
function submissionData(id, v, extra, rows, files, token) {
  var fd = new FormData();
  fd.append(id[0], id[1]);
  fd.append('name', v.name); fd.append('email', v.email);
  if (v.topic) fd.append('topic', v.topic);
  fd.append('subject', v.subject); fd.append('message', v.message);
  extra.forEach(function (f) {
    var c = rows['field_' + str(f.id)].controls[0];
    fd.append('field_' + str(f.id), f.kind === 'checkbox' ? (c.checked ? 'yes' : 'no') : str(c.value));
  });
  files.forEach(function (f) { fd.append('files', f, f.name); });
  fd.append('turnstile_token', token);
  return fd;
}
// A refused submit as one sentence. closedCode/closedMsg: the widget's own "switched off" answer.
function submitErrorText(b, status, closedCode, closedMsg) {
  var e = b && b.error;
  return e === 'daily_limit' ? DAILY_LIMIT
    : status === 429 ? 'Too many messages. Wait a minute and try again.'
      : e === closedCode ? closedMsg
        : e === 'turnstile_failed' || e === 'turnstile_required' ? NOT_VERIFIED
          : e === 'try_again' ? 'Something went wrong. Please try again.'
            : 'Something went wrong and your message was not sent. Try again in a moment.';
}
// POST, then: success → o.done(body); field errors under their fields (focus the first); anything
// else in o.alert. The visitor's input is never cleared on failure. o.finish() runs first either way.
function postSubmission(url, fd, o) {
  fetch(url, { method: 'POST', body: fd, credentials: 'omit' })
    .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, b: b }; }); })
    .then(function (res) {
      o.finish();
      var b = res.b;
      if (b && b.success) return o.done(b);
      var errs = b && b.errors && typeof b.errors === 'object' ? b.errors : null, first = null;
      if (errs) for (var n in errs) if (Object.prototype.hasOwnProperty.call(o.rows, n) && o.rows[n] && typeof errs[n] === 'string') { o.setError(n, errs[n]); first = first || n; }
      if (first) { o.rows[first].controls[0].focus(); return; }
      o.alert.textContent = submitErrorText(b, res.status, o.closed[0], o.closed[1]);
    }, function () { o.finish(); o.alert.textContent = 'Could not reach us. Check your connection and try again.'; });
}

// ── settings preview ────────────────────────────────────────────────────────
// The Worker's preview pages list the settings-page origins that may frame them (data-parents,
// space-separated, the same list as their frame-ancestors). A preview message counts only from
// the framing window AND one of those origins; the ready ping goes to those origins only.
function previewParents(script) {
  return (script.getAttribute('data-parents') || '').split(/\s+/).filter(function (o) { return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o); });
}
function listenPreview(parents, type, onConfig) {
  if (!window.parent || window.parent === window) return;
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || parents.indexOf(e.origin) === -1 || !e.data || e.data.type !== type) return;
    onConfig(e.data);
  });
  // Handshake: the settings page may (re)create the frame after it last sent values; tell it we
  // listen so it sends them again. Carries no data.
  parents.forEach(function (o) { window.parent.postMessage({ type: type + '-ready' }, o); });
}

// ── config ──────────────────────────────────────────────────────────────────
// Every config, fetched or sent by the settings preview, goes through here: known keys
// only, each with its type, strings capped. Meaning (hex, http(s), enums) is checked where used.
var STR = ['org_name', 'color', 'logo_url', 'corners', 'font', 'title', 'description', 'button_text', 'help_site_url',
  'help_mode', 'after_send', 'thank_you_text', 'redirect_url', 'turnstile_mode', 'privacy_url'];
function capStr(v, max) { return typeof v === 'string' ? v.slice(0, max || 2000) : ''; }
function clean(c) {
  var out = {};
  if (!c || typeof c !== 'object') return out;
  var s = capStr;
  var list = function (v, fn) { return Array.isArray(v) ? v.slice(0, 100).filter(function (x) { return x && typeof x === 'object'; }).map(fn) : undefined; };
  STR.forEach(function (k) { if (k in c) out[k] = s(c[k]); });
  // Page header texts: one short line each.
  ['page_title', 'page_subtitle'].forEach(function (k) { if (k in c) out[k] = s(c[k], 120).replace(/[\r\n\t]+/g, ' '); });
  if ('enabled' in c) out.enabled = c.enabled === true;
  if ('files_on' in c) out.files_on = c.files_on !== false;
  var topics = list(c.topics, function (t) { return { id: s(t.id, 100), name: s(t.name, 200), short_text: s(t.short_text), article_url: s(t.article_url) }; });
  if (topics) out.topics = topics;
  var fields = list(c.fields, function (f) {
    return { id: s(f.id, 100), label: s(f.label, 200), hint: s(f.hint, 500), kind: s(f.kind, 20), required: f.required === true,
      options: Array.isArray(f.options) ? f.options.slice(0, 100).map(function (o) { return s(o, 200); }) : [] };
  });
  if (fields) out.fields = fields;
  return out;
}
function validTopics(cfg) { return (Array.isArray(cfg.topics) ? cfg.topics : []).filter(function (t) { return t && str(t.id) && str(t.name); }); }
function validFields(cfg) { return (Array.isArray(cfg.fields) ? cfg.fields : []).filter(function (f) { return f && str(f.id) && str(f.label); }); }
