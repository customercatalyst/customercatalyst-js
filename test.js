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

// Some checks need a shorter backoff or a lower attempt ceiling — proving that
// retries terminate takes 81 seconds at the shipped values. The shipped file has
// no override hook on purpose: anything reachable from the page (a mutable
// LIMITS on the global, or a free identifier that falls through the scope chain
// to window) lets a co-located script raise the caps for every organisation.
// So rewrite the literals in the source text instead. Asserted, so renaming a
// limit fails loudly here rather than silently testing production numbers.
function withLimits(src, overrides) {
  Object.keys(overrides).forEach(k => {
    const re = new RegExp('(' + k + ':\\s*)\\d+');
    if (!re.test(src)) throw new Error('limit not found in source: ' + k);
    src = src.replace(re, '$1' + overrides[k]);
  });
  return src;
}

// Each load gets a fresh copy of the module, so queue state never leaks between
// checks. `fetch` is passed as a parameter rather than set on `global`: a module
// from an earlier check keeps its retry timers running, and with a shared global
// those late retries land on the *current* check's stub and corrupt its counts.
// As a parameter it shadows the global inside the module body, so each copy can
// only ever call its own.
function load(fetchImpl, beaconImpl, limits) {
  const listeners = {};
  const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
  const w = { addEventListener: on, crypto: require('crypto').webcrypto };
  const d = { addEventListener: on, visibilityState: 'visible' };
  const nav = beaconImpl === 'none' ? {} : { sendBeacon: beaconImpl || (() => true) };
  const f = fetchImpl || (async () => okResp(1));
  const src = limits ? withLimits(SRC, limits) : SRC;
  new Function('window', 'document', 'navigator', 'fetch', src)(w, d, nav, f);
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
  // Measured with Buffer.byteLength, NOT String.length: the limit is in bytes and
  // the two agree only for ASCII. The padding is deliberately non-ASCII for the
  // same reason — an ASCII fixture measured with .length passes whether the
  // implementation counts bytes or code units, so it tests nothing.
  const bytes = s => Buffer.byteLength(s, 'utf8');
  {
    let maxBytes = 0, delivered = 0;
    const { CC } = load(async (u, o) => {
      maxBytes = Math.max(maxBytes, bytes(o.body));
      const n = JSON.parse(o.body).p_events.length; delivered += n; return okResp(n);
    });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    const pad = 'ş'.repeat(700);        // 700 code units, 1400 bytes
    for (let i = 0; i < 60; i++) cc.track('fat', 1, { pad, i });
    await sleep(4000);
    check('a batch never exceeds the server byte limit', maxBytes <= 32768, maxBytes + ' bytes');
    check('no event is lost when splitting by size', delivered === 60, delivered + '/60');
  }

  // --- an over-limit event is measured in bytes, not code units -------------
  // The fixture has to discriminate, which rules out emoji: they are surrogate
  // pairs, so .length already counts them as 2 and an over-byte emoji payload is
  // over-length too. '中' is ONE code unit and THREE bytes — 12000 of them read
  // as 12000 against the 28000 limit while weighing 36000 on the wire, so a
  // .length guard accepts it and only a byte guard drops it.
  {
    let sent = 0;
    const { CC } = load(async (u, o) => { sent += JSON.parse(o.body).p_events.length; return okResp(1); });
    const cc = new CC('org_wide'); cc.identify({ customerId: 'c1' });
    cc.track('huge', 1, { pad: '中'.repeat(12000) });
    cc.track('small', 1);
    await sleep(800);
    check('an event over the byte limit is dropped even when .length looks safe',
      sent === 1, sent + ' sent');
  }

  // --- error classification -------------------------------------------------
  // Only a credential failure stops a key. 400/413/422 mean "this payload is
  // bad", not "this key is bad" — dropping the batch there is what keeps a
  // malformed request from taking an organisation's tracking down completely.
  for (const [status, fatal] of [[401, true], [403, true], [404, true],
                                 [400, false], [413, false], [422, false],
                                 [408, false], [429, false], [500, false]]) {
    const { CC } = load(async () => errResp(status));
    const cc = new CC('key' + status); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(500);
    check(status + ' is ' + (fatal ? 'fatal' : 'not fatal'), cc.isStopped === fatal);
  }

  // --- a rejected batch is dropped, not retried, and not fatal ---------------
  {
    let calls = 0;
    const { CC } = load(async () => { calls++; return errResp(400); });
    const cc = new CC('org_400'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(800);
    check('a 400 does not stop the key', !cc.isStopped);
    check('a 400 batch is not retried', calls === 1, calls + ' call(s)');
    check('a dropped batch is counted', cc.stats.droppedEvents === 1 && cc.stats.droppedBatches === 1,
      JSON.stringify(cc.stats));
    check('the queue is left empty after a drop', cc.stats.queued === 0);
  }

  // --- a bad batch does not block the events behind it ----------------------
  {
    let delivered = 0;
    const { CC } = load(async (u, o) => {
      const n = JSON.parse(o.body).p_events.length;
      if (JSON.parse(o.body).p_events[0].event_type === 'poison') return errResp(400);
      delivered += n; return okResp(n);
    });
    const cc = new CC('org_mix'); cc.identify({ customerId: 'c1' });
    cc.track('poison', 1);
    await sleep(300);
    cc.track('good', 1);
    await sleep(800);
    check('a good event still lands after a rejected batch', delivered === 1, delivered + ' delivered');
    check('only the bad batch was dropped', cc.stats.droppedEvents === 1);
  }

  // --- stopping a key counts what it throws away ---------------------------
  // Discarding the backlog is right when the credential is dead, but it is the
  // largest loss the SDK can inflict. The batch on the wire counts too: takeBatch
  // already removed it from the queue, so stopKey's filter cannot see it.
  {
    let release;
    const gate = new Promise(function(r) { release = r; });
    const { CC } = load(async () => { await gate; return errResp(401); });
    const cc = new CC('org_stop'); cc.identify({ customerId: 'c1' });
    cc.track('inflight', 1);           // this one goes on the wire and blocks
    await sleep(50);
    for (let i = 0; i < 4; i++) cc.track('queued' + i, 1);   // these stay queued
    release();
    await sleep(300);
    check('a stopped key is marked stopped', cc.isStopped);
    check('stopping a key counts the queued events it discarded',
      cc.stats.droppedEvents === 5, JSON.stringify(cc.stats));
    check('nothing is left queued after stopping', cc.stats.queued === 0);
  }

  // --- the beacon is sized after form-encoding, not before ------------------
  // URLSearchParams percent-escapes every { " : and , to three bytes, so a batch
  // that fits the 28KB request limit can be 50-70KB on the wire. Sizing the raw
  // JSON sends bodies over the browser's 64KB budget and learns it from refusals.
  {
    let maxBody = 0, beacons = 0;
    const { CC, hide } = load(undefined, (url, body) => {
      beacons++;
      maxBody = Math.max(maxBody, bytes(String(body)));
      return true;
    });
    const cc = new CC('org_beacon'); cc.identify({ customerId: 'c1' });
    const pad = 'ü'.repeat(400);
    for (let i = 0; i < 120; i++) cc.track('leaving', 1, { pad, i });
    hide();
    check('a beacon body stays inside the browser budget once encoded',
      maxBody <= 48000, maxBody + ' bytes');
    check('the queue still leaves on page hide', beacons > 0, beacons + ' beacon(s)');
  }

  // --- one event too big to beacon must not abandon the rest ----------------
  // Metadata of many short key/value pairs encodes near the 3x ceiling, so an
  // event that passes the 28KB request cap can exceed the 48KB beacon cap on its
  // own. It cannot be shrunk any further, and sending it would claim most of the
  // page-wide budget — or be refused, which used to abandon the whole queue.
  {
    const many = {};
    // The window is narrow: at the ~1.83x encoding ratio these pairs produce,
    // only events between roughly 26200 and 28000 raw bytes are accepted by
    // track() yet unbeaconable. 1850 pairs sits inside it.
    for (let i = 0; i < 1850; i++) many['k' + i] = 'v' + i;
    // Measure what the SDK measures: the whole event object, not the metadata alone.
    const ev = { event_id: 'x'.repeat(36), customer_id: 'c1', event_type: 'toobig', value: 1, metadata: many };
    const rawBytes = bytes(JSON.stringify(ev)) + 1;
    const encBytes = bytes(new URLSearchParams({ p_api_key: 'org_fat', p_events: JSON.stringify([ev]) }).toString());
    check('fixture is valid: fits the request cap but not the beacon cap',
      rawBytes < 28000 && encBytes > 48000, rawBytes + ' raw / ' + encBytes + ' encoded');

    let maxBody = 0, delivered = 0;
    const { CC, hide } = load(undefined, (url, body) => {
      maxBody = Math.max(maxBody, bytes(String(body)));
      delivered += JSON.parse(new URLSearchParams(String(body)).get('p_events')).length;
      return true;
    });
    const cc = new CC('org_fat'); cc.identify({ customerId: 'c1' });
    cc.track('toobig', 1, many);
    for (let i = 0; i < 5; i++) cc.track('small' + i, 1);
    hide();
    check('an unbeaconable event is not sent over budget',
      maxBody <= 48000, maxBody + ' bytes');
    check('the events behind it still leave', delivered === 5, delivered + ' delivered');
    // 'hidden' fires on tab switch too, and the page may well survive. The event
    // is under the 28KB request cap, so the fetch path can still deliver it —
    // keeping it beats discarding it over a beacon-only ceiling.
    check('the unbeaconable event is kept for the fetch path',
      cc.stats.queued === 1 && cc.stats.droppedEvents === 0, JSON.stringify(cc.stats));
  }

  // --- hiding the page mid-request must not double-count the loss -----------
  // sendPending() folds the in-flight batch back into the queue, so if the
  // request then fails fatally, stopKey's own filter already sees those items.
  // Adding the in-flight count on top would report more lost than existed.
  {
    let release;
    const gate = new Promise(function(r) { release = r; });
    const { CC, hide } = load(async () => { await gate; return errResp(401); },
      () => false);                    // every beacon refused, so nothing leaves
    const cc = new CC('org_hide'); cc.identify({ customerId: 'c1' });
    cc.track('inflight', 1);
    await sleep(50);
    for (let i = 0; i < 4; i++) cc.track('queued' + i, 1);
    hide();                            // folds the in-flight item back in
    release();                         // now the request fails fatally
    await sleep(300);
    check('a fatal stop after a page hide counts each event once',
      cc.stats.droppedEvents === 5, JSON.stringify(cc.stats));
  }

  // --- the retry re-queue respects the queue cap ----------------------------
  // track() refuses to push past maxQueueLength, but the retry path concatenates
  // straight onto the queue and bypasses that check. Reproducing it needs the
  // queue refilled to the cap WHILE a batch is on the wire, so the failed batch
  // comes back to an already-full queue — hence the gated fetch.
  {
    let release;
    const gate = new Promise(function(r) { release = r; });
    const { CC } = load(async () => { await gate; return errResp(500); }, undefined,
      { maxQueueLength: 10, maxBatchSize: 5, maxBackoffMs: 20, maxAttempts: 50 });
    const cc = new CC('org_cap'); cc.identify({ customerId: 'c1' });
    cc.track('first', 1);              // one event goes in flight and blocks on the gate
    await sleep(50);
    for (let i = 0; i < 10; i++) cc.track('e' + i, 1);   // refill to the cap behind it
    release();                          // now let the in-flight batch fail and requeue
    await sleep(400);
    check('the retry re-queue does not exceed the queue cap',
      cc.stats.queued <= 10, cc.stats.queued + ' queued');
    check('the overflow is counted rather than silently lost',
      cc.stats.droppedEvents >= 1, JSON.stringify(cc.stats));
  }

  // --- retries are bounded --------------------------------------------------
  // With the real backoff this takes 81s of waiting, so shrink the ceiling and
  // the cap. What is being proved is that it terminates, not how long it takes.
  {
    let calls = 0;
    const { CC } = load(async () => { calls++; return errResp(500); }, undefined,
      { maxAttempts: 3, maxBackoffMs: 50 });
    const cc = new CC('org_500'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(1000);
    check('a permanently failing batch is eventually given up on',
      cc.stats.droppedEvents === 1, JSON.stringify(cc.stats));
    check('it stops calling once given up', calls === 3, calls + ' call(s)');
    check('giving up does not stop the key', !cc.isStopped);
    check('nothing is left queued after giving up', cc.stats.queued === 0);
  }

  // --- a 200 reporting failure is retried, then given up on -----------------
  {
    const { CC } = load(async () => ({
      ok: true, text: async () => '',
      json: async () => ({ success: false, error: 'nope' })
    }), undefined, { maxAttempts: 3, maxBackoffMs: 50 });
    const cc = new CC('org_softfail'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(1000);
    check('success:false is given up on rather than looping forever',
      cc.stats.droppedEvents === 1, JSON.stringify(cc.stats));
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
      // 401, not 400: only a credential failure is fatal now, and this check is
      // about a fatal error being contained to one key.
      if (b.p_api_key === 'bad') return errResp(401);
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
