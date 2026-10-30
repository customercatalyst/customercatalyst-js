// CustomerCatalyst Messenger Worker: serves the support form widget and sits
// between visitors' browsers and the Supabase `messenger` function. The function
// does the real checks (key, allowed sites, form on, validation); this Worker adds
// what only the edge can do: Turnstile, rate limits, a body cap and a config cache.
// The function secret and Turnstile secret never leave here.
// Shapes: worker/README.md. Contract: customercatalyst-dev docs/scopes/messenger.md.

const KEY_RE = /^pk_[A-Za-z0-9]{16,64}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
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
      if (method === 'OPTIONS' && (path === '/v1/form/config' || path === '/v1/form/submit')) return preflight(request);
      if (method === 'POST' && path === '/v1/form/submit') return await submit(request, env, url);
      if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed');
      if (path === '/v1/form.js') return await formJs(env, url);
      if (path === '/v1/form/config') return await config(request, env, ctx, url);
      if (path === '/v1/turnstile') return turnstilePage(env, url);
      if (path === '/v1/preview') return previewPage(url);
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

// Exactly one of key / slug, well-formed.
function idOf(get) {
  const key = get('key'), slug = get('slug');
  if (key && !slug && typeof key === 'string' && KEY_RE.test(key)) return { key };
  if (slug && !key && typeof slug === 'string' && SLUG_RE.test(slug)) return { slug };
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

async function formJs(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/form.js', url)));
  if (!res.ok) return text(404, 'Not found');
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

async function config(request, env, ctx, url) {
  const page = pageOf(request, url);
  if (!page) return json(403, { success: false, error: 'origin_required' });
  const id = idOf(n => url.searchParams.get(n));
  if (!id) return json(400, { success: false, error: 'bad_request' }, page.origin);
  if (id.slug && !slugAllowed(page, url, env)) return json(403, UNKNOWN, page.origin);
  if (!configured(env)) return json(503, { success: false, error: 'not_configured' }, page.origin);

  // Cached per key (or slug) + page host: the allow-list answer depends on both.
  const cacheKey = new Request(`https://${url.hostname}/__config?${id.key ? 'key=' + id.key : 'slug=' + id.slug}&host=${encodeURIComponent(page.host)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(page.origin) } });

  if (!(await env.RL_CONFIG_IP.limit({ key: ipOf(request) })).success) return json(429, { success: false, error: 'rate_limited' }, page.origin);

  const res = await callFunction(env, { action: 'form_config', key: id.key || null, slug: id.slug || null, origin_host: page.host, client_ip: ipOf(request) }, true);
  const out = await relay(res, ['success', 'error', 'config'], page.origin, { turnstile_mode: modeOf(env), privacy_url: env.PRIVACY_URL || '' });
  if (res.ok && out.status === 200) {
    const body = await out.clone().text();
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CONFIG_TTL}` } })));
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

async function submit(request, env, url) {
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
  const id = idOf(n => form.get(n));
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
  form.append('action', 'form_submit');
  form.append('origin_host', page.host);
  form.append('client_ip', ip);
  const res = await callFunction(env, form, false);
  return relay(res, ['success', 'error', 'errors', 'ticket_id_label', 'name', 'email'], o);
}

// ── pages ──────────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: escape '<' so a value can never close the tag.
const jsLit = v => JSON.stringify(v).replace(/</g, '\\u003c');

function html(body, csp) {
  return new Response(body, {
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

// Settings preview before anything is saved: form.js with defaults, filled in by the
// settings page over postMessage. It cannot send, so any site may frame it.
function previewPage(url) {
  // layout=embedded (default): the card alone on a transparent page, as it sits in a customer's
  // page. layout=page: the hosted page.
  const page = url.searchParams.get('layout') === 'page';
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Preview</title>
<style>body{margin:0;${page ? 'background:#F3F5F4' : 'background:transparent;padding:16px'};font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#13231F}</style></head>
<body><main id="cc-form"></main>
<script src="/v1/form.js" data-target="#cc-form"${page ? ' data-mode="hosted"' : ''} data-preview="1" async></script>
</body></html>`, PAGE_CSP + '; frame-ancestors *');
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
.nav button{min-height:44px;padding:0 18px;border-radius:8px;border:0;background:#0B5D4F;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}
.wrap{max-width:1120px;margin:0 auto;padding:40px 24px 64px;display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
.intro{flex:1 1 320px}
.intro h1{font-size:40px;line-height:1.1;margin:0 0 16px}
.intro p{font-size:17px;line-height:1.6;color:#3D4C47}
.slot{flex:1 1 460px;min-width:0}
.tag{font:12px ui-monospace,Menlo,monospace;color:#5F6B67}
.note{background:#FFF7E0;border:1px solid #E8D9A8;padding:12px 16px;border-radius:8px;font:14px system-ui,sans-serif}
</style></head><body>
<div class="nav"><span class="logo">Northwind Freight</span><button type="button" id="contact-btn">Contact us</button></div>
<div class="wrap">
<div class="intro">
<h1>Questions about a shipment?</h1>
<p>This is a demo site that shows the three ways to place the CustomerCatalyst support form:</p>
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
</body></html>`, PAGE_CSP + "; frame-ancestors 'none'");
}
