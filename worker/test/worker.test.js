// Worker checks: node --test, no dependencies. Bindings (ASSETS, rate limiters),
// caches and fetch are stubbed; the Worker module runs as-is.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const BASE = 'https://customercatalyst-messenger-test.customercatalyst.workers.dev';
const KEY = 'pk_' + 'a'.repeat(48);
const FORM_JS = readFileSync(new URL('../../widgets/form/form.js', import.meta.url), 'utf8');

let upstream, siteverify, limits, cacheStore;
const limiter = name => ({ limit: async ({ key }) => { limits.push([name, key]); return { success: !(limits.block || []).includes(name) }; } });
const envFor = (ENVIRONMENT = 'test', extra = {}) => ({
  ENVIRONMENT, SUPABASE_FUNCTION_URL: 'https://fn.example/functions/v1/messenger', MESSENGER_WORKER_SECRET: 'wsecret',
  TURNSTILE_SECRET: 'tsecret', TURNSTILE_SITEKEY: '0xSITE', HOSTED_HOST: ENVIRONMENT === 'production' ? 'support.customercatalyst.io' : '',
  ASSETS: { fetch: async req => (new URL(req.url).pathname === '/form.js' ? new Response(FORM_JS) : new Response('nope', { status: 404 })) },
  RL_CONFIG_IP: limiter('config_ip'), RL_SUBMIT_IP: limiter('submit_ip'), RL_SUBMIT_KEY: limiter('submit_key'),
  ...extra,
});
const ctx = { waitUntil: p => p };

beforeEach(() => {
  upstream = []; limits = []; cacheStore = new Map();
  siteverify = { success: true, hostname: new URL(BASE).hostname };
  globalThis.caches = { default: {
    match: async req => { const v = cacheStore.get(req.url); return v ? new Response(v) : undefined; },
    put: async (req, res) => { cacheStore.set(req.url, await res.text()); },
  } };
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('https://challenges.cloudflare.com/')) { upstream.push({ siteverify: Object.fromEntries(opts.body) }); return Response.json(siteverify); }
    upstream.push({ url, opts });
    if (opts.body instanceof FormData) return Response.json({ success: true, ticket_id_label: 'SUP-1', name: 'Maria', email: 'm@x.no', bubble_secret: 'leak' });
    return Response.json({ success: true, bubble_org_id: 'leak', config: { enabled: true } });
  };
});

const call = (path, init = {}, env = envFor()) => worker.fetch(new Request(BASE + path, init), env, ctx);

function submitReq(fields = {}, headers = {}) {
  const fd = new FormData();
  const all = { key: KEY, name: 'Maria', email: 'm@x.no', subject: 's', message: 'm', turnstile_token: 'tok', ...fields };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) fd.append(k, v);
  const req = new Request('https://x/', { method: 'POST', body: fd });
  return req.arrayBuffer().then(buf => ({
    method: 'POST', body: buf,
    headers: { Origin: 'https://shop.example', 'Content-Type': req.headers.get('Content-Type'), 'Content-Length': String(buf.byteLength), 'CF-Connecting-IP': '203.0.113.9', ...headers },
  }));
}
const forwarded = () => upstream.filter(u => u.url);

test('GET /v1/form.js serves the widget as JavaScript', async () => {
  const res = await call('/v1/form.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/javascript/);
  assert.equal(await res.text(), FORM_JS);
});

test('other files in the widget folder are not reachable', async () => {
  assert.equal((await call('/test.js')).status, 404);
  assert.equal((await call('/form.js')).status, 404);
});

test('GET /v1/turnstile renders on our host and posts only to the validated origin', async () => {
  const res = await call('/v1/turnstile?origin=' + encodeURIComponent('https://shop.example'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /var PARENT="https:\/\/shop\.example"/);
  assert.match(body, /sitekey:"0xSITE"/);
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
  for (const bad of ['*', 'javascript:alert(1)', 'https://shop.example/path', 'https://a.example"</script>', '']) {
    assert.equal((await call('/v1/turnstile?origin=' + encodeURIComponent(bad))).status, 400, bad);
  }
});

test('Turnstile mode: managed renders visibly, invisible without appearance; config tells form.js', async () => {
  assert.match(await (await call('/v1/turnstile?origin=https%3A%2F%2Fshop.example')).text(), /appearance:'always'/);
  const env = envFor('test', { TURNSTILE_MODE: 'invisible', PRIVACY_URL: 'https://customercatalyst.io/privacy' });
  assert.doesNotMatch(await (await call('/v1/turnstile?origin=https%3A%2F%2Fshop.example', {}, env)).text(), /appearance/);
  const cfg = await (await call('/v1/form/config?key=' + KEY, { headers: { Origin: 'https://shop.example' } }, env)).json();
  assert.equal(cfg.config.turnstile_mode, 'invisible');
  assert.equal(cfg.config.privacy_url, 'https://customercatalyst.io/privacy');
});

test('GET /f/<slug> is the hosted page, never framed, no preview mode', async () => {
  const res = await call('/f/sightl');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /data-slug="sightl"/);
  assert.match(body, /data-mode="hosted"/);
  assert.doesNotMatch(body, /data-preview/);
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const pv = await call('/f/sightl?preview=1');
  assert.doesNotMatch(await pv.text(), /data-preview/, 'no preview branch on the hosted page');
  assert.match(pv.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal((await call('/f/Bad%22slug')).status, 404);
});

test('GET /v1/preview: form.js in preview mode with no key or slug, frameable', async () => {
  const res = await call('/v1/preview');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /data-preview="1"/);
  assert.doesNotMatch(body, /data-(key|slug)=/);
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors \*/);
  const emb = await (await call('/v1/preview')).text();
  assert.doesNotMatch(emb, /data-mode/);
  assert.match(emb, /background:transparent/);
  const pg = await (await call('/v1/preview?layout=page')).text();
  assert.match(pg, /data-mode="hosted" data-preview="1"/);
});

test('production: support host serves /<slug>; /demo is 404', async () => {
  const env = envFor('production');
  const res = await worker.fetch(new Request('https://support.customercatalyst.io/sightl'), env, ctx);
  assert.match(await res.text(), /data-slug="sightl"/);
  assert.equal((await call('/demo', {}, env)).status, 404);
});

test('GET /demo in test shows all three placements and escapes its params', async () => {
  const res = await call(`/demo?key=${KEY}&slug=sightl`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`data-key="${KEY}" data-target="#cc-support-form"`));
  assert.match(body, new RegExp(`data-key="${KEY}" data-open="#contact-btn"`));
  assert.match(body, /href="\/f\/sightl"/);
  const evil = await (await call('/demo?slug=%22%3E%3Cscript%3E')).text();
  assert.doesNotMatch(evil, /"><script>/);
});

test('config: forwards key + origin_host with the secret, strips private fields, caches, echoes Origin', async () => {
  const init = { headers: { Origin: 'https://shop.example', 'CF-Connecting-IP': '203.0.113.9' } };
  const res = await call('/v1/form/config?key=' + KEY, init);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shop.example');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  assert.deepEqual(await res.json(), { success: true, config: { enabled: true, turnstile_mode: 'managed', privacy_url: '' } });
  const [u] = forwarded();
  assert.equal(u.opts.headers['X-CC-Worker-Secret'], 'wsecret');
  assert.deepEqual(JSON.parse(u.opts.body), { action: 'form_config', key: KEY, slug: null, origin_host: 'shop.example', client_ip: '203.0.113.9' });
  const again = await call('/v1/form/config?key=' + KEY, init);
  assert.equal(again.status, 200);
  assert.equal(forwarded().length, 1, 'second call served from cache');
  await call('/v1/form/config?key=' + KEY, { headers: { Origin: 'https://other.example' } });
  assert.equal(forwarded().length, 2, 'cache is per host');
});

test('config: refused upstream answers are passed on, not cached', async () => {
  globalThis.fetch = async (url, opts) => { upstream.push({ url, opts }); return Response.json({ success: false, error: 'origin_not_allowed' }, { status: 403 }); };
  const init = { headers: { Origin: 'https://evil.example' } };
  const res = await call('/v1/form/config?key=' + KEY, init);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin_not_allowed');
  await call('/v1/form/config?key=' + KEY, init);
  assert.equal(forwarded().length, 2);
});

test('config: no browser Origin → 403; same-origin hosted page uses our host; bad id → 400', async () => {
  assert.equal((await call('/v1/form/config?key=' + KEY)).status, 403);
  assert.equal((await call('/v1/form/config?key=' + KEY, { headers: { Origin: 'null' } })).status, 403);
  assert.equal(forwarded().length, 0);
  const res = await call('/v1/form/config?slug=sightl', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(forwarded()[0].opts.body).origin_host, new URL(BASE).hostname);
  assert.equal((await call('/v1/form/config?key=nope', { headers: { Origin: 'https://shop.example' } })).status, 400);
  assert.equal((await call(`/v1/form/config?key=${KEY}&slug=x`, { headers: { Origin: 'https://shop.example' } })).status, 400);
});

test('slug only from our own hosted page: elsewhere it answers like an unknown key', async () => {
  const foreign = await call('/v1/form/config?slug=sightl', { headers: { Origin: 'https://shop.example' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), { success: false, error: 'invalid_api_key' });
  const sub = await call('/v1/form/submit', await submitReq({ key: undefined, slug: 'sightl' }));
  assert.equal(sub.status, 403);
  assert.equal(upstream.length, 0, 'nothing forwarded, Turnstile not even asked');
  const own = await call('/v1/form/config?slug=sightl', { headers: { Origin: BASE } });
  assert.equal(own.status, 200);
  const ownSub = await call('/v1/form/submit', await submitReq({ key: undefined, slug: 'sightl' }, { Origin: BASE }));
  assert.equal(ownSub.status, 200);
  assert.equal(forwarded()[1].opts.body.get('slug'), 'sightl');
  const env = envFor('test', { HOSTED_HOST: 'widget.customercatalyst.io' });
  assert.equal((await call('/v1/form/config?slug=sightl', { headers: { Origin: 'https://widget.customercatalyst.io' } }, env)).status, 200);
});

test('origin_host keeps a non-default port', async () => {
  await call('/v1/form/config?key=' + KEY, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(JSON.parse(forwarded()[0].opts.body).origin_host, 'localhost:3000');
  await call('/v1/form/submit', await submitReq({}, { Origin: 'http://localhost:3000' }));
  assert.deepEqual(forwarded()[1].opts.body.getAll('origin_host'), ['localhost:3000']);
});

test('config: rate limit per IP → 429', async () => {
  limits.block = ['config_ip'];
  const res = await call('/v1/form/config?key=' + KEY, { headers: { Origin: 'https://shop.example' } });
  assert.equal(res.status, 429);
  assert.equal(forwarded().length, 0);
});

test('submit: missing Turnstile token → 400, nothing forwarded', async () => {
  const res = await call('/v1/form/submit', await submitReq({ turnstile_token: undefined }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'turnstile_required');
  assert.equal(upstream.length, 0);
});

test('submit: invalid Turnstile token → 400, nothing forwarded', async () => {
  siteverify = { success: false, 'error-codes': ['invalid-input-response'] };
  const res = await call('/v1/form/submit', await submitReq());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'turnstile_failed');
  assert.equal(forwarded().length, 0);
});

test('submit: Turnstile token from another hostname → 400', async () => {
  siteverify = { success: true, hostname: 'evil.example' };
  assert.equal((await call('/v1/form/submit', await submitReq())).status, 400);
  assert.equal(forwarded().length, 0);
});

test('submit: rate limit per IP and per key → 429, nothing forwarded', async () => {
  for (const name of ['submit_ip', 'submit_key']) {
    limits = []; limits.block = [name]; upstream = [];
    const res = await call('/v1/form/submit', await submitReq());
    assert.equal(res.status, 429, name);
    assert.equal(upstream.length, 0, name);
  }
  assert.deepEqual(limits.find(l => l[0] === 'submit_key'), ['submit_key', KEY]);
});

test('submit: forwards multipart with origin_host + client IP, never the browser\'s copies', async () => {
  const res = await call('/v1/form/submit', await submitReq({ origin_host: 'allowed.example', client_ip: '1.1.1.1', action: 'refresh_config' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, ticket_id_label: 'SUP-1', name: 'Maria', email: 'm@x.no' });
  assert.deepEqual(upstream[0].siteverify, { secret: 'tsecret', response: 'tok', remoteip: '203.0.113.9' });
  const [u] = forwarded();
  const fd = u.opts.body;
  assert.equal(u.url, 'https://fn.example/functions/v1/messenger');
  assert.equal(u.opts.headers['X-CC-Worker-Secret'], 'wsecret');
  assert.deepEqual(fd.getAll('origin_host'), ['shop.example']);
  assert.deepEqual(fd.getAll('client_ip'), ['203.0.113.9']);
  assert.deepEqual(fd.getAll('action'), ['form_submit']);
  assert.equal(fd.get('turnstile_token'), null);
  assert.equal(fd.get('key'), KEY);
  assert.equal(fd.get('name'), 'Maria');
});

test('submit: body cap, length and Origin required', async () => {
  const big = await submitReq();
  big.headers['Content-Length'] = String(26 * 1024 * 1024 + 1);
  assert.equal((await call('/v1/form/submit', big)).status, 413);
  const noOrigin = await submitReq();
  delete noOrigin.headers.Origin;
  assert.equal((await call('/v1/form/submit', noOrigin)).status, 403);
  assert.equal(upstream.length, 0);
});

test('unknown paths 404', async () => {
  assert.equal((await call('/')).status, 404);
  assert.equal((await call('/v1/nope')).status, 404);
});
