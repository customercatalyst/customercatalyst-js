// Worker checks: node --test, no dependencies. Bindings (ASSETS, rate limiters),
// caches and fetch are stubbed; the Worker module runs as-is.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { bundle } from '../src/index.js';

const BASE = 'https://customercatalyst-messenger-test.customercatalyst.workers.dev';
const KEY = 'pk_' + 'a'.repeat(48);
const TOKEN = 'T'.repeat(43), TOKEN2 = 'U'.repeat(43);
const widget = f => readFileSync(new URL('../../widgets/' + f, import.meta.url), 'utf8');
const KIT = widget('shared/kit.js');
const PARENTS = 'https://app.customercatalyst.io https://customer-catalyst-15453.bubbleapps.io';

let upstream, siteverify, limits, cacheStore;
const limiter = name => ({ limit: async ({ key }) => { limits.push([name, key]); return { success: !(limits.block || []).includes(name) }; } });
const envFor = (ENVIRONMENT = 'test', extra = {}) => ({
  ENVIRONMENT, SUPABASE_FUNCTION_URL: 'https://fn.example/functions/v1/messenger', MESSENGER_WORKER_SECRET: 'wsecret',
  TURNSTILE_SECRET: 'tsecret', TURNSTILE_SITEKEY: '0xSITE', HOSTED_HOST: ENVIRONMENT === 'production' ? 'support.customercatalyst.io' : '',
  // The assets folder is ../widgets; serve any file in it, as the binding does.
  ASSETS: { fetch: async req => { try { return new Response(widget(new URL(req.url).pathname.slice(1))); } catch { return new Response('nope', { status: 404 }); } } },
  PREVIEW_PARENT_ORIGINS: PARENTS + ' http://insecure.example *',
  RL_CONFIG_IP: limiter('config_ip'), RL_SUBMIT_IP: limiter('submit_ip'), RL_SUBMIT_KEY: limiter('submit_key'),
  RL_READ_IP: limiter('read_ip'), RL_REPLY_IP: limiter('reply_ip'),
  RL_LIST_IP: limiter('list_ip'), RL_READ_KEY: limiter('read_key'), RL_REPLY_KEY: limiter('reply_key'),
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
    if (opts.body instanceof FormData) {
      if (opts.body.get('action') === 'messenger_reply') return Response.json({ success: true, id: 'msg1', at: 't', ticket_id_label: 'SUP-2', files_failed: 1, conversation_token: TOKEN2, ticket_id: 'leak' });
      return Response.json({ success: true, ticket_id_label: 'SUP-1', name: 'Maria', email: 'm@x.no', confirmation: false, bubble_secret: 'leak' });
    }
    const action = JSON.parse(opts.body).action;
    // The function answers the last token it was sent (its index in what it got).
    if (action === 'messenger_conversations') return Response.json({ success: true, org: 'leak', conversations: [{ index: JSON.parse(opts.body).tokens.length - 1, label: 'SUP-1', subject: 's', status: 'open', last_at: 't', last_from: 'team', last_kind: 'message', last_preview: 'p', last_team_at: 't', last_author: 'Can', last_initials: 'CD', ticket_id: 'leak' }] });
    if (action === 'messenger_thread') return Response.json({ success: true, ticket: { label: 'SUP-1', subject: 's', status: 'open', id: 'leak' },
      messages: [{ id: 'm1', from: 'team', author: 'Can', initials: 'CD', text: 'hi', at: 't', kind: 'message', email: 'can@org.example', files: [{ id: 'f1', name: 'a.pdf', size: 3, url: 'leak' }] }] });
    if (action === 'messenger_file') return new Response('%PDF-1', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''a%20b.pdf" } });
    return Response.json({ success: true, bubble_org_id: 'leak', config: action === 'messenger_config' ? { enabled: true, messenger: { position: 'left' } } : { enabled: true } });
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

test('GET /v1/form.js and /v1/messenger.js serve each widget bundled with the shared kit', async () => {
  for (const [path, file] of [['/v1/form.js', 'form/form.js'], ['/v1/messenger.js', 'messenger/messenger.js']]) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('Content-Type'), /^text\/javascript/);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    const body = await res.text();
    assert.equal(body, bundle(KIT, widget(file)));
    assert.doesNotThrow(() => new Function(body), path + ' parses');
  }
});

test('other files in the widgets folder are not reachable', async () => {
  for (const p of ['/test.js', '/form.js', '/form/form.js', '/form/test.js', '/messenger/messenger.js', '/messenger/test.js', '/shared/kit.js', '/messenger.js']) {
    assert.equal((await call(p)).status, 404, p);
  }
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

test('GET /v1/preview: form.js in preview mode with no key or slug, framable only by the settings pages', async () => {
  const res = await call('/v1/preview');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /data-preview="1"/);
  assert.doesNotMatch(body, /data-(key|slug)=/);
  assert.match(res.headers.get('Content-Security-Policy'), new RegExp(`frame-ancestors ${PARENTS}$`));
  assert.match(body, new RegExp(`data-parents="${PARENTS}"`), 'only valid https origins passed to the page');
  const none = await call('/v1/preview', {}, envFor('test', { PREVIEW_PARENT_ORIGINS: '' }));
  assert.match(none.headers.get('Content-Security-Policy'), /frame-ancestors 'none'$/);
  const emb = await (await call('/v1/preview')).text();
  assert.doesNotMatch(emb, /data-mode/);
  assert.match(emb, /background:transparent/);
  const pg = await (await call('/v1/preview?layout=page')).text();
  assert.match(pg, /data-mode="hosted" data-preview="1"/);
});

test('GET /v1/messenger/preview: messenger.js in preview mode, no key, never fetches, framable only by the settings pages', async () => {
  const res = await call('/v1/messenger/preview');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<script src="\/v1\/messenger\.js" data-preview="1" data-parents="https:\/\/app\.customercatalyst\.io https:\/\/customer-catalyst-15453\.bubbleapps\.io"/);
  assert.doesNotMatch(body, /data-key=/);
  assert.match(res.headers.get('Content-Security-Policy'), new RegExp(`frame-ancestors ${PARENTS}$`));
  assert.equal(upstream.length, 0, 'nothing fetched');
});

test('messenger config: key only, action messenger_config, cached apart from the form config', async () => {
  const init = { headers: { Origin: 'https://shop.example', 'CF-Connecting-IP': '203.0.113.9' } };
  const res = await call('/v1/messenger/config?key=' + KEY, init);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shop.example');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  assert.deepEqual(await res.json(), { success: true, config: { enabled: true, messenger: { position: 'left' }, turnstile_mode: 'managed', privacy_url: '' } });
  assert.deepEqual(JSON.parse(forwarded()[0].opts.body), { action: 'messenger_config', key: KEY, origin_host: 'shop.example', client_ip: '203.0.113.9' });
  assert.equal(forwarded()[0].opts.headers['X-CC-Worker-Secret'], 'wsecret');
  await call('/v1/messenger/config?key=' + KEY, init);
  assert.equal(forwarded().length, 1, 'second call served from cache');
  await call('/v1/form/config?key=' + KEY, init);
  assert.equal(forwarded().length, 2, 'form config is its own cache entry');
  assert.equal(JSON.parse(forwarded()[1].opts.body).action, 'form_config');
  assert.equal((await call('/v1/messenger/config?slug=sightl', { headers: { Origin: BASE } })).status, 400, 'no slug for Messenger');
  assert.equal((await call('/v1/messenger/config?key=' + KEY)).status, 403, 'no Origin');
  const pre = await call('/v1/messenger/config', { method: 'OPTIONS', headers: { Origin: 'https://shop.example' } });
  assert.equal(pre.status, 204);
});

test('messenger config: refused answers passed on, not cached; rate limit per IP → 429', async () => {
  globalThis.fetch = async (url, opts) => { upstream.push({ url, opts }); return Response.json({ success: false, error: 'origin_not_allowed' }, { status: 403 }); };
  const init = { headers: { Origin: 'https://evil.example' } };
  assert.equal((await call('/v1/messenger/config?key=' + KEY, init)).status, 403);
  await call('/v1/messenger/config?key=' + KEY, init);
  assert.equal(forwarded().length, 2);
  limits.block = ['config_ip'];
  assert.equal((await call('/v1/messenger/config?key=' + KEY, { headers: { Origin: 'https://shop.example' } })).status, 429);
  assert.equal(forwarded().length, 2);
});

test('messenger submit: Turnstile missing → 400, rate limits → 429, nothing forwarded', async () => {
  const res = await call('/v1/messenger/submit', await submitReq({ turnstile_token: undefined }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'turnstile_required');
  siteverify = { success: true, hostname: 'evil.example' };
  assert.equal((await call('/v1/messenger/submit', await submitReq())).status, 400);
  assert.equal(forwarded().length, 0);
  siteverify = { success: true, hostname: new URL(BASE).hostname };
  for (const name of ['submit_ip', 'submit_key']) {
    limits = []; limits.block = [name]; upstream = [];
    assert.equal((await call('/v1/messenger/submit', await submitReq())).status, 429, name);
    assert.equal(upstream.length, 0, name);
  }
  limits = [];
  assert.equal((await call('/v1/messenger/submit', await submitReq({ key: undefined, slug: 'sightl' }, { Origin: BASE }))).status, 400, 'no slug');
  const big = await submitReq();
  big.headers['Content-Length'] = String(26 * 1024 * 1024 + 1);
  assert.equal((await call('/v1/messenger/submit', big)).status, 413);
});

test('messenger submit: forwards multipart as messenger_submit with origin_host + client IP, never the browser\'s copies', async () => {
  const res = await call('/v1/messenger/submit', await submitReq({ origin_host: 'allowed.example', client_ip: '1.1.1.1', action: 'form_submit' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, ticket_id_label: 'SUP-1', name: 'Maria', email: 'm@x.no', confirmation: false });
  const fd = forwarded()[0].opts.body;
  assert.deepEqual(fd.getAll('action'), ['messenger_submit']);
  assert.deepEqual(fd.getAll('origin_host'), ['shop.example']);
  assert.deepEqual(fd.getAll('client_ip'), ['203.0.113.9']);
  assert.equal(fd.get('turnstile_token'), null);
  assert.equal(forwarded()[0].opts.headers['X-CC-Worker-Secret'], 'wsecret');
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
  assert.match(body, new RegExp(`<script src="/v1/messenger.js" data-key="${KEY}" async>`));
  assert.match(body, /<button type="button" data-ccm-open="new">/);
  assert.doesNotMatch(await (await call('/demo?slug=sightl')).text(), /messenger\.js/, 'Messenger needs a key');
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
  assert.deepEqual(await res.json(), { success: true, ticket_id_label: 'SUP-1', name: 'Maria', email: 'm@x.no', confirmation: false });
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

// ── conversations (phase 2) ─────────────────────────────────────────────────
const jsonReq = (body, headers = {}) => {
  const raw = JSON.stringify(body);
  return { method: 'POST', body: raw, headers: { Origin: 'https://shop.example', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(raw)), 'CF-Connecting-IP': '203.0.113.9', ...headers } };
};
async function replyReq(fields = {}, headers = {}) {
  const r = await submitReq({ turnstile_token: undefined, name: undefined, email: undefined, subject: undefined, token: TOKEN, ...fields }, headers);
  return r;
}

test('conversations: forwards key + tokens + origin_host + IP, allow-lists each item', async () => {
  const res = await call('/v1/messenger/conversations', jsonReq({ key: KEY, tokens: [TOKEN, TOKEN2], origin_host: 'evil.example', action: 'x' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shop.example');
  assert.deepEqual(await res.json(), { success: true, conversations: [{ index: 1, label: 'SUP-1', subject: 's', status: 'open', last_at: 't', last_from: 'team', last_kind: 'message', last_preview: 'p', last_team_at: 't', last_author: 'Can', last_initials: 'CD' }] });
  const [u] = forwarded();
  assert.deepEqual(JSON.parse(u.opts.body), { action: 'messenger_conversations', key: KEY, origin_host: 'shop.example', client_ip: '203.0.113.9', tokens: [TOKEN, TOKEN2] });
  assert.equal(u.opts.headers['X-CC-Worker-Secret'], 'wsecret');
  assert.ok(!u.url.includes(TOKEN), 'token never in the URL');
  assert.equal((await call('/v1/messenger/conversations', { method: 'OPTIONS', headers: { Origin: 'https://shop.example' } })).status, 204);
  assert.deepEqual(limits, [['list_ip', '203.0.113.9'], ['read_key', KEY]]);
});

test('conversations: malformed tokens dropped (not a 400), answers keep the browser\'s indexes', async () => {
  const res = await call('/v1/messenger/conversations', jsonReq({ key: KEY, tokens: ['short', 42, TOKEN, 'x'.repeat(200), TOKEN2] }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(forwarded()[0].opts.body).tokens, [TOKEN, TOKEN2]);
  assert.equal((await res.json()).conversations[0].index, 4, 'index 1 of what was forwarded = index 4 of what the browser sent');
  for (const tokens of [[], ['short']]) {
    const none = await call('/v1/messenger/conversations', jsonReq({ key: KEY, tokens }));
    assert.deepEqual([none.status, await none.json()], [200, { success: true, conversations: [] }]);
  }
  assert.equal(forwarded().length, 1, 'nothing valid → not forwarded');
});

test('conversations: bad input → 400, no Origin → 403, rate limit → 429; nothing forwarded', async () => {
  for (const body of [{ key: KEY, tokens: Array(21).fill(TOKEN) }, { key: 'nope', tokens: [TOKEN] }, { key: KEY, tokens: TOKEN }]) {
    assert.equal((await call('/v1/messenger/conversations', jsonReq(body))).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const notJson = jsonReq({}); notJson.body = 'x{'; notJson.headers['Content-Length'] = '2';
  assert.equal((await call('/v1/messenger/conversations', notJson)).status, 400);
  const big = jsonReq({ key: KEY, tokens: [TOKEN] }); big.headers['Content-Length'] = String(16 * 1024 + 1);
  assert.equal((await call('/v1/messenger/conversations', big)).status, 400);
  const noOrigin = jsonReq({ key: KEY, tokens: [TOKEN] }); delete noOrigin.headers.Origin;
  assert.equal((await call('/v1/messenger/conversations', noOrigin)).status, 403);
  limits.block = ['read_ip'];
  for (const r of ['thread', 'file']) {
    assert.equal((await call('/v1/messenger/' + r, jsonReq({ key: KEY, token: TOKEN, file_id: 'f1' }))).status, 429, r);
  }
  assert.deepEqual(limits.at(-1), ['read_ip', '203.0.113.9']);
  limits.block = ['list_ip'];
  assert.equal((await call('/v1/messenger/conversations', jsonReq({ key: KEY, tokens: [TOKEN] }))).status, 429, 'list per IP');
  assert.deepEqual(limits.at(-1), ['list_ip', '203.0.113.9']);
  limits.block = ['read_key'];
  for (const r of ['conversations', 'thread', 'file']) {
    assert.equal((await call('/v1/messenger/' + r, jsonReq({ key: KEY, tokens: [TOKEN], token: TOKEN, file_id: 'f1' }))).status, 429, r + ' per key');
  }
  assert.deepEqual(limits.at(-1), ['read_key', KEY]);
  assert.equal(forwarded().length, 0);
});

test('thread: token in the POST body only, seen passed as a boolean, nested fields allow-listed', async () => {
  const res = await call('/v1/messenger/thread', jsonReq({ key: KEY, token: TOKEN, seen: 'yes' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, ticket: { label: 'SUP-1', subject: 's', status: 'open' },
    messages: [{ id: 'm1', from: 'team', author: 'Can', initials: 'CD', text: 'hi', at: 't', kind: 'message', files: [{ id: 'f1', name: 'a.pdf', size: 3 }] }] });
  assert.deepEqual(JSON.parse(forwarded()[0].opts.body), { action: 'messenger_thread', key: KEY, origin_host: 'shop.example', client_ip: '203.0.113.9', token: TOKEN, seen: false });
  await call('/v1/messenger/thread', jsonReq({ key: KEY, token: TOKEN, seen: true }));
  assert.equal(JSON.parse(forwarded()[1].opts.body).seen, true);
  assert.equal((await call('/v1/messenger/thread', jsonReq({ key: KEY }))).status, 400, 'no token');
  assert.equal((await call('/v1/messenger/thread?token=' + TOKEN)).status, 404, 'GET with a token in the URL is not a route');
  assert.equal(forwarded().length, 2);
});

test('thread: refused upstream answers passed on with their status', async () => {
  globalThis.fetch = async (url, opts) => { upstream.push({ url, opts }); return Response.json({ success: false, error: 'not_found', ticket_id: 'leak' }, { status: 404 }); };
  const res = await call('/v1/messenger/thread', jsonReq({ key: KEY, token: TOKEN }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'not_found' });
});

test('file: bytes passed through as an attachment, safe type, nosniff; JSON errors relayed', async () => {
  const res = await call('/v1/messenger/file', jsonReq({ key: KEY, token: TOKEN, file_id: 'f1' }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '%PDF-1');
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.equal(res.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''a%20b.pdf", 'the function\'s attachment disposition kept');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://shop.example');
  assert.deepEqual(JSON.parse(forwarded()[0].opts.body), { action: 'messenger_file', key: KEY, origin_host: 'shop.example', client_ip: '203.0.113.9', token: TOKEN, file_id: 'f1' });
  globalThis.fetch = async () => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } });
  const html = await call('/v1/messenger/file', jsonReq({ key: KEY, token: TOKEN, file_id: 'f1' }));
  assert.equal(html.headers.get('Content-Type'), 'application/octet-stream', 'unsafe type forced to a download');
  assert.equal(html.headers.get('Content-Disposition'), 'attachment', 'no/inline disposition → attachment');
  assert.match(html.headers.get('Content-Security-Policy'), /sandbox/);
  globalThis.fetch = async () => Response.json({ success: false, error: 'not_found', path: 'leak' }, { status: 404 });
  const no = await call('/v1/messenger/file', jsonReq({ key: KEY, token: TOKEN, file_id: 'f2' }));
  assert.equal(no.status, 404);
  assert.deepEqual(await no.json(), { success: false, error: 'not_found' });
  assert.equal((await call('/v1/messenger/file', jsonReq({ key: KEY, token: TOKEN }))).status, 400, 'no file id');
});

test('reply: multipart relayed as messenger_reply with origin_host + IP, browser copies dropped; follow-up label + files_failed passed on', async () => {
  const res = await call('/v1/messenger/reply', await replyReq({ action: 'messenger_submit', origin_host: 'evil.example', client_ip: '1.1.1.1' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, id: 'msg1', at: 't', ticket_id_label: 'SUP-2', files_failed: 1 });
  const fd = forwarded()[0].opts.body;
  assert.deepEqual(fd.getAll('action'), ['messenger_reply']);
  assert.deepEqual(fd.getAll('origin_host'), ['shop.example']);
  assert.deepEqual(fd.getAll('client_ip'), ['203.0.113.9']);
  assert.equal(fd.get('token'), TOKEN);
  assert.equal(fd.get('message'), 'm');
  assert.equal(upstream.filter(u => u.siteverify).length, 0, 'no Turnstile: the token is the proof');
});

test('reply: no token → 400, too big → 413, rate limit → 429, no Origin → 403; nothing forwarded', async () => {
  const noTok = await call('/v1/messenger/reply', await replyReq({ token: undefined }));
  assert.equal(noTok.status, 400);
  assert.equal((await noTok.json()).error, 'bad_request');
  assert.equal((await call('/v1/messenger/reply', await replyReq({ key: undefined }))).status, 400);
  const big = await replyReq(); big.headers['Content-Length'] = String(26 * 1024 * 1024 + 1);
  assert.equal((await call('/v1/messenger/reply', big)).status, 413);
  const noOrigin = await replyReq(); delete noOrigin.headers.Origin;
  assert.equal((await call('/v1/messenger/reply', noOrigin)).status, 403);
  limits.block = ['reply_ip'];
  assert.equal((await call('/v1/messenger/reply', await replyReq())).status, 429);
  limits.block = ['reply_key'];
  assert.equal((await call('/v1/messenger/reply', await replyReq())).status, 429);
  assert.deepEqual(limits.at(-1), ['reply_key', KEY]);
  assert.equal(forwarded().length, 0);
});

test('submit relays the conversation token; tokens never reach the log', async () => {
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('https://challenges')) return Response.json({ success: true, hostname: new URL(BASE).hostname });
    upstream.push({ url, opts });
    if (opts.body instanceof FormData) return Response.json({ success: true, ticket_id_label: 'SUP-3', conversation_token: TOKEN, files_failed: 2 });
    throw new Error('upstream down');
  };
  const res = await call('/v1/messenger/submit', await submitReq());
  const sb = await res.json();
  assert.deepEqual([sb.conversation_token, sb.files_failed], [TOKEN, 2]);
  const logged = [];
  const saved = ['log', 'error', 'warn', 'info'].map(k => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => logged.push(a.map(x => String(x && x.stack || x)).join(' '));
  try {
    assert.equal((await call('/v1/messenger/thread', jsonReq({ key: KEY, token: TOKEN }))).status, 500);
    assert.equal((await call('/v1/messenger/conversations', jsonReq({ key: KEY, tokens: [TOKEN] }))).status, 500);
  } finally { for (const [k, f] of saved) console[k] = f; }
  assert.ok(logged.length > 0 && !logged.some(l => l.includes(TOKEN)), 'logged, without the token');
});

test('unknown paths 404', async () => {
  assert.equal((await call('/')).status, 404);
  assert.equal((await call('/v1/nope')).status, 404);
});
