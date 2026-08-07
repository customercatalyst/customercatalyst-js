// Regression checks for the queue, batching and error handling.
// No dependencies, no build, no network: run with `node test.js`.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'customercatalyst.js'), 'utf8');

let pass = 0, fail = 0;
const log = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  log.push((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};
const threw = fn => { try { fn(); return false; } catch (e) { return e.message; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okResp = n => ({ ok: true, text: async () => '', json: async () => ({ success: true, received: n, accepted: n, inserted: n, duplicates: 0, rejected: 0 }) });
const errResp = s => ({ ok: false, status: s, text: async () => 'error ' + s, json: async () => null });

// Each load gets a fresh copy of the module, so queue state never leaks between checks.
function load(fetchImpl, beaconImpl) {
  const listeners = {};
  const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
  const w = { addEventListener: on, crypto: require('crypto').webcrypto };
  const d = { addEventListener: on, visibilityState: 'visible' };
  const nav = beaconImpl === 'none' ? {} : { sendBeacon: beaconImpl || (() => true) };
  global.fetch = fetchImpl || (async () => okResp(1));
  new Function('window', 'document', 'navigator', SRC)(w, d, nav);
  return {
    CC: w.CustomerCatalyst,
    hide: () => { d.visibilityState = 'hidden'; (listeners['visibilitychange'] || []).forEach(f => f()); }
  };
}

(async () => {
  const realWarn = console.warn, realError = console.error;
  console.warn = console.error = () => {};

  // --- input validation -----------------------------------------------------
  {
    const { CC } = load();
    check('rejects a missing API key', !!threw(() => new CC()));
    const cc = new CC('org_test');
    check('rejects identify without a customerId', !!threw(() => cc.identify({})));
    check('rejects an over-long customerId', !!threw(() => cc.identify({ customerId: 'x'.repeat(256) })));
    check('rejects track before identify', !!threw(() => cc.track('x')));
    cc.identify({ customerId: 'c1' });
    check('rejects a missing eventType', !!threw(() => cc.track()));
    check('rejects an empty eventType', !!threw(() => cc.track('  ')));
    check('rejects an over-long eventType', !!threw(() => cc.track('e'.repeat(256))));
  }

  // --- value and metadata coercion -----------------------------------------
  {
    const sent = [];
    const { CC } = load(async (u, o) => { JSON.parse(o.body).p_events.forEach(e => sent.push(e)); return okResp(1); });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    cc.track('a');                        // no value
    cc.track('b', 0.1 + 0.2);             // float noise
    cc.track('c', -5);                    // negative
    cc.track('d', NaN);
    cc.track('e', Infinity);
    cc.track('f', 1, [1, 2]);             // array metadata
    const circular = {}; circular.self = circular;
    cc.track('g', 1, circular);
    cc.track('h', 1, { keep: true });
    await sleep(1500);
    const by = t => sent.find(e => e.event_type === t) || {};
    check('missing value defaults to 1', by('a').value === 1);
    check('float noise is rounded, not discarded', by('b').value === 0.3, String(by('b').value));
    check('negative value becomes 1', by('c').value === 1);
    check('NaN becomes 1', by('d').value === 1);
    check('Infinity becomes 1', by('e').value === 1);
    check('array metadata is dropped', by('f').metadata === null);
    check('unserialisable metadata is dropped', by('g').metadata === null);
    check('plain object metadata is kept', by('h').metadata && by('h').metadata.keep === true);
    check('every event gets a unique id', new Set(sent.map(e => e.event_id)).size === sent.length);
  }

  // --- batching by size, not just count ------------------------------------
  {
    let maxBytes = 0, delivered = 0;
    const { CC } = load(async (u, o) => {
      maxBytes = Math.max(maxBytes, o.body.length);
      const n = JSON.parse(o.body).p_events.length; delivered += n; return okResp(n);
    });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    const pad = 'y'.repeat(700);
    for (let i = 0; i < 60; i++) cc.track('fat', 1, { pad, i });
    await sleep(3000);
    check('a batch never exceeds the server byte limit', maxBytes <= 32768, maxBytes + ' bytes');
    check('no event is lost when splitting by size', delivered === 60, delivered + '/60');
  }

  // --- error classification -------------------------------------------------
  for (const [status, fatal] of [[400, true], [401, true], [403, true], [408, false], [429, false], [500, false]]) {
    const { CC } = load(async () => errResp(status));
    const cc = new CC('key' + status); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(500);
    check(status + ' is ' + (fatal ? 'fatal' : 'retried'), cc.isStopped === fatal);
  }

  // --- one key's outage must not affect another ----------------------------
  {
    let healthy = 0;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'failing') throw new TypeError('Failed to fetch');
      if (b.p_api_key === 'healthy') healthy += b.p_events.length;
      return okResp(b.p_events.length);
    });
    const bad = new CC('failing'); bad.identify({ customerId: 'c1' });
    const good = new CC('healthy'); good.identify({ customerId: 'c2' });
    bad.track('stuck', 1);
    for (let i = 0; i < 40; i++) good.track('fine', 1, { i });
    await sleep(3000);
    check('a failing key does not starve a healthy one', healthy === 40, healthy + '/40');
  }
  {
    let healthy = 0;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'bad') return errResp(400);
      // Count only this check's key: an earlier check leaves retry timers
      // running that still reach whatever global fetch is current.
      if (b.p_api_key === 'good') healthy += b.p_events.length;
      return okResp(b.p_events.length);
    });
    const good = new CC('good'); good.identify({ customerId: 'c1' });
    const bad = new CC('bad'); bad.identify({ customerId: 'c2' });
    for (let i = 0; i < 20; i++) good.track('fine', 1, { i });
    bad.track('doomed', 1);
    for (let i = 20; i < 30; i++) good.track('fine', 1, { i });
    await sleep(2500);
    check('a fatal error stops only its own key', bad.isStopped && !good.isStopped);
    check('the other key keeps draining after a fatal error', healthy === 30, healthy + '/30');
  }

  // --- flush ----------------------------------------------------------------
  {
    let release; const gate = new Promise(r => { release = r; });
    let landed = false, early = false;
    const { CC } = load(async () => { await gate; landed = true; return okResp(1); });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    for (let i = 0; i < 6; i++) cc.track('x', 1, { i });
    await sleep(150);
    const p = cc.flush().then(() => { if (!landed) early = true; });
    await sleep(250); release(); await p;
    check('flush waits for a request already on the wire', !early);
  }
  {
    const { CC } = load(async () => new Promise(() => {}));
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' }); cc.track('x', 1);
    const started = Date.now(); await cc.flush();
    check('flush gives up rather than hanging a navigation', Date.now() - started < 7000, (Date.now() - started) + 'ms');
  }

  // --- page hide ------------------------------------------------------------
  {
    let beaconed = 0;
    const { CC, hide } = load(async () => new Promise(() => {}), (u, body) => {
      beaconed += JSON.parse(new URLSearchParams(body.toString()).get('p_events')).length; return true;
    });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    for (let i = 0; i < 20; i++) cc.track('x', 1, { i });
    hide();
    check('hiding the page sends the queue and the in-flight batch', beaconed === 20, beaconed + '/20');
  }
  {
    const offered = []; let refusals = 0, delivered = 0;
    const { CC, hide } = load(async () => new Promise(() => {}), (u, body) => {
      const n = JSON.parse(new URLSearchParams(body.toString()).get('p_events')).length;
      offered.push(n);
      if (refusals++ < 2) return false;
      delivered += n; return true;
    });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    for (let i = 0; i < 80; i++) cc.track('x', 1, { i });
    hide();
    check('a refused beacon is halved and retried', offered[0] > offered[2], offered.slice(0, 3).join(' > '));
    check('nothing is abandoned when a beacon is refused', delivered === 80, delivered + '/80');
  }
  {
    let crashed = false;
    try {
      const { CC, hide } = load(async () => new Promise(() => {}), 'none');
      const cc = new CC('org_test'); cc.identify({ customerId: 'c1' }); cc.track('x', 1);
      hide();
    } catch (e) { crashed = true; }
    check('a browser without sendBeacon does not crash', !crashed);
  }

  console.warn = realWarn; console.error = realError;
  console.log(log.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
