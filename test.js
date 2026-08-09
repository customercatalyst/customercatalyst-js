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
// scriptAttrs simulates a <script api-key="..." ...> tag for the Tier 4
// auto-init checks. Left undefined, `document` gets neither currentScript
// nor querySelector — the same shape as every check above this needs, and
// the one auto-init has to survive without throwing (see CLAUDE.md: a throw
// at load time takes the whole file down with it).
function load(fetchImpl, beaconImpl, limits, scriptAttrs) {
  const listeners = {};
  const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
  const w = { addEventListener: on, crypto: require('crypto').webcrypto };
  const d = { addEventListener: on, visibilityState: 'visible' };
  if (scriptAttrs) {
    const scriptEl = { getAttribute: n => (Object.prototype.hasOwnProperty.call(scriptAttrs, n) ? scriptAttrs[n] : null) };
    d.currentScript = scriptEl;
    d.querySelector = () => scriptEl;
  }
  const nav = beaconImpl === 'none' ? {} : { sendBeacon: beaconImpl || (() => true) };
  const f = fetchImpl || (async () => okResp(1));
  const src = limits ? withLimits(SRC, limits) : SRC;
  new Function('window', 'document', 'navigator', 'fetch', src)(w, d, nav, f);
  return {
    CC: w.CustomerCatalyst,
    autoInited: w.customercatalyst,
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

  // --- Tier 3.1: backoff uses equal jitter, not a deterministic delay ------
  // Every open tab computing the same delay from the same failure count
  // retries in lockstep and re-hammers a server that is trying to recover.
  // maxRequestsPerSecond is raised so minInterval cannot mask the jitter
  // behind its own pacing floor — the point here is the backoff delay
  // itself, not request pacing (which the "one key's outage" checks above
  // already cover at default rates).
  {
    const times = [];
    const { CC } = load(async () => { times.push(Date.now()); return errResp(500); },
      undefined, { maxRequestsPerSecond: 1000, maxBackoffMs: 100, maxAttempts: 50 });
    const cc = new CC('org_jitter'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(1200);
    // temp = min(maxBackoffMs, minInterval * 2^failures) saturates at
    // maxBackoffMs once failures >= 7 (2^7 = 128 > 100). Sampling from
    // gap index 7 onward guarantees every sample is drawn from the same
    // fully-saturated [50, 100] window, isolating jitter from the
    // exponential curve underneath it.
    const gaps = [];
    for (let i = 7; i < times.length - 1; i++) gaps.push(times[i + 1] - times[i]);
    check('enough retries happened to observe the saturated jitter window', gaps.length >= 4, gaps.length + ' gap(s)');
    check('every jittered gap stays within the equal-jitter bounds [temp/2, temp]',
      gaps.every(g => g >= 40 && g <= 110), gaps.join(','));
    check('the jittered delay varies rather than repeating the old fixed value',
      new Set(gaps.map(g => Math.round(g / 5))).size > 1, gaps.join(','));
  }

  // --- Tier 3.2: linger coalesces a burst, and flush() cancels it ----------
  {
    let calls = 0, firstBatchSize = 0;
    const { CC } = load(async (u, o) => {
      calls++;
      const n = JSON.parse(o.body).p_events.length;
      if (calls === 1) firstBatchSize = n;
      return okResp(n);
    });
    const cc = new CC('org_linger'); cc.identify({ customerId: 'c1' });
    for (let i = 0; i < 10; i++) cc.track('burst', 1, { i });   // synchronous — well inside the 50ms window
    await sleep(200);
    check('a synchronous burst on an empty queue coalesces into one batch',
      calls === 1 && firstBatchSize === 10, calls + ' call(s), first batch ' + firstBatchSize);
  }
  {
    const t0 = Date.now();
    let sentAt = null;
    const { CC } = load(async () => { sentAt = Date.now(); return okResp(1); });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);              // schedules the 50ms linger, does not send yet
    await cc.flush();              // must not wait it out — a closing page cannot afford to
    check('flush cancels a pending linger and sends right away',
      sentAt !== null && (sentAt - t0) < 40, sentAt === null ? 'never sent' : (sentAt - t0) + 'ms');
  }
  {
    // sendPending() reads eventQueue directly and does not go through
    // _processQueue at all, so a pending linger must not stop a beacon on
    // page hide either — no sleep before hide(), same as the existing
    // "hiding the page sends..." check above, which already proves this for
    // the non-linger cases; this confirms it holds mid-linger too.
    let beaconed = 0;
    const { CC, hide } = load(async () => new Promise(() => {}), (u, body) => {
      beaconed += JSON.parse(new URLSearchParams(body.toString()).get('p_events')).length;
      return true;
    });
    const cc = new CC('org_test'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    hide();
    check('sendPending sends the queue even while a linger timer is still pending', beaconed === 1);
  }

  // --- Tier 3.3: maxFieldLength counts code points, not UTF-16 units -------
  // Same class of error as THE UNIT RULE: the server counts customer_id/
  // event_type with Postgres length(), i.e. characters (code points), while
  // .length counts UTF-16 code units — equal only for the BMP. An emoji is
  // one code point but two units, so a 200-emoji string reads as 400 against
  // a naive .length guard and gets rejected client-side even though the
  // server would accept it.
  {
    const { CC } = load();
    const cc = new CC('org_cp');
    const under = '\u{1F600}'.repeat(200);                  // 200 code points, 400 UTF-16 units
    // 260 code points, 460 units: under 2x the limit (510), so only an
    // actual code-point count — not the cheap .length pre-filter — catches
    // this one. Proves Array.from is actually exercised, not just the guard.
    const over = 'a'.repeat(60) + '\u{1F600}'.repeat(200);
    check('an astral-plane string under the code-point limit is accepted despite .length > 255',
      !threw(() => cc.identify({ customerId: under })), 'len=' + under.length);
    check('an astral-plane string over the code-point limit is rejected even though .length <= 2x the limit',
      !!threw(() => cc.identify({ customerId: over })), 'len=' + over.length);

    cc.identify({ customerId: 'c1' });
    check('an astral-plane eventType over the code-point limit is rejected', !!threw(() => cc.track(over)));
    check('an astral-plane eventType under the code-point limit is accepted', !threw(() => cc.track(under)));
  }

  // --- Tier 3.4: sendPending grows `size` back after a successful beacon ---
  // Without growth, one oversized batch driving `size` to 1 sends every
  // later batch in the same drain one event per beacon — burning the
  // shared page-wide beacon budget exactly when the page is closing. The
  // first event here is unbeaconable alone (same fixture as the existing
  // "one event too big to beacon" check) and gets deferred, leaving `size`
  // at 1; the 200 small events behind it should then batch back up rather
  // than going out one at a time.
  {
    const many = {};
    for (let i = 0; i < 1850; i++) many['k' + i] = 'v' + i;

    let beaconCount = 0, deliveredSmall = 0;
    const { CC, hide } = load(async () => new Promise(() => {}), (url, body) => {
      beaconCount++;
      const events = JSON.parse(new URLSearchParams(String(body)).get('p_events'));
      deliveredSmall += events.filter(function(e) { return e.event_type === 'small'; }).length;
      return true;
    });
    const cc = new CC('org_grow'); cc.identify({ customerId: 'c1' });
    cc.track('toobig', 1, many);            // unbeaconable alone -> deferred, leaves size at 1
    for (let i = 0; i < 200; i++) cc.track('small', 1);
    hide();
    check('every small event still leaves after the size collapses to 1',
      deliveredSmall === 200, deliveredSmall + '/200');
    check('size grows back rather than staying at 1 for the rest of the drain',
      beaconCount <= 15, beaconCount + ' beacon(s) for 200 event(s)');
    check('the unbeaconable event is still kept for the fetch path, not lost',
      cc.stats.queued === 1 && cc.stats.droppedEvents === 0, JSON.stringify(cc.stats));
  }

  // --- Tier 3.5: a per-key queue cap stops one key from starving another ---
  {
    let release;
    const gate = new Promise(function(r) { release = r; });
    const { CC } = load(async () => { await gate; return okResp(1); }, undefined,
      { maxQueueLength: 2000, maxQueuePerKey: 5 });
    const busy = new CC('org_busykey'); busy.identify({ customerId: 'c1' });
    const other = new CC('org_otherkey'); other.identify({ customerId: 'c2' });
    busy.track('first', 1);            // goes in flight and blocks on the gate
    await sleep(100);
    for (let i = 0; i < 20; i++) busy.track('e' + i, 1);   // far past the per-key cap of 5
    other.track('fine', 1);
    check('a per-key cap stops one key\'s queue at the limit',
      busy.stats.queued === 5, busy.stats.queued + ' queued');
    check('a different key is unaffected by another key\'s per-key cap',
      other.stats.queued === 1, other.stats.queued + ' queued');
    release();
    await sleep(500);
    check('the capped key still drains once its backlog is sent',
      busy.stats.queued === 0 && other.stats.queued === 0,
      JSON.stringify({ busy: busy.stats, other: other.stats }));
  }

  // --- Tier 3.6: a 429's Retry-After is honoured from the body -------------
  // The header is not exposed cross-origin on this endpoint (see the
  // comment at parseRetryAfter in the source), so errResp's headerless
  // response is exactly the shape a real browser sees here — this exercises
  // the body path, not a gap in the mock.
  {
    let calls = 0;
    const times = [];
    const { CC } = load(async () => {
      calls++; times.push(Date.now());
      return {
        ok: false, status: 429, json: async () => null,
        text: async () => JSON.stringify({ success: false, error: 'rate_limited', retry_after_seconds: 1 })
      };
    }, undefined, { maxBackoffMs: 20 });
    const cc = new CC('org_429'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(1300);
    check('a 429 with retry_after_seconds is retried', calls >= 2, calls + ' call(s)');
    check('the wait matches the Retry-After, not the much shorter backoff cap',
      calls < 2 || (times[1] - times[0]) >= 900,
      calls < 2 ? 'n/a' : (times[1] - times[0]) + 'ms');
  }
  // --- an oversized Retry-After is clamped, not honoured verbatim ----------
  // Co-tenants are protected from a long wait by the skip-ahead scan now
  // (see the Tier 3.7 checks below), not by this clamp — clamping still
  // matters on its own, though: retry_after_seconds is a number the server
  // (or a spoofed response) chose, not something the SDK controls, so an
  // un-clamped value could park a key for hours on nothing more than that.
  {
    let calls = 0;
    const times = [];
    const { CC } = load(async () => {
      calls++; times.push(Date.now());
      return {
        ok: false, status: 429, json: async () => null,
        text: async () => JSON.stringify({ retry_after_seconds: 999999 })
      };
    }, undefined, { maxRetryAfterMs: 1500, maxBackoffMs: 20 });
    const cc = new CC('org_429clamp'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(3600);
    check('an oversized retry_after_seconds is clamped rather than honoured verbatim',
      calls >= 2, calls + ' call(s)');
    check('the clamped wait matches maxRetryAfterMs, not the raw value',
      calls < 2 || ((times[1] - times[0]) >= 1400 && (times[1] - times[0]) <= 1700),
      calls < 2 ? 'n/a' : (times[1] - times[0]) + 'ms');
  }

  // --- Tier 3.7: head-of-line blocking — skip a parked key, don't wait on it -
  // _processQueue used to derive its wait from whichever key sat at
  // eventQueue[0] and sleep the whole loop for it, so a key parked behind a
  // Retry-After blocked every other organisation's healthy traffic queued
  // behind it — a reviewer measured a second org's event held ~1.95s behind
  // a rate-limited org. findSendableIndex fixes this by scanning past a
  // parked key for one that can send right now.
  {
    // The exact race that reproduces the bug: org_other's events are queued
    // AFTER org_parked has already failed and parked itself at the head —
    // tracked mid-test, not up front, so they land behind it in array order,
    // same as the reviewer's repro.
    let otherDelivered = 0, otherFirstAt = null;
    const t0 = Date.now();
    // org_parked never succeeds — maxAttempts:2 keeps it from retrying (and
    // holding a live timer) for the default 10 attempts' worth of 2s waits
    // long after this block's own assertions are done, the same reason
    // every other "never succeeds" block in this file bounds it.
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'org_parked') {
        return { ok: false, status: 429, json: async () => null,
          text: async () => JSON.stringify({ retry_after_seconds: 2 }) };
      }
      if (otherFirstAt === null) otherFirstAt = Date.now();
      otherDelivered += b.p_events.length;
      return okResp(b.p_events.length);
    }, undefined, { maxAttempts: 2 });
    const parked = new CC('org_parked'); parked.identify({ customerId: 'c1' });
    const other = new CC('org_other'); other.identify({ customerId: 'c2' });
    parked.track('stuck', 1);
    await sleep(200);                          // let the 429 land and park the key at the head
    for (let i = 0; i < 5; i++) other.track('fine', 1, { i });
    await sleep(500);
    check('a parked key does not delay a second org\'s events',
      otherDelivered === 5 && otherFirstAt !== null && (otherFirstAt - t0) < 1000,
      otherFirstAt === null ? 'never sent' : (otherFirstAt - t0) + 'ms, ' + otherDelivered + '/5');
  }
  {
    // The flip side of skipping: a parked key must still get its turn once
    // its own wait expires, not be starved forever by the keys skipping past it.
    let parkedCalls = 0, parkedDelivered = 0;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'org_parked2') {
        parkedCalls++;
        if (parkedCalls === 1) {
          return { ok: false, status: 429, json: async () => null,
            text: async () => JSON.stringify({ retry_after_seconds: 1 }) };
        }
        parkedDelivered += b.p_events.length;
        return okResp(b.p_events.length);
      }
      return okResp(b.p_events.length);
    }, undefined, { maxBackoffMs: 20 });
    const parked = new CC('org_parked2'); parked.identify({ customerId: 'c1' });
    const other = new CC('org_other2'); other.identify({ customerId: 'c2' });
    parked.track('stuck', 1);
    await sleep(150);
    other.track('fine', 1);
    await sleep(1300);                         // past the 1s retry-after, plus margin
    check('the parked key still sends once its own wait expires — skipping does not starve it',
      parkedCalls >= 2 && parkedDelivered === 1, parkedCalls + ' call(s), delivered=' + parkedDelivered);
  }
  {
    // Two keys parked at once with different expiries, longer-wait key at
    // the head: sleeping on the head's wait (3s) instead of the earliest
    // (1.2s) would keep org_B waiting for org_A's clock, not its own.
    // org_A never succeeds — maxAttempts:2 bounds it for the same reason as
    // the block above, instead of it retrying every 3s for the rest of the run.
    let aCalls = 0, bCalls = 0, bDelivered = 0;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'org_A') {
        aCalls++;
        return { ok: false, status: 429, json: async () => null,
          text: async () => JSON.stringify({ retry_after_seconds: 3 }) };
      }
      bCalls++;
      if (bCalls === 1) {
        return { ok: false, status: 429, json: async () => null,
          text: async () => JSON.stringify({ retry_after_seconds: 1.2 }) };
      }
      bDelivered += b.p_events.length;
      return okResp(b.p_events.length);
    }, undefined, { maxBackoffMs: 20, maxRequestsPerSecond: 1000, maxAttempts: 2 });
    const a = new CC('org_A'); a.identify({ customerId: 'c1' });
    const b = new CC('org_B'); b.identify({ customerId: 'c2' });
    a.track('slow', 1);                        // parks first, sits at the head with the LONGER wait
    await sleep(60);
    b.track('fast', 1);                        // parks second, behind A, with the SHORTER wait
    await sleep(1600);                         // past B's 1.2s but well short of A's 3s
    check('all-keys-parked sleeps until the earliest expiry, not the head\'s',
      bCalls >= 2 && bDelivered === 1 && aCalls === 1,
      'A calls=' + aCalls + ', B calls=' + bCalls + ', B delivered=' + bDelivered);
  }
  {
    // The overwhelmingly common case — nothing parked, one key only — must
    // still take index 0 directly and send everything in one batch, exactly
    // as before the skip-ahead scan existed.
    let calls = 0, delivered = 0;
    const { CC } = load(async (u, o) => {
      calls++;
      const n = JSON.parse(o.body).p_events.length;
      delivered += n;
      return okResp(n);
    });
    const cc = new CC('org_single'); cc.identify({ customerId: 'c1' });
    for (let i = 0; i < 5; i++) cc.track('x', 1, { i });
    await sleep(300);
    check('a single-key queue with nothing parked is unaffected — one batch from index 0',
      calls === 1 && delivered === 5, calls + ' call(s), ' + delivered + '/5');
  }

  // --- Tier 3.8: a pending backoff survives track() calls made during it ----
  // The head-of-line fix (Tier 3.7) makes track() cancel and re-run
  // _processQueue() whenever a fresh event's key was not the one the current
  // wait was for (see the comment at processTimer's declaration). That is
  // safe for a Retry-After wait because it is persisted in notBeforeByKey —
  // it used to NOT be safe for the exponential-backoff wait, which existed
  // only as the argument of the setTimeout the fix had just cancelled, so
  // re-deriving it found no notBeforeByKey entry and treated the key as
  // immediately sendable. None of the earlier backoff/jitter checks in this
  // file catch that: they all call track() exactly once and never again
  // during the wait. These three do call track() repeatedly mid-wait —
  // exactly the arrival pattern that used to collapse the backoff.
  {
    // Single org, failing on every attempt, with a second track() call
    // landing every 20ms throughout — the reviewer's first repro. Without
    // the fix this stays flat at ~minInterval forever; fixed, it must
    // escalate roughly the same as the Tier 3.1 jitter check above, just
    // observed across several different failure counts instead of one.
    const times = [];
    const { CC } = load(async () => { times.push(Date.now()); return errResp(500); },
      undefined, { maxBackoffMs: 3200, maxAttempts: 30 });
    const cc = new CC('org_backoff_survives_pokes'); cc.identify({ customerId: 'c1' });
    cc.track('seed', 1);
    const ticker = setInterval(function() { cc.track('poke', 1); }, 20);
    await sleep(3000);
    clearInterval(ticker);
    const gaps = [];
    for (let i = 0; i < times.length - 1; i++) gaps.push(times[i + 1] - times[i]);
    check('enough retries happened to observe escalation while track() keeps firing',
      gaps.length >= 3, gaps.length + ' gap(s): ' + gaps.join(','));
    check('the gap between send attempts escalates instead of collapsing to a flat minInterval',
      gaps.length >= 3 && gaps[gaps.length - 1] > gaps[0] * 2, gaps.join(','));
  }
  {
    // Cross-tenant version of the same repro: org A is the one failing and
    // backing off; org B is healthy and merely calls track() every 20ms, the
    // way ordinary page traffic would. B's traffic must not collapse A's
    // backoff, and — the flip side, proving the fix didn't just re-introduce
    // head-of-line blocking to get there — B's own events must still go out
    // promptly.
    const timesA = [];
    let bDelivered = 0, bFirstAt = null;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'tenant_a_backoff') { timesA.push(Date.now()); return errResp(500); }
      if (bFirstAt === null) bFirstAt = Date.now();
      bDelivered += b.p_events.length;
      return okResp(b.p_events.length);
    }, undefined, { maxBackoffMs: 3200, maxAttempts: 30 });
    const a = new CC('tenant_a_backoff'); a.identify({ customerId: 'c1' });
    const b = new CC('tenant_b_healthy'); b.identify({ customerId: 'c2' });
    a.track('stuck', 1);
    await sleep(150);                  // let A fail once and start its own backoff
    const tickerStart = Date.now();
    const ticker = setInterval(function() { b.track('poke', 1); }, 20);
    await sleep(3000);
    clearInterval(ticker);
    const gapsA = [];
    for (let i = 0; i < timesA.length - 1; i++) gapsA.push(timesA[i + 1] - timesA[i]);
    check('org A still gets enough retries to observe escalation while org B is active',
      gapsA.length >= 3, gapsA.length + ' gap(s): ' + gapsA.join(','));
    check('org B\'s ordinary traffic does not collapse org A\'s backoff',
      gapsA.length >= 3 && gapsA[gapsA.length - 1] > gapsA[0] * 2, gapsA.join(','));
    check('org B\'s own events still go out promptly despite org A backing off (head-of-line survives)',
      bFirstAt !== null && (bFirstAt - tickerStart) < 500 && bDelivered >= 50,
      bDelivered + ' delivered, firstAt=' + (bFirstAt === null ? 'never' : (bFirstAt - tickerStart) + 'ms'));
  }
  {
    // Same idea on the Retry-After path specifically, which was already
    // correct before this fix — this proves the unification into one map
    // didn't regress it. Org B pokes every 20ms while org A sits parked on
    // a 2s retry-after; B must still be served promptly (head-of-line).
    let bDelivered = 0, bFirstAt = null;
    const { CC } = load(async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.p_api_key === 'tenant_a_retryafter') {
        return { ok: false, status: 429, json: async () => null,
          text: async () => JSON.stringify({ retry_after_seconds: 2 }) };
      }
      if (bFirstAt === null) bFirstAt = Date.now();
      bDelivered += b.p_events.length;
      return okResp(b.p_events.length);
    }, undefined, { maxAttempts: 2 });
    const a = new CC('tenant_a_retryafter'); a.identify({ customerId: 'c1' });
    const b = new CC('tenant_b_retryafter'); b.identify({ customerId: 'c2' });
    a.track('stuck', 1);
    await sleep(150);                  // let A park itself on the 2s retry-after
    const tickerStart = Date.now();
    const ticker = setInterval(function() { b.track('poke', 1); }, 20);
    await sleep(600);
    clearInterval(ticker);
    check('a key parked on a retry-after still does not delay a second org, even under sustained track() traffic',
      bFirstAt !== null && (bFirstAt - tickerStart) < 500 && bDelivered > 0,
      bDelivered + ' delivered, firstAt=' + (bFirstAt === null ? 'never' : (bFirstAt - tickerStart) + 'ms'));
  }

  // --- Tier 4: script-tag auto-init -----------------------------------------
  {
    const { CC, autoInited } = load(undefined, undefined, undefined, { 'api-key': 'org_auto' });
    check('a script[api-key] tag auto-inits window.customercatalyst', autoInited instanceof CC);
    check('the auto-inited instance carries the tag\'s api key', autoInited && autoInited.apiKey === 'org_auto');
  }
  {
    // Exactly one key concept — api-key, not data-api-key.
    const { autoInited } = load(undefined, undefined, undefined, { 'data-api-key': 'org_wrong' });
    check('a data-api-key attribute does not auto-init — there is exactly one key concept', !autoInited);
  }
  {
    // An empty attribute already worked (falsy); whitespace is the gap — it
    // is truthy, so without .trim() this used to construct a live instance
    // whose every send would fail against a key that was never real.
    const { autoInited } = load(undefined, undefined, undefined, { 'api-key': '' });
    check('an empty api-key attribute does not auto-init', !autoInited);
  }
  {
    const { autoInited } = load(undefined, undefined, undefined, { 'api-key': '   ' });
    check('a whitespace-only api-key attribute does not auto-init', !autoInited);
  }
  {
    // No script tag at all: the harness's default fake document (only
    // addEventListener — no currentScript, no querySelector) is exactly the
    // environment auto-init must survive without throwing. Every check above
    // this one in the file already ran against that same default document,
    // so a throw here would have taken all 60+ of them down with it.
    const { CC, autoInited } = load();
    check('no script[api-key] tag means no auto-init', !autoInited);
    check('the constructor path is unaffected by auto-init', new CC('org_manual') instanceof CC);
  }
  {
    const { autoInited } = load(undefined, undefined, undefined, { 'api-key': 'org_debugattr', debug: '' });
    check('a debug attribute on the script tag flips CustomerCatalyst.debug',
      autoInited && autoInited.constructor.debug === true);
  }
  {
    // A planted window.customercatalyst that is NOT a real instance — the
    // hijack this guards against: a script running before this one cannot
    // construct a real CustomerCatalyst (the class does not exist in its
    // scope yet), but it can plant a lookalike object with its own
    // identify()/track(). The old truthiness check trusted it; init() must
    // replace it instead. Simulated directly (not via load()) since load()
    // always starts from a bare window — this needs window.customercatalyst
    // set BEFORE the module evaluates.
    const listeners = {};
    const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
    const w = { addEventListener: on, crypto: require('crypto').webcrypto };
    const scriptEl = { getAttribute: n => (n === 'api-key' ? 'org_should_not_load' : null) };
    const d = { addEventListener: on, visibilityState: 'visible', currentScript: scriptEl };
    const sentinel = {};                 // looks like an SDK instance but isn't one
    w.customercatalyst = sentinel;
    new Function('window', 'document', 'navigator', 'fetch', SRC)(w, d, {}, async () => okResp(1));
    check('a planted window.customercatalyst that is not a real instance is replaced, not trusted',
      w.customercatalyst !== sentinel && w.customercatalyst instanceof w.CustomerCatalyst);
    check('the replacement instance still carries the tag\'s own api key',
      w.customercatalyst && w.customercatalyst.apiKey === 'org_should_not_load');
  }
  {
    // Replacing is correct, but a customer whose own page uses this identifier
    // must not find out by debugging why their code broke. The warning is
    // unconditional on purpose — nobody turns debug on to find a bug they do
    // not yet know they have.
    const warns = [];
    const saved = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));

    const listeners = {};
    const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
    const w = { addEventListener: on, crypto: require('crypto').webcrypto };
    const scriptEl = { getAttribute: n => (n === 'api-key' ? 'org_collide' : null) };
    const d = { addEventListener: on, visibilityState: 'visible', currentScript: scriptEl };
    w.customercatalyst = { theirOwnThing: true };   // the customer's, not ours
    new Function('window', 'document', 'navigator', 'fetch', SRC)(w, d, {}, async () => okResp(1));

    const collided = warns.filter(m => m.indexOf('already in use') !== -1);
    check('replacing a name the page was already using warns unconditionally', collided.length === 1,
      collided[0]);
    check('the collision warning names the manual path as the way out',
      collided.length === 1 && collided[0].indexOf('new CustomerCatalyst') !== -1);
    check('the collision warning never leaks the api key',
      !warns.some(m => m.indexOf('org_collide') !== -1));

    // The ordinary case must stay silent — a warning on every clean page load
    // would train customers to ignore it, which costs more than it buys.
    warns.length = 0;
    const w2 = { addEventListener: on, crypto: require('crypto').webcrypto };
    const d2 = { addEventListener: on, visibilityState: 'visible', currentScript: scriptEl };
    new Function('window', 'document', 'navigator', 'fetch', SRC)(w2, d2, {}, async () => okResp(1));
    check('a clean page does not warn', !warns.some(m => m.indexOf('already in use') !== -1));

    console.warn = saved;
  }
  {
    // A genuine prior instance — this same file loaded twice, or a caller
    // who already built one by hand — is exactly the case init() must still
    // treat as idempotent.
    const listeners = {};
    const on = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
    const w = { addEventListener: on, crypto: require('crypto').webcrypto };
    const scriptEl = { getAttribute: n => (n === 'api-key' ? 'org_should_not_load' : null) };
    const d = { addEventListener: on, visibilityState: 'visible', currentScript: scriptEl };
    new Function('window', 'document', 'navigator', 'fetch', SRC)(w, d, {}, async () => okResp(1));
    const real = w.customercatalyst;     // the instance auto-init just created
    check('auto-init creates a real instance when no window.customercatalyst exists yet', real instanceof w.CustomerCatalyst);
    check('a genuine existing window.customercatalyst instance is returned unchanged by a second init()',
      w.CustomerCatalyst.init() === real);
  }

  // --- Tier 4: debug flag ---------------------------------------------------
  {
    const calls = [];
    const realDebug = console.debug, realLog = console.log;
    console.debug = console.log = (...args) => calls.push(args.join(' '));
    const { CC } = load();
    CC.debug = true;
    const cc = new CC('org_debug'); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(300);
    console.debug = realDebug; console.log = realLog;
    check('debug logging is silent by default and emits once CustomerCatalyst.debug is set',
      calls.some(m => /queued/.test(m)) && calls.some(m => /sending batch/.test(m)),
      calls.length + ' line(s)');
  }

  // --- Tier 4: debug output never contains the full API key -----------------
  // CustomerCatalyst.debug is a public mutable static (see the comment at its
  // declaration in the source) — any script sharing the customer's page can
  // flip it and read the console, so the raw key must never be one of the
  // arguments debugLog is called with, on any path that logs one.
  {
    const calls = [];
    const realDebug = console.debug, realLog = console.log;
    console.debug = console.log = (...args) => calls.push(args.join(' '));
    const fullKey = 'org_redact_normal_path_key';
    const { CC } = load(async () => okResp(1));
    CC.debug = true;
    const cc = new CC(fullKey); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(300);
    console.debug = realDebug; console.log = realLog;
    check('debug output on the normal send path (queued/sending/server response) never prints the full key',
      calls.length > 0 && !calls.some(m => m.includes(fullKey)), calls.join(' | '));
  }
  {
    const calls = [];
    const realDebug = console.debug, realLog = console.log;
    console.debug = console.log = (...args) => calls.push(args.join(' '));
    const fullKey = 'org_redact_retryafter_key';
    // maxAttempts:2 — this mock never succeeds, so without a low ceiling the
    // module keeps retrying (and logging) for the default 10 attempts at
    // ~1s apiece, long after this block restores the real console and moves
    // on: the leftover timers would then print straight to the terminal
    // instead of into `calls`, same failure mode `maxAttempts` fixes in the
    // "retries are bounded" check above.
    const { CC } = load(async () => ({
      ok: false, status: 429, json: async () => null,
      text: async () => JSON.stringify({ retry_after_seconds: 1 })
    }), undefined, { maxBackoffMs: 20, maxAttempts: 2 });
    CC.debug = true;
    const cc = new CC(fullKey); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(1500);
    console.debug = realDebug; console.log = realLog;
    check('debug output on the retry-after path never prints the full key',
      calls.length > 0 && !calls.some(m => m.includes(fullKey)), calls.join(' | '));
  }
  {
    const calls = [];
    const realDebug = console.debug, realLog = console.log;
    console.debug = console.log = (...args) => calls.push(args.join(' '));
    const fullKey = 'org_redact_backoff_key';
    // maxAttempts:5, not 50 — same reason as the retry-after block above: it
    // must fully settle inside this block's sleep, or its remaining retries
    // keep firing (and logging to the real console) after restore.
    // maxRequestsPerSecond:1000 for the same reason it's raised in the
    // "Tier 3.1" jitter check below — minInterval (100ms at the default 10/s)
    // would otherwise dominate the much smaller 50ms backoff cap and roughly
    // double each cycle, pushing the 5th attempt past this block's sleep.
    const { CC } = load(async () => errResp(500), undefined,
      { maxBackoffMs: 50, maxAttempts: 5, maxRequestsPerSecond: 1000 });
    CC.debug = true;
    const cc = new CC(fullKey); cc.identify({ customerId: 'c1' });
    cc.track('x', 1);
    await sleep(400);
    console.debug = realDebug; console.log = realLog;
    check('debug output on the backing-off path never prints the full key',
      calls.length > 0 && !calls.some(m => m.includes(fullKey)), calls.join(' | '));
  }
  {
    const calls = [];
    const realDebug = console.debug, realLog = console.log;
    console.debug = console.log = (...args) => calls.push(args.join(' '));
    const fullKey = 'org_redact_autoinit_key';
    load(undefined, undefined, undefined, { 'api-key': fullKey, debug: '' });
    console.debug = realDebug; console.log = realLog;
    check('the auto-init debug line never prints the full key',
      calls.length > 0 && !calls.some(m => m.includes(fullKey)), calls.join(' | '));
  }

  // --- restart() resumes with no leftover retry-after after a fatal stop ---
  // stopKey() clears notBeforeByKey when it stops a key; this proves
  // restart() actually gets the benefit of that. The key earns a real
  // retry-after wait on its first attempt, then goes fatal on the retry —
  // exactly the sequence that would leave a stale future wait behind if
  // stopKey (or restart()) ever stopped clearing it.
  {
    let call = 0;
    let thirdCallAt = null;
    const { CC } = load(async () => {
      call++;
      if (call === 1) {
        return { ok: false, status: 429, json: async () => null,
          text: async () => JSON.stringify({ retry_after_seconds: 1 }) };
      }
      if (call === 2) return errResp(401);
      thirdCallAt = Date.now();
      return okResp(1);
    });
    const cc = new CC('org_restart'); cc.identify({ customerId: 'c1' });
    cc.track('first', 1);
    await sleep(1500);           // the 429's retry-after (1s) plus the fatal retry
    check('a fatal error following a retry-after wait stops the key', cc.isStopped);

    const resumeStart = Date.now();
    cc.restart();
    check('restart() clears the stopped flag', !cc.isStopped);
    cc.track('second', 1);
    await sleep(400);
    check('the key resumes sending after restart()', thirdCallAt !== null);
    check('no leftover retry-after delay gates the resumed send',
      thirdCallAt !== null && (thirdCallAt - resumeStart) < 300,
      thirdCallAt === null ? 'never sent' : (thirdCallAt - resumeStart) + 'ms');
  }

  console.warn = realWarn; console.error = realError;
  console.log(log.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
