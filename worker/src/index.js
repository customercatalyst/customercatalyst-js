// CustomerCatalyst Messenger Worker: serves the support form and Messenger widgets and sits
// between visitors' browsers and the Supabase `messenger` function. The function
// does the real checks (key, allowed sites, form on, validation); this Worker adds
// what only the edge can do: Turnstile, rate limits, a body cap and a config cache.
// The function secret and Turnstile secret never leave here.
// Shapes: worker/README.md. Contract: customercatalyst-dev docs/scopes/messenger.md.

const KEY_RE = /^pk_[A-Za-z0-9]{16,64}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Conversation tokens (32 random bytes, base64url) travel in POST bodies only, never in URLs or logs.
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_JSON = 16 * 1024; // 20 tokens + a key fit many times over
const MAX_BODY = 26 * 1024 * 1024; // the function allows 25 MB of files + the fields
const CONFIG_TTL = 60;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Fields only the Worker may set on the forwarded submit.
const WORKER_FIELDS = ['action', 'origin_host', 'client_ip', 'turnstile_token'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      const api = path.match(/^\/v1\/(form|messenger)\/(config|submit)$/);
      const conv = path.match(/^\/v1\/messenger\/(conversations|thread|reply|file)$/);
      const survey = path.match(/^\/s\/([^/]+)(\/unsubscribe|\/logo)?$/);
      if (method === 'OPTIONS' && (api || conv)) return preflight(request);
      if (method === 'POST' && (path === '/v1/survey/answer' || path === '/v1/survey/unsubscribe')) return await surveyPost(request, env, url, path.slice(11));
      if (method === 'POST' && survey && survey[2] === '/unsubscribe') return await oneClickUnsubscribe(request, env, survey[1]);
      if (method === 'POST' && api && api[2] === 'submit') return await submit(request, env, url, api[1]);
      if (method === 'POST' && conv) return await (conv[1] === 'reply' ? reply(request, env, url) : conversation(request, env, url, conv[1]));
      if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed');
      if (path === '/v1/form.js') return await widgetJs(env, url, 'form/form.js');
      if (path === '/v1/messenger.js') return await widgetJs(env, url, 'messenger/messenger.js');
      if (path === '/v1/survey.js') return await widgetJs(env, url, 'survey/survey.js');
      if (survey && survey[2] === '/logo') return await surveyLogo(request, env, survey[1]);
      if (survey) return await surveyPage(request, env, survey[1], survey[2] ? 'unsubscribe' : 'answer');
      if (api && api[2] === 'config') return await config(request, env, ctx, url, api[1]);
      if (path === '/v1/turnstile') return turnstilePage(env, url);
      if (path === '/v1/preview') return previewPage(url, env);
      if (path === '/v1/messenger/preview') return messengerPreviewPage(env);
      if (path === '/demo' && env.ENVIRONMENT === 'test') return demoPage(url);
      let m = path.match(/^\/f\/([^/]+)$/);
      // HOSTED_HOST (empty everywhere now) would serve the hosted page at /<slug> on that host.
      if (!m && env.HOSTED_HOST && url.hostname === env.HOSTED_HOST) m = path.match(/^\/([^/]+)$/);
      if (m && SLUG_RE.test(m[1])) return hostedPage(m[1]);
      return text(404, 'Not found');
    } catch (e) {
      console.error('worker error', e && e.stack || e);
      return json(500, { success: false, error: 'server_error' }, request.headers.get('Origin'));
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function text(status, body, headers) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

// CORS: echo the page's Origin, never credentials. Which sites may use a key is
// decided by the function from origin_host, not here.
function cors(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

function preflight(request) {
  const page = pageOf(request, new URL(request.url));
  if (!page || !page.origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors(page.origin), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
  });
}

// The page the request comes from. Browsers send Origin on every cross-site
// request and on same-origin POSTs; a same-origin GET (our hosted page) has none,
// so fall back to Sec-Fetch-Site, which page scripts cannot set. Anything else
// (curl, 'null' origins from sandboxes/file://) is not a browser page: refuse.
function pageOf(request, url) {
  const o = request.headers.get('Origin');
  if (o) {
    try {
      const u = new URL(o);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o) return { origin: o, host: u.host };
    } catch { /* fall through */ }
    return null;
  }
  if (request.headers.get('Sec-Fetch-Site') === 'same-origin') return { origin: null, host: url.host };
  return null;
}

// A slug skips the allowed-sites check, so it is only good on our own hosted page.
// Anywhere else it answers like an unknown key; embeds use data-key.
function slugAllowed(page, url, env) {
  return page.host === url.host || (!!env.HOSTED_HOST && page.host === env.HOSTED_HOST);
}
const UNKNOWN = { success: false, error: 'invalid_api_key' };

// Exactly one of key / slug, well-formed. Messenger takes a key only.
function idOf(get, kind) {
  const key = get('key'), slug = get('slug');
  if (key && !slug && typeof key === 'string' && KEY_RE.test(key)) return { key };
  if (kind === 'form' && slug && !key && typeof slug === 'string' && SLUG_RE.test(slug)) return { slug };
  return null;
}

const modeOf = env => (env.TURNSTILE_MODE === 'invisible' ? 'invisible' : 'managed');

const ipOf = request => request.headers.get('CF-Connecting-IP') || '';

function callFunction(env, body, isJson) {
  return fetch(env.SUPABASE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'X-CC-Worker-Secret': env.MESSENGER_WORKER_SECRET, ...(isJson ? { 'Content-Type': 'application/json' } : {}) },
    body: isJson ? JSON.stringify(body) : body,
  });
}

// Only pass on the keys the browser contract names, whatever else the function adds.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function relay(res, keys, origin, extraConfig) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!body || typeof body !== 'object') return json(502, { success: false, error: 'upstream_error' }, origin);
  const out = pick(body, keys);
  // Worker-owned settings ride along in the config (Turnstile mode, privacy link).
  if (extraConfig && out.config && typeof out.config === 'object') Object.assign(out.config, extraConfig);
  return json(res.status, out, origin);
}

function configured(env) {
  return env.SUPABASE_FUNCTION_URL && env.MESSENGER_WORKER_SECRET && env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY;
}

// ── routes ─────────────────────────────────────────────────────────────────

// Each widget is served as one closure around the shared helpers and the widget file
// (see widgets/shared/kit.js); no build step, two separate script URLs.
async function widgetJs(env, url, file) {
  const [kit, widget] = await Promise.all(['shared/kit.js', file].map(f => env.ASSETS.fetch(new Request(new URL('/' + f, url)))));
  if (!kit.ok || !widget.ok) return text(404, 'Not found');
  return new Response(bundle(await kit.text(), await widget.text()), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

export const bundle = (kit, widget) => "(function () {\n'use strict';\n" + kit + '\n' + widget + '\n})();\n';

async function config(request, env, ctx, url, kind) {
  const page = pageOf(request, url);
  if (!page) return json(403, { success: false, error: 'origin_required' });
  const id = idOf(n => url.searchParams.get(n), kind);
  if (!id) return json(400, { success: false, error: 'bad_request' }, page.origin);
  if (id.slug && !slugAllowed(page, url, env)) return json(403, UNKNOWN, page.origin);
  if (!configured(env)) return json(503, { success: false, error: 'not_configured' }, page.origin);

  // Cached per widget + key (or slug) + page host: the allow-list answer depends on all three.
  // Only the org's public config is cached, never anything about the visitor.
  const cacheKey = new Request(`https://${url.hostname}/__config/${kind}?${id.key ? 'key=' + id.key : 'slug=' + id.slug}&host=${encodeURIComponent(page.host)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(page.origin) } });

  if (!(await env.RL_CONFIG_IP.limit({ key: ipOf(request) })).success) return json(429, { success: false, error: 'rate_limited' }, page.origin);

  const body = kind === 'form'
    ? { action: 'form_config', key: id.key || null, slug: id.slug || null, origin_host: page.host, client_ip: ipOf(request) }
    : { action: 'messenger_config', key: id.key, origin_host: page.host, client_ip: ipOf(request) };
  const res = await callFunction(env, body, true);
  const out = await relay(res, ['success', 'error', 'config'], page.origin, { turnstile_mode: modeOf(env), privacy_url: env.PRIVACY_URL || '' });
  if (res.ok && out.status === 200) {
    const cached = await out.clone().text();
    ctx.waitUntil(cache.put(cacheKey, new Response(cached, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CONFIG_TTL}` } })));
  }
  return out;
}

async function verifyTurnstile(env, token, ip, url) {
  const res = await fetch(SITEVERIFY, {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const d = await res.json();
  // The token must come from the widget on OUR host (the /v1/turnstile frame),
  // not from some other site that happens to use the same sitekey.
  return d && d.success === true && d.hostname === url.hostname;
}

async function submit(request, env, url, kind) {
  const page = pageOf(request, url);
  if (!page || !page.origin) return json(403, { success: false, error: 'origin_required' });
  const o = page.origin;
  if (!configured(env)) return json(503, { success: false, error: 'not_configured' }, o);

  // Cap before reading: formData() buffers the whole body.
  const len = Number(request.headers.get('Content-Length'));
  if (!len) return json(411, { success: false, error: 'length_required' }, o);
  if (len > MAX_BODY) return json(413, { success: false, error: 'too_large' }, o);
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('multipart/form-data')) {
    return json(415, { success: false, error: 'multipart_required' }, o);
  }

  const ip = ipOf(request);
  if (!(await env.RL_SUBMIT_IP.limit({ key: ip })).success) return json(429, { success: false, error: 'rate_limited' }, o);

  let form;
  try { form = await request.formData(); } catch { return json(400, { success: false, error: 'bad_request' }, o); }
  const id = idOf(n => form.get(n), kind);
  if (!id) return json(400, { success: false, error: 'bad_request' }, o);
  if (id.slug && !slugAllowed(page, url, env)) return json(403, UNKNOWN, o);
  if (!(await env.RL_SUBMIT_KEY.limit({ key: id.key || 'slug:' + id.slug })).success) return json(429, { success: false, error: 'rate_limited' }, o);

  const token = form.get('turnstile_token');
  if (typeof token !== 'string' || !token || token.length > 2048) return json(400, { success: false, error: 'turnstile_required' }, o);
  let human = false;
  try { human = await verifyTurnstile(env, token, ip, url); } catch (e) {
    console.error('siteverify failed', e && e.message);
    return json(502, { success: false, error: 'turnstile_unavailable' }, o);
  }
  if (!human) return json(400, { success: false, error: 'turnstile_failed' }, o);

  // Never trust these from the browser: drop, then set our own.
  for (const k of WORKER_FIELDS) form.delete(k);
  form.append('action', kind === 'form' ? 'form_submit' : 'messenger_submit');
  form.append('origin_host', page.host);
  form.append('client_ip', ip);
  const res = await callFunction(env, form, false);
  return relay(res, ['success', 'error', 'errors', 'ticket_id_label', 'name', 'email', 'confirmation', 'conversation_token', 'files_failed'], o);
}

// ── conversations (phase 2) ────────────────────────────────────────────────
// The visitor's conversation token is the proof (no Turnstile); the function checks key, Origin,
// Messenger on and that the token's org is the key's org. Nested answers are allow-listed too.
const pickAll = (list, keys) => (Array.isArray(list) ? list.map(x => pick(x, keys)) : undefined);
const CONV_KEYS = ['index', 'label', 'subject', 'status', 'last_at', 'last_from', 'last_kind', 'last_preview', 'last_team_at', 'last_author', 'last_initials'];
const MSG_KEYS = ['id', 'from', 'author', 'initials', 'text', 'at', 'files', 'kind'];
// What a downloaded file may be served as (the attachment kinds); anything else is a plain download.
const FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/csv', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length'));
  if (!len || len > MAX_JSON) return null;
  const t = await request.text();
  if (t.length > MAX_JSON) return null;
  try { const b = JSON.parse(t); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

// POST /v1/messenger/conversations {key, tokens[≤20]} · /thread {key, token, seen} · /file {key, token, file_id}
// Limits: the list per IP (RL_LIST_IP, it fans out to several reads), thread + file per IP
// (RL_READ_IP), all three per key (RL_READ_KEY).
async function conversation(request, env, url, route) {
  const page = pageOf(request, url);
  if (!page || !page.origin) return json(403, { success: false, error: 'origin_required' });
  const o = page.origin;
  if (!configured(env)) return json(503, { success: false, error: 'not_configured' }, o);
  const limited = json(429, { success: false, error: 'rate_limited' }, o);
  if (!(await (route === 'conversations' ? env.RL_LIST_IP : env.RL_READ_IP).limit({ key: ipOf(request) })).success) return limited;
  const b = await readJson(request);
  const bad = json(400, { success: false, error: 'bad_request' }, o);
  if (!b || typeof b.key !== 'string' || !KEY_RE.test(b.key)) return bad;
  if (!(await env.RL_READ_KEY.limit({ key: b.key })).success) return limited;
  const base = { action: 'messenger_' + route, key: b.key, origin_host: page.host, client_ip: ipOf(request) };
  if (route === 'conversations') {
    if (!Array.isArray(b.tokens) || b.tokens.length > 20) return bad;
    // Malformed tokens are dropped, not fatal for the list; answers keep the browser's indexes.
    const at = [];
    b.tokens.forEach((t, i) => { if (typeof t === 'string' && TOKEN_RE.test(t)) at.push(i); });
    if (!at.length) return json(200, { success: true, conversations: [] }, o);
    const res = await callFunction(env, { ...base, tokens: at.map(i => b.tokens[i]) }, true);
    const out = await relayJson(res);
    if (!out) return json(502, { success: false, error: 'upstream_error' }, o);
    const conversations = Array.isArray(out.conversations)
      ? pickAll(out.conversations.filter(c => c && Number.isInteger(c.index) && at[c.index] !== undefined), CONV_KEYS)
        .map(c => ({ ...c, index: at[c.index] }))
      : undefined;
    return json(res.status, { ...pick(out, ['success', 'error']), ...(conversations ? { conversations } : {}) }, o);
  }
  if (typeof b.token !== 'string' || !TOKEN_RE.test(b.token)) return bad;
  if (route === 'thread') {
    const res = await callFunction(env, { ...base, token: b.token, seen: b.seen === true }, true);
    const out = await relayJson(res);
    if (!out) return json(502, { success: false, error: 'upstream_error' }, o);
    const body = pick(out, ['success', 'error']);
    if (out.ticket && typeof out.ticket === 'object') body.ticket = pick(out.ticket, ['label', 'subject', 'status']);
    if (Array.isArray(out.messages)) body.messages = out.messages.map(m => ({ ...pick(m, MSG_KEYS), files: pickAll(m && m.files, ['id', 'name', 'size']) || [] }));
    return json(res.status, body, o);
  }
  // file
  if (typeof b.file_id !== 'string' || !b.file_id || b.file_id.length > 500) return bad;
  const res = await callFunction(env, { ...base, token: b.token, file_id: b.file_id }, true);
  const ct = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok || ct === 'application/json') return relay(res, ['success', 'error'], o);
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': FILE_TYPES.includes(ct) ? ct : 'application/octet-stream',
      // The function's own disposition (attachment; filename*=UTF-8''…) when it is an attachment.
      'Content-Disposition': /^attachment\b/i.test(res.headers.get('Content-Disposition') || '') ? res.headers.get('Content-Disposition') : 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
      ...cors(o),
    },
  });
}

async function relayJson(res) {
  try { const b = await res.json(); return b && typeof b === 'object' ? b : null; } catch { return null; }
}

// POST /v1/messenger/reply (multipart: key, token, message, files) → messenger_reply.
async function reply(request, env, url) {
  const page = pageOf(request, url);
  if (!page || !page.origin) return json(403, { success: false, error: 'origin_required' });
  const o = page.origin;
  if (!configured(env)) return json(503, { success: false, error: 'not_configured' }, o);
  const len = Number(request.headers.get('Content-Length'));
  if (!len) return json(411, { success: false, error: 'length_required' }, o);
  if (len > MAX_BODY) return json(413, { success: false, error: 'too_large' }, o);
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('multipart/form-data')) {
    return json(415, { success: false, error: 'multipart_required' }, o);
  }
  if (!(await env.RL_REPLY_IP.limit({ key: ipOf(request) })).success) return json(429, { success: false, error: 'rate_limited' }, o);
  let form;
  try { form = await request.formData(); } catch { return json(400, { success: false, error: 'bad_request' }, o); }
  const key = form.get('key'), token = form.get('token');
  if (typeof key !== 'string' || !KEY_RE.test(key) || typeof token !== 'string' || !TOKEN_RE.test(token)) {
    return json(400, { success: false, error: 'bad_request' }, o);
  }
  if (!(await env.RL_REPLY_KEY.limit({ key })).success) return json(429, { success: false, error: 'rate_limited' }, o);
  for (const k of WORKER_FIELDS) form.delete(k);
  form.append('action', 'messenger_reply');
  form.append('origin_host', page.host);
  form.append('client_ip', ipOf(request));
  const res = await callFunction(env, form, false);
  // ticket_id_label only when a Closed ticket got a follow-up (the same token now points at it).
  return relay(res, ['success', 'error', 'errors', 'id', 'at', 'ticket_id_label', 'files_failed'], o);
}

// ── pages ──────────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: escape '<' so a value can never close the tag.
const jsLit = v => JSON.stringify(v).replace(/</g, '\\u003c');

function html(body, csp, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
    },
  });
}

// Renders Turnstile on our own host (so siteverify's hostname is ours) and hands
// the token to the embedding page with postMessage, addressed to that page's
// origin only. form.js accepts it only from this frame and this host.
function turnstilePage(env, url) {
  const parentOrigin = url.searchParams.get('origin') || '';
  let ok = false;
  try {
    const u = new URL(parentOrigin);
    ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === parentOrigin;
  } catch { /* invalid */ }
  if (!ok || !env.TURNSTILE_SITEKEY) return text(400, 'Bad request');
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Security check</title>
<style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body><div id="t"></div>
<script nonce="${nonce}">
var PARENT=${jsLit(parentOrigin)};
function send(m){parent.postMessage(m,PARENT);}
window.ccTurnstileLoad=function(){turnstile.render('#t',{sitekey:${jsLit(env.TURNSTILE_SITEKEY)},${modeOf(env) === 'managed' ? "appearance:'always'," : ''}
callback:function(t){send({type:'cc-turnstile',token:t});},
'expired-callback':function(){send({type:'cc-turnstile',token:null});},
'error-callback':function(){send({type:'cc-turnstile',token:null,error:true});return true;}});};
addEventListener('message',function(e){if(e.origin===PARENT&&e.source===parent&&e.data&&e.data.type==='cc-turnstile-reset'&&window.turnstile)turnstile.reset('#t');});
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ccTurnstileLoad&amp;render=explicit" async defer></script>
</body></html>`,
  `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`);
}

const PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function hostedPage(slug) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Support</title>
<style>body{margin:0;background:#F3F5F4;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#13231F}</style></head>
<body><main id="cc-form"></main>
<script src="/v1/form.js" data-slug="${esc(slug)}" data-target="#cc-form" data-mode="hosted" async></script>
</body></html>`, PAGE_CSP + "; frame-ancestors 'none'");
}

// The settings pages (Bubble) that may frame the previews: PREVIEW_PARENT_ORIGINS, space-separated
// https origins. They become frame-ancestors AND the page's data-parents list, which the widget
// checks every preview message's origin against (and sends its ready ping to).
function previewParents(env) {
  return String(env.PREVIEW_PARENT_ORIGINS || '').split(/\s+/).filter(o => {
    try { const u = new URL(o); return u.protocol === 'https:' && u.origin === o; } catch { return false; }
  });
}
function previewCsp(env) {
  const parents = previewParents(env);
  return PAGE_CSP + '; frame-ancestors ' + (parents.length ? parents.join(' ') : "'none'");
}

// Settings preview before anything is saved: form.js with defaults, filled in by the
// settings page over postMessage. It cannot send.
function previewPage(url, env) {
  // layout=embedded (default): the card alone on a transparent page, as it sits in a customer's
  // page. layout=page: the hosted page.
  const page = url.searchParams.get('layout') === 'page';
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Preview</title>
<style>body{margin:0;${page ? 'background:#F3F5F4' : 'background:transparent;padding:16px'};font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#13231F}</style></head>
<body><main id="cc-form"></main>
<script src="/v1/form.js" data-target="#cc-form"${page ? ' data-mode="hosted"' : ''} data-preview="1" data-parents="${esc(previewParents(env).join(' '))}" async></script>
</body></html>`, previewCsp(env));
}

// Messenger settings preview: messenger.js open on Home, never fetches or sends; the settings
// page feeds it {type:"cc-messenger-preview", config, screen?} by postMessage.
function messengerPreviewPage(env) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Preview</title>
<style>html,body{margin:0;height:100%;background:transparent;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style></head>
<body><script src="/v1/messenger.js" data-preview="1" data-parents="${esc(previewParents(env).join(' '))}" async></script>
</body></html>`, previewCsp(env));
}

function demoPage(url) {
  const key = url.searchParams.get('key') || '';
  const slug = url.searchParams.get('slug') || '';
  const k = KEY_RE.test(key) ? key : '';
  const s = SLUG_RE.test(slug) ? slug : '';
  // Uses the key when given (tests the allowed-sites check), else the slug.
  const attr = k ? `data-key="${esc(k)}"` : s ? `data-slug="${esc(s)}"` : '';
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Northwind Freight · Contact</title>
<style>
body{margin:0;font-family:Georgia,"Times New Roman",serif;background:#F6F4EF;color:#1B2A26}
a{color:#0B5D4F}
.nav{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:20px 48px;background:#fff;border-bottom:1px solid #E3DED3}
.logo{font-weight:700;font-size:22px;color:#0B5D4F}
.acts{display:flex;gap:12px;flex-wrap:wrap}
.nav button{min-height:44px;padding:0 18px;border-radius:8px;border:0;background:#0B5D4F;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}
.wrap{max-width:1120px;margin:0 auto;padding:40px 24px 64px;display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
.intro{flex:1 1 320px}
.intro h1{font-size:40px;line-height:1.1;margin:0 0 16px}
.intro p{font-size:17px;line-height:1.6;color:#3D4C47}
.slot{flex:1 1 460px;min-width:0}
.tag{font:12px ui-monospace,Menlo,monospace;color:#5F6B67}
.note{background:#FFF7E0;border:1px solid #E8D9A8;padding:12px 16px;border-radius:8px;font:14px system-ui,sans-serif}
</style></head><body>
<div class="nav"><span class="logo">Northwind Freight</span><span class="acts"><button type="button" data-ccm-open="new">Message us</button><button type="button" id="contact-btn">Contact us</button></span></div>
<div class="wrap">
<div class="intro">
<h1>Questions about a shipment?</h1>
<p>This is a demo site with the CustomerCatalyst Messenger and support form.</p>
<p><b>Messenger</b> — the round button in the corner, or "Message us" at the top.</p>
<p><b>Support form</b>, placed three ways:</p>
<ol style="font-size:16px;line-height:1.7">
<li><b>Inside a page</b> — the form on the right.</li>
<li><b>From your own button</b> — "Contact us" at the top opens it as a popup.</li>
<li><b>Link only</b> — ${s ? `<a href="/f/${esc(s)}">the hosted page</a>` : 'the hosted page (add <code>&amp;slug=…</code> to the URL)'}.</li>
</ol>
${attr ? '' : '<p class="note">Add <code>?key=pk_…&amp;slug=…</code> to this page\'s URL to load your organization\'s form.</p>'}
</div>
<div class="slot"><div id="cc-support-form"></div></div>
</div>
${attr ? `<script src="/v1/form.js" ${attr} data-target="#cc-support-form" async></script>
<script src="/v1/form.js" ${attr} data-open="#contact-btn" async></script>` : ''}
${k ? `<script src="/v1/messenger.js" data-key="${esc(k)}" async></script>` : ''}
</body></html>`, PAGE_CSP + "; frame-ancestors 'none'");
}

// ── NPS surveys ────────────────────────────────────────────────────────────
// /s/<token>[?score=N] answers, /s/<token>/unsubscribe opts out (per org). The Supabase `surveys`
// function holds the data; the token (survey_recipient.Token) is the only key, so it never goes
// into a function URL or a log line here. Contract: customercatalyst-dev docs/scopes/nps-survey.md §5.
// Limits: everything per IP (RL_SURVEY_IP), and per token (RL_SURVEY_TOKEN).

function callSurveys(env, body) {
  return fetch(env.SURVEYS_FUNCTION_URL, {
    method: 'POST',
    headers: { 'X-CC-Worker-Secret': env.SURVEYS_WORKER_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const surveysConfigured = env => env.SURVEYS_FUNCTION_URL && env.SURVEYS_WORKER_SECRET;
async function surveyLimited(env, request, token) {
  return !(await env.RL_SURVEY_IP.limit({ key: ipOf(request) })).success ||
    !(await env.RL_SURVEY_TOKEN.limit({ key: token })).success;
}
const SURVEY_KEYS = ['org_name', 'logo_url', 'color', 'question', 'comment_question', 'thank_you_title', 'thank_you_body', 'open', 'answered', 'score', 'comment'];

// The page, with the display fields as inert JSON (script-src 'self' never runs it); survey.js
// renders them with textContent. No referrer: the URL carries the token. The logo is only ever our
// own /s/<token>/logo (the file behind it is private), whatever the function sends.
async function surveyPage(request, env, token, mode) {
  let state = 'invalid', survey = null, status = 404;
  if (TOKEN_RE.test(token)) {
    if (!surveysConfigured(env)) { state = 'error'; status = 503; }
    else if (await surveyLimited(env, request, token)) { state = 'error'; status = 429; }
    else {
      const res = await callSurveys(env, { action: 'survey', token });
      const b = await relayJson(res);
      if (res.status === 200 && b && b.success && b.survey) { state = 'ok'; status = 200; survey = pick(b.survey, SURVEY_KEYS); survey.logo_url = survey.logo_url ? '/s/' + token + '/logo' : ''; }
      else if (res.status !== 404) { state = 'error'; status = 502; }
    }
  }
  const data = state === 'ok' ? { state, mode, token, survey } : { state };
  const title = mode === 'unsubscribe' ? 'Unsubscribe' : 'Survey';
  const res = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:#F3F5F4}</style></head>
<body><main id="cc-survey"></main>
<script type="application/json" id="cc-survey-data">${jsLit(data)}</script>
<script src="/v1/survey.js" async></script>
</body></html>`, PAGE_CSP + "; frame-ancestors 'none'", status);
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

// GET /s/<token>/logo: the org logo (a private Bubble file), as bytes the function fetched. Only
// the image types it may answer pass; anything else is a plain 404, so the page shows the monogram.
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
async function surveyLogo(request, env, token) {
  if (!TOKEN_RE.test(token)) return text(404, 'Not found');
  if (!surveysConfigured(env)) return text(503, 'Not configured');
  if (await surveyLimited(env, request, token)) return text(429, 'Too many requests');
  const res = await callSurveys(env, { action: 'logo', token });
  const ct = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (res.status !== 200 || !LOGO_TYPES.includes(ct)) { await res.body?.cancel(); return text(404, 'Not found'); }
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// POST /v1/survey/answer {token, score 0–10, comment?} · /v1/survey/unsubscribe {token}, from our own page only.
async function surveyPost(request, env, url, route) {
  const page = pageOf(request, url);
  if (!page || !page.origin || page.host !== url.host) return json(403, { success: false, error: 'origin_required' });
  if (!surveysConfigured(env)) return json(503, { success: false, error: 'not_configured' });
  const b = await readJson(request);
  if (!b || typeof b.token !== 'string' || !TOKEN_RE.test(b.token)) return json(400, { success: false, error: 'bad_request' });
  let body = { action: 'unsubscribe', token: b.token };
  if (route === 'answer') {
    if (!Number.isInteger(b.score) || b.score < 0 || b.score > 10) return json(400, { success: false, error: 'bad_score' });
    if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 2000)) return json(400, { success: false, error: 'bad_comment' });
    body = { action: 'answer', token: b.token, score: b.score, ...(b.comment !== undefined ? { comment: b.comment } : {}) };
  }
  if (await surveyLimited(env, request, b.token)) return json(429, { success: false, error: 'rate_limited' });
  return relay(await callSurveys(env, body), ['success', 'error', 'org_name'], null);
}

// RFC 8058 one-click unsubscribe: mail providers POST "List-Unsubscribe=One-Click" to the URL in
// the List-Unsubscribe header (no Origin, no page). Same opt-out as the button.
async function oneClickUnsubscribe(request, env, token) {
  const len = Number(request.headers.get('Content-Length'));
  if (!TOKEN_RE.test(token) || !len || len > 1024) return text(400, 'Bad request');
  if ((await request.text()).trim() !== 'List-Unsubscribe=One-Click') return text(400, 'Bad request');
  if (!surveysConfigured(env)) return text(503, 'Not configured');
  if (await surveyLimited(env, request, token)) return text(429, 'Too many requests');
  const res = await callSurveys(env, { action: 'unsubscribe', token });
  await res.body?.cancel();
  return res.ok ? text(200, 'Unsubscribed') : text(res.status === 404 ? 404 : 502, res.status === 404 ? 'Not found' : 'Try again');
}
