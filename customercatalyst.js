(function(window) {
  'use strict';

  const SUPABASE_URL = 'https://xfjgmzwigomtfmaloeun.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_23PVXON8PjsWYOCpjtgrEQ_dJJTYRMj';
  const API_ENDPOINT = SUPABASE_URL + '/rest/v1/rpc/track_events';

  // A beacon cannot set headers, so the publishable key travels in the query
  // string instead. Same gateway auth, different carrier. The organisation key
  // never goes in a URL: it stays in the request body.
  const BEACON_ENDPOINT = API_ENDPOINT + '?apikey=' + encodeURIComponent(SUPABASE_PUBLISHABLE_KEY);

  const LIMITS = {
    maxRequestsPerSecond: 10,
    maxBatchSize: 50,       // half the server's 100, so a retry can never trip it
    maxBatchBytes: 28000,   // server refuses over 32768; leave room for the envelope
    maxBeaconBytes: 48000,  // form-encoded, against a 64KB budget shared page-wide
    maxQueueLength: 1000,   // an unreachable endpoint must not grow memory forever
    maxQueuePerKey: 500,    // one organisation flooding the queue must not starve another
    maxBackoffMs: 30000,
    maxAttempts: 10,         // a batch that keeps failing is dropped, not retried forever
    maxFlushWaitMs: 5000,    // flush() must never hang a page navigation
    maxFieldLength: 255,     // server drops anything longer
    maxRetryAfterMs: 300000, // cap on honouring a 429's Retry-After (see parseRetryAfter)
    lingerMs: 50             // coalesces a burst on an empty queue into one batch
  };

  // There is deliberately no way to override these at runtime. The suite needs
  // smaller values to prove retries terminate without waiting 81 seconds, and it
  // gets them by rewriting the literals above before evaluating this file, not
  // through any hook that ships. Both a mutable `CustomerCatalyst.LIMITS` and a
  // free `__ccTestLimits` identifier were tried and rejected: either lets a
  // script sharing the customer's page raise the rate and queue caps for every
  // organisation on it. A free identifier is not private: its scope chain ends
  // at the global object.

  // Queue state is module-level so that one page sending from two instances
  // still paces itself as a whole. Each item carries its own key, so events are
  // never sent under a different organisation's credentials.
  let eventQueue = [];
  let isProcessing = false;
  let inFlight = null;
  let inFlightKey = null;
  let inFlightItems = [];   // the batch on the wire (already out of the queue),
                            // so the beacon has to be told about it separately
  let lastRequestTime = 0;
  let drainWaiters = [];
  let lingerTimer = null;   // pending "wait for a burst before the first send" timer;
                            // flush() cancels it instead of waiting it out
  let processTimer = null; // pending _processQueue() retry/wait timer, whatever the
                            // reason for the wait: null while a request is actually
                            // in flight (that wait is an awaited promise, not a timer).
                            // track() cancels and re-fires it when a freshly queued
                            // event's key is not one of the ones the current wait is
                            // for (see the comment at that check).

  // Backoff is counted per key. A shared counter let one organisation's healthy
  // traffic reset the backoff another had earned from real failures.
  const failuresByKey = new Map();

  // Epoch ms per key when sending may resume: a single persisted fact,
  // written by whichever of the two waits currently applies: a 429's
  // Retry-After, or the exponential-backoff delay computed from
  // failuresByKey. Both answer the same question ("this key must not send
  // before T"), so both live here rather than one being a Map entry and the
  // other existing only as an in-flight setTimeout's argument. That used to
  // be two mechanisms: the backoff wait was never persisted anywhere, so
  // track()'s cancel-and-reinvoke (see the comment at processTimer's
  // declaration) could cancel the pending timer and re-derive a wait of
  // *zero* for a key with no retryAfterByKey entry, collapsing its backoff
  // to ~minInterval every time any key on the page called track() during the
  // wait. Persisting it here, exactly like the Retry-After wait already was,
  // is what makes cancel-and-reinvoke safe: findSendableIndex re-reads the
  // same T no matter how many times the timer computing it gets cancelled.
  // Per key, like failuresByKey, for the same reason: one organisation's
  // wait must not gate another's healthy traffic sharing the queue.
  const notBeforeByKey = new Map();

  // Stopping is tracked per key, not per instance: two instances sharing one
  // queue must not be able to discard each other's events.
  const stoppedKeys = new Set();

  // Dropping a batch is quieter than stopping a key, which is the point, but a
  // silent loss is worse than a loud one, so every drop is counted and readable
  // through `stats`. Per key, like every other counter here.
  const droppedByKey = new Map();

  function recordDrop(key, eventCount) {
    const d = droppedByKey.get(key) || { events: 0, batches: 0 };
    d.events += eventCount;
    d.batches += 1;
    droppedByKey.set(key, d);
  }

  // `inFlightCount` is the batch already on the wire: takeBatch removed it from
  // the queue, so the filter below cannot see it, and it is lost with the rest.
  // Counted here rather than at the call site so one fatal event produces one
  // drop record instead of two.
  function stopKey(key, inFlightCount) {
    stoppedKeys.add(key);
    failuresByKey.delete(key);
    notBeforeByKey.delete(key);
    // Discarding the backlog is correct (a dead credential cannot send it), but
    // it is still the largest loss the SDK can inflict, so count it. isStopped
    // says something was lost; only this says how much.
    const lost = eventQueue.filter(function(item) { return item.key === key; }).length +
      (inFlightCount || 0);
    if (lost > 0) recordDrop(key, lost);
    eventQueue = eventQueue.filter(function(item) { return item.key !== key; });
  }

  function settleDrain() {
    const waiting = drainWaiters;
    drainWaiters = [];
    waiting.forEach(function(resolve) { resolve(); });
  }

  // Every limit here is in BYTES, because that is what the server and the beacon
  // budget count. String.length counts UTF-16 code units, which equals bytes only
  // for ASCII: "ü" is one unit and two bytes, an emoji is two units and four. A
  // .length guard therefore passes payloads the server then refuses, and a
  // refusal used to stop the organisation's tracking outright.
  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function byteLength(str) {
    // No TextEncoder means a browser old enough that .length is the best
    // available guess. Degrading is right here; throwing on a customer's page
    // to protect a size estimate is not.
    return textEncoder ? textEncoder.encode(str).length : str.length;
  }

  // Same class of error as THE UNIT RULE above, one layer up: the server
  // counts customer_id/event_type with Postgres length(), which counts
  // characters (code points), while String.prototype.length counts UTF-16
  // code units, equal only for the BMP. An emoji is one code point but two
  // units, so a 200-emoji string reads as 400 against a 255 .length guard
  // and gets rejected client-side even though the server would accept it.
  //
  // Array.from(str).length counts code points correctly, but it allocates
  // one array element per code point: fine for a 255-character field, not
  // for a caller who passes a 10MB string. Code points <= UTF-16 units <= 2x
  // code points, so the cheap .length check below filters those out first;
  // Array.from only ever runs on a string already known to be at most
  // 2 * maxFieldLength units, bounding the allocation to 510 entries.
  function exceedsFieldLength(s) {
    return s.length > 2 * LIMITS.maxFieldLength || Array.from(s).length > LIMITS.maxFieldLength;
  }

  function newEventId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // randomUUID needs a secure context; plain http pages fall back to this.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // Rejecting unusable metadata here, where the customer's data enters, keeps a
  // value that cannot be serialised from throwing later inside the send loop,
  // which would jam the queue behind an event that can never leave it.
  function safeMetadata(metadata) {
    if (metadata === null || metadata === undefined) return null;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      console.warn('[CustomerCatalyst] metadata must be a plain object, ignoring it');
      return null;
    }
    try {
      JSON.stringify(metadata);
    } catch (e) {
      console.warn('[CustomerCatalyst] metadata could not be serialised, ignoring it');
      return null;
    }
    return metadata;
  }

  // Floating point makes 0.1 + 0.2 into 0.30000000000000004. The server only
  // accepts a bounded number of decimals, so round here rather than let a real
  // value be silently replaced by 1. Negatives are not meaningful for usage.
  function safeValue(value) {
    if (value === undefined || value === null) return 1;
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      console.warn('[CustomerCatalyst] value must be a non-negative number, using 1 instead of', value);
      return 1;
    }
    return Math.round(value * 1000000) / 1000000;
  }

  // Takes only consecutive events belonging to one organisation, so a batch is
  // always sendable with a single key, and stops before the server's byte limit:
  // exceeding it returns a 400, which would otherwise look fatal.
  //
  // start defaults to 0 (the overwhelmingly common single-key-at-the-head
  // case, and every caller except the skip-ahead path in _processQueue).
  // Splicing at a fixed index rather than shifting works for any start: each
  // removal shifts the next item down into that same slot, so re-reading
  // eventQueue[start] on every iteration walks forward through the run
  // exactly like the old eventQueue[0]/shift() pair did at start 0; items
  // before start, parked or not, are never touched.
  function takeBatch(limit, start) {
    const i = start || 0;
    const key = eventQueue[i].key;
    const items = [];
    let bytes = 2;

    while (items.length < limit && i < eventQueue.length && eventQueue[i].key === key) {
      const next = eventQueue[i];
      if (items.length > 0 && bytes + next.size > LIMITS.maxBatchBytes) break;
      bytes += next.size;
      items.push(next);
      eventQueue.splice(i, 1);
    }

    return { key: key, items: items };
  }

  // The selection rule: send the first key that is allowed to send right
  // now, not whichever key happens to sit at the head. A key parked behind
  // an unexpired notBeforeByKey entry (a 429's Retry-After or an
  // exponential-backoff wait, whichever last set it) is skipped, in queue
  // order, without ever reordering items within a key; items before and
  // after the skipped run keep their relative order untouched. Returns -1
  // when every queued key is currently parked.
  function findSendableIndex() {
    const now = Date.now();
    for (let i = 0; i < eventQueue.length; i++) {
      const until = notBeforeByKey.get(eventQueue[i].key);
      if (!until || until <= now) return i;
    }
    return -1;
  }

  function payloadOf(items) {
    return items.map(function(item) { return item.event; });
  }

  // Three outcomes, not two. The middle one is why this exists: a batch the
  // server refuses to accept is not a credential problem, and treating it as one
  // discarded every event the organisation had queued and took its tracking down
  // until the next page load. Only a credential failure justifies stopping a key.
  //
  //   fatal → the key will never work again; stop it
  //   drop  → this payload is bad; throw the batch away and carry on
  //   retry → transient; put it back and back off
  function classifyError(error) {
    const status = error.status;

    // No status means a network failure, or the server reporting failure in a
    // 200 body. Both can succeed later, but see maxAttempts: "later" is bounded.
    if (typeof status !== 'number') return 'retry';

    if (status === 401 || status === 403 || status === 404) return 'fatal';

    // Malformed, too large, or unprocessable. Retrying is pointless: the same
    // bytes will be refused again. The next batch may be perfectly fine.
    if (status === 400 || status === 413 || status === 422) return 'drop';

    // 408, 429, 5xx, and anything unrecognised. Unrecognised leans retry because
    // the attempt ceiling makes guessing wrong cheap, while dropping is final.
    return 'retry';
  }

  // Clamped to [1s, maxRetryAfterMs]. This cap used to be the only thing
  // standing between one key's Retry-After and a second organisation's
  // healthy events on the same page: the queue was paced by whichever key
  // sat at its head, so an un-clamped multi-minute wait from one key blocked
  // everyone behind it for just as long. That is no longer this cap's job:
  // findSendableIndex in _processQueue now skips a parked key for a sendable
  // one, so co-tenants are protected regardless of how long a single key
  // waits. What the cap still does is stop a garbage or hostile
  // retry_after_seconds (the value comes from the response body, not
  // something the SDK controls) from parking a key for hours on the
  // strength of one number the server (or a spoofed response) chose to send.
  function clampRetryAfterMs(ms) {
    return Math.max(1000, Math.min(LIMITS.maxRetryAfterMs, ms));
  }

  // Prefers the header, for any non-browser caller of this same file, but
  // the header is not exposed cross-origin on this endpoint (verified
  // against the live response: Retry-After is absent from
  // Access-Control-Expose-Headers), so response.headers.get('Retry-After')
  // returns null in a browser, always. The body is what actually carries
  // this to a browser: the RPC returns retry_after_seconds on a 429 body.
  function parseRetryAfter(response, bodyText) {
    const header = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('Retry-After')
      : null;
    if (header) {
      const seconds = Number(header);
      if (isFinite(seconds) && seconds >= 0) return clampRetryAfterMs(seconds * 1000);
      const dateMs = Date.parse(header);
      if (!isNaN(dateMs)) return clampRetryAfterMs(dateMs - Date.now());
    }

    try {
      const body = JSON.parse(bodyText);
      if (body && typeof body.retry_after_seconds === 'number') {
        return clampRetryAfterMs(body.retry_after_seconds * 1000);
      }
    } catch (e) {
      // Not JSON; nothing to parse.
    }

    return null;
  }

  class CustomerCatalyst {
    constructor(apiKey) {
      if (typeof apiKey !== 'string' || apiKey === '') {
        throw new Error('API key is required');
      }

      this.apiKey = apiKey;
      this.customerId = null;
      this.customerName = null;
    }

    get isStopped() {
      return stoppedKeys.has(this.apiKey);
    }

    // Dropping a batch keeps the SDK alive, which is right, but it is still
    // data loss, and loss nobody can see is the worst kind. This is how anyone
    // finds out it happened.
    get stats() {
      const self = this;
      const dropped = droppedByKey.get(this.apiKey) || { events: 0, batches: 0 };
      return {
        queued: eventQueue.filter(function(item) { return item.key === self.apiKey; }).length,
        droppedEvents: dropped.events,
        droppedBatches: dropped.batches
      };
    }

    identify(options) {
      if (!options || typeof options.customerId !== 'string' || options.customerId === '') {
        throw new Error('customerId is required and must be a string');
      }
      if (exceedsFieldLength(options.customerId)) {
        throw new Error('customerId must be ' + LIMITS.maxFieldLength + ' characters or fewer');
      }

      this.customerId = options.customerId;
      this.customerName = options.customerName || null;
    }

    track(eventType, value, metadata) {
      if (!this.customerId) {
        throw new Error('Must call identify() before tracking events');
      }

      if (typeof eventType !== 'string' || eventType.trim() === '') {
        throw new Error('eventType is required and must be a non-empty string');
      }
      if (exceedsFieldLength(eventType)) {
        throw new Error('eventType must be ' + LIMITS.maxFieldLength + ' characters or fewer');
      }

      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped due to fatal error. Cannot track events.');
        return;
      }

      if (eventQueue.length >= LIMITS.maxQueueLength) {
        console.warn('[CustomerCatalyst] Queue is full (' + LIMITS.maxQueueLength + '), dropping event');
        return;
      }

      // ponytail: recounted with a filter, like the `stats` getter above,
      // rather than kept as a running counter. A parallel counter needs
      // updating at every mutation site: takeBatch, stopKey, both trim
      // paths in _processQueue, and sendPending's merge-back, for a check
      // that only has to hold at these small (<=1000) queue sizes. O(n) per
      // track() is cheap here and much harder to get wrong than that.
      const self = this;
      const mine = eventQueue.filter(function(item) { return item.key === self.apiKey; }).length;
      if (mine >= LIMITS.maxQueuePerKey) {
        console.warn('[CustomerCatalyst] Queue is full for this key (' + LIMITS.maxQueuePerKey + '), dropping event');
        return;
      }

      const event = {
        // Lets the server recognise a resent event instead of counting it
        // twice. Scores are sums, so a duplicate is as wrong as a loss.
        event_id: newEventId(),
        customer_id: this.customerId,
        event_type: eventType,
        value: safeValue(value),
        metadata: safeMetadata(metadata)
      };

      // +1 for the comma this event will need once it joins a batch array.
      const size = byteLength(JSON.stringify(event)) + 1;
      if (size > LIMITS.maxBatchBytes) {
        console.warn('[CustomerCatalyst] Event is too large to send (' + size + ' bytes), dropping it');
        return;
      }

      eventQueue.push({ key: this.apiKey, size: size, event: event });
      debugLog('queued', eventType, 'for', redactKey(this.apiKey) + ', queue depth', eventQueue.length);

      if (!isProcessing) {
        // The empty→non-empty transition: wait lingerMs so a synchronous
        // burst of track() calls coalesces into one batch instead of each
        // firing its own request. isProcessing is set true here, before the
        // timer exists, so a track() call arriving during the wait sees it
        // true and just enqueues, the same guard the rate-limit wait below
        // relies on to stop concurrent calls from each scheduling their own
        // timer.
        isProcessing = true;
        lingerTimer = setTimeout(function() {
          lingerTimer = null;
          self._processQueue();
        }, LIMITS.lingerMs);
      } else if (processTimer !== null) {
        // A wait is already scheduled: for the rate limit, a backoff, or
        // (see findSendableIndex) every currently queued key being parked.
        // That wait's target was computed from the queue as it stood a
        // moment ago; this event just changed the queue, and nothing else
        // re-checks it before the timer fires. Left alone, an event for a
        // key that was never parked could sleep behind another key's wait
        // for however long that happened to be (up to maxRetryAfterMs),
        // exactly the head-of-line block findSendableIndex exists to avoid,
        // just triggered by a late arrival instead of one already queued.
        // Cancelling and re-running costs nothing when nothing has actually
        // changed: _processQueue() just re-derives the same wait and
        // reschedules it. That is true by construction, not by luck: every
        // wait this module can be sleeping on (rate limit, Retry-After,
        // exponential backoff) is either a pure function of the clock and
        // LIMITS, or persisted per key in notBeforeByKey before the timer
        // that will read it is ever scheduled. There is nowhere left a wait
        // can live only inside a setTimeout's argument, which is what would
        // make cancelling it lose information instead of just re-deriving
        // it. (Left untouched while a request is genuinely in flight;
        // processTimer is null then, not a timer to cancel.)
        clearTimeout(processTimer);
        processTimer = null;
        this._processQueue();
      }
    }

    // Every setTimeout(..., () => this._processQueue()) inside this class goes
    // through here so track() has one handle it can cancel (see the comment
    // at processTimer's declaration for why that matters).
    _scheduleProcess(delay) {
      const self = this;
      processTimer = setTimeout(function() {
        processTimer = null;
        self._processQueue();
      }, delay);
    }

    async _processQueue() {
      if (eventQueue.length === 0) {
        isProcessing = false;
        settleDrain();
        return;
      }

      isProcessing = true;

      const minInterval = 1000 / LIMITS.maxRequestsPerSecond;
      const wait = minInterval - (Date.now() - lastRequestTime);
      if (wait > 0) {
        this._scheduleProcess(wait);
        return; // isProcessing stays true: a timer is pending
      }

      const sendIndex = findSendableIndex();
      if (sendIndex === -1) {
        // Every key currently queued is parked behind its own wait:
        // Retry-After or backoff, notBeforeByKey does not distinguish once
        // set. Sleep until the EARLIEST one clears, not the head's: the
        // head is just whichever item happens to sit at index 0, not
        // necessarily the key closest to being allowed to send again.
        let earliest = Infinity;
        eventQueue.forEach(function(item) {
          const until = notBeforeByKey.get(item.key);
          if (typeof until === 'number' && until < earliest) earliest = until;
        });
        this._scheduleProcess(Math.max(minInterval, earliest - Date.now()));
        return; // isProcessing stays true: a timer is pending
      }

      const batch = takeBatch(LIMITS.maxBatchSize, sendIndex);
      lastRequestTime = Date.now();
      inFlightItems = batch.items;
      inFlightKey = batch.key;

      const batchBytes = batch.items.reduce(function(sum, item) { return sum + item.size; }, 0);
      debugLog('sending batch:', batch.items.length, 'event(s),', batchBytes, 'bytes, key', redactKey(batch.key));

      try {
        inFlight = this._sendEvents(batch.key, payloadOf(batch.items));
        await inFlight;
        failuresByKey.delete(batch.key);
        notBeforeByKey.delete(batch.key);
      } catch (error) {
        console.error('[CustomerCatalyst] Failed to send events:', error.message);

        const outcome = classifyError(error);

        if (outcome === 'fatal') {
          console.error('[CustomerCatalyst] Fatal error detected. Stopping SDK for this API key.');
          // Only this key's events are discarded; another instance on the page
          // may be sending under a key that is perfectly healthy.
          //
          // Pass the in-flight count ONLY if the batch is still on the wire. If
          // the page was hidden during the request, sendPending() has already
          // taken these items back: either folding them into the queue, where
          // stopKey's own filter will count them, or sending them by beacon, in
          // which case they were not lost at all. Both cases clear inFlightItems,
          // so it is the discriminator: counting batch.items unconditionally
          // would double-count the first and invent losses in the second.
          stopKey(batch.key, inFlightItems.length > 0 ? batch.items.length : 0);
          inFlight = null;
          inFlightKey = null;
          inFlightItems = [];

          // Another key's events may still be queued behind this one; stopping
          // one organisation must not strand another's.
          if (eventQueue.length > 0) {
            this._scheduleProcess(minInterval);
          } else {
            isProcessing = false;
            settleDrain();
          }
          return;
        }

        if (outcome === 'drop') {
          recordDrop(batch.key, batch.items.length);
          console.error('[CustomerCatalyst] Server rejected the batch, dropping ' +
            batch.items.length + ' event(s) and continuing');
          // Not the key's fault, so no backoff: the next batch may be fine and
          // there is no reason to slow it down.
          failuresByKey.delete(batch.key);
        } else {
          const failures = (failuresByKey.get(batch.key) || 0) + 1;
          failuresByKey.set(batch.key, failures);

          // This key must not send again before T. Compute T here, at the
          // moment the failure that earns it happens, and persist it in
          // notBeforeByKey, not just as the delay of the setTimeout that
          // paces the next _processQueue() call. A wait that exists only as
          // a timer argument is invisible to findSendableIndex and to a
          // second track() call arriving mid-wait, which is exactly the gap
          // that used to let ordinary traffic collapse another key's backoff
          // (see the comment at notBeforeByKey's declaration).
          //
          // Set from the server's Retry-After when it gave one (a 429 with a
          // parseable value); that is more authoritative than a guess this
          // module makes up. Otherwise fall back to the same equal-jitter
          // exponential schedule this module has always used: every tab
          // computing the same deterministic delay from the same failure
          // count would retry in lockstep and re-hammer a server that is
          // trying to recover. Half of `temp` is a guaranteed floor: full
          // jitter (0..temp) trades that floor for a bit more spread, not
          // worth it here, and the result never exceeds `temp`.
          if (error.retryAfterMs) {
            notBeforeByKey.set(batch.key, Date.now() + error.retryAfterMs);
            debugLog('retry-after for', redactKey(batch.key) + ':', error.retryAfterMs + 'ms');
          } else {
            const temp = Math.min(LIMITS.maxBackoffMs, minInterval * Math.pow(2, failures));
            const delay = temp / 2 + Math.random() * (temp / 2);
            notBeforeByKey.set(batch.key, Date.now() + delay);
            debugLog('backing off for', redactKey(batch.key) + ':', Math.round(delay) + 'ms (failure #' + failures + ')');
          }

          // A batch that can never succeed (a permanently unreachable endpoint,
          // or a server reporting failure on every attempt) would otherwise cycle
          // at the backoff cap for as long as the tab stays open.
          const retryable = [];
          let exhausted = 0;
          batch.items.forEach(function(item) {
            item.attempts = (item.attempts || 0) + 1;
            if (item.attempts >= LIMITS.maxAttempts) exhausted++;
            else retryable.push(item);
          });

          if (exhausted > 0) {
            recordDrop(batch.key, exhausted);
            console.error('[CustomerCatalyst] Giving up on ' + exhausted + ' event(s) after ' +
              LIMITS.maxAttempts + ' attempts');
          }
          if (retryable.length > 0) {
            console.warn('[CustomerCatalyst] Retryable error. Events will be retried.');
          }

          // Back of the queue, not the front. Re-claiming the front meant a key
          // whose endpoint was failing held position zero on every retry forever,
          // starving every other key on the page and eventually pushing their
          // events out against the shared queue cap.
          eventQueue = eventQueue.concat(retryable);

          // track() caps the queue on the way in, but a re-queue bypasses that
          // check: without this the cap can be exceeded by a batch's worth.
          // Never trim more than we just appended: the re-queued items sit at the
          // tail and all belong to batch.key, so capping at retryable.length keeps
          // the drop inside this organisation. Taking the whole overflow could eat
          // another key's backlog while reporting the loss against this one: the
          // queue can be over cap from a path other than this concat (sendPending
          // merges the in-flight batch back to the front on tab hide).
          const over = Math.min(eventQueue.length - LIMITS.maxQueueLength, retryable.length);
          if (over > 0) {
            eventQueue.length = eventQueue.length - over;
            recordDrop(batch.key, over);
            console.warn('[CustomerCatalyst] Queue is full, dropped ' + over + ' re-queued event(s)');
          }
        }
      } finally {
        inFlight = null;
        inFlightKey = null;
        inFlightItems = [];
      }

      if (eventQueue.length > 0) {
        // The real wait for whichever key just failed already lives in
        // notBeforeByKey, set above. This wakeup only has to be soon enough
        // to notice a key clearing (never long enough to guarantee it), so
        // it always just uses minInterval: findSendableIndex, at the top of
        // this function, skips a parked key for a sendable one, and the
        // all-parked branch re-sleeps until the earliest real expiry if
        // nothing is sendable yet. Re-deriving a second, approximate delay
        // here from whichever key happens to sit at eventQueue[0] would be
        // exactly the two-mechanisms bug this file used to have: one
        // persisted wait, read from one place, is the whole fix.
        this._scheduleProcess(minInterval);
      } else {
        isProcessing = false;
        settleDrain();
      }
    }

    async _sendEvents(apiKey, events) {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ p_api_key: apiKey, p_events: events })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(function() { return ''; });
        const error = new Error('API Error ' + response.status + ': ' + errorText);
        error.status = response.status;

        // Retry-After is not in this endpoint's Access-Control-Expose-Headers
        // (verified against the live response), so response.headers.get
        // returns null in a browser: always, not intermittently. Trying it
        // first costs one line, works for any non-browser caller of this same
        // file, and starts working for free if the expose list ever changes.
        // The real signal is retry_after_seconds in the 429 body, which the
        // RPC returns for exactly this reason.
        const retryAfterMs = parseRetryAfter(response, errorText);
        if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;

        throw error;
      }

      const result = await response.json().catch(function() { return null; });

      // Belt and braces: if the server ever reports failure with a 200, treat it
      // as retryable rather than assuming the events landed.
      if (result && result.success === false) {
        throw new Error('Server reported failure: ' + (result.error || 'unknown'));
      }

      if (result) {
        debugLog('server response for', redactKey(apiKey) + ':', 'received', result.received,
          'accepted', result.accepted, 'inserted', result.inserted,
          'duplicates', result.duplicates, 'rejected', result.rejected);
      }

      // The server reports what it stored. Surfacing a mismatch is what turns
      // silent data loss into something someone can actually notice.
      if (result && result.rejected > 0) {
        console.warn('[CustomerCatalyst] Server rejected ' + result.rejected +
          ' of ' + result.received + ' event(s) as invalid');
      }

      return result;
    }

    async flush() {
      const self = this;

      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped. Cannot flush.');
        return;
      }

      // Only wait on this key's work. Blocking on an unrelated organisation's
      // traffic would couple two instances' latency for no reason.
      const mine = eventQueue.some(function(item) { return item.key === self.apiKey; });
      if (!mine && inFlightKey !== self.apiKey) return;

      // A pending linger timer is a deliberate delay, not work in progress:
      // flush() exists for exactly the moment (a page navigating away) that
      // cannot afford to wait it out, so cancel it and go straight to sending.
      if (lingerTimer !== null) {
        clearTimeout(lingerTimer);
        lingerTimer = null;
        this._processQueue();
      } else if (!isProcessing) {
        // Waits for the drain loop rather than sending in parallel with it.
        // Sending here too would bypass the rate limit and, worse, two senders
        // sharing one in-flight slot let flush() return while a request it never
        // knew about was still on the wire.
        this._processQueue();
      }

      await new Promise(function(resolve) {
        let settled = false;
        const finish = function() {
          if (settled) return;
          settled = true;
          resolve();
        };
        drainWaiters.push(finish);
        // A permanently failing endpoint must not hold up a navigation forever.
        setTimeout(finish, LIMITS.maxFlushWaitMs);
      });
    }

    restart() {
      stoppedKeys.delete(this.apiKey);
      failuresByKey.delete(this.apiKey);
      if (eventQueue.length > 0 && !isProcessing) {
        this._processQueue();
      }
    }
  }

  window.CustomerCatalyst = CustomerCatalyst;

  // One flag, one log helper. LIMITS is deliberately not runtime-mutable
  // (see the comment at its declaration), but debug is, on purpose: flipping
  // it only changes what the SDK prints, never what it does. That is exactly
  // why nothing it prints may be the raw API key. debug is a public mutable
  // static, so any script sharing the customer's page can set
  // window.CustomerCatalyst.debug = true and read the console, for every
  // organisation whose key ever crosses this file, not just its own.
  CustomerCatalyst.debug = false;

  // Last 4 characters, never the key itself (see the comment above). Enough
  // to tell two keys apart in a multi-instance debug session, nowhere near
  // enough to reconstruct one.
  function redactKey(key) {
    return typeof key === 'string' && key.length > 4 ? '…' + key.slice(-4) : '(redacted)';
  }

  function debugLog() {
    if (!CustomerCatalyst.debug) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('[CustomerCatalyst]');
    (console.debug || console.log).apply(console, args);
  }

  // Reads the org key from a <script api-key="..."> tag: api-key, NOT
  // data-api-key. There is exactly one key, the same value the constructor
  // takes and the RPC sends as p_api_key; no second key concept to invent.
  // currentScript is null once the script has finished executing in some
  // load orders, so querySelector is the fallback. Both are optional DOM
  // APIs, so every access is typeof-guarded: an environment missing them
  // entirely (this file's own test harness, deliberately) must no-op here,
  // not throw: a throw at load time would take the rest of the file down
  // with it.
  //
  // ponytail: the querySelector fallback takes the FIRST script[api-key] tag
  // in the DOM, which need not be this one, if more than one is present AND
  // currentScript is unavailable (both already rare on their own). The
  // shipped basename is always customercatalyst.js (see CLAUDE.md: build.sh
  // only ever produces dist/customercatalyst.js and dist/dev/customercatalyst.js;
  // the other filenames in this working tree are gitignored local scratch
  // copies, not shipped builds), so matching on src would be a real option;
  // left alone instead because document.currentScript is reliable for the
  // normal case (a synchronous, non-deferred script tag), and this fallback
  // only matters for the rare load order where it's already null.
  CustomerCatalyst.init = function() {
    // instanceof, not truthiness. A script that runs before this one cannot
    // construct a real CustomerCatalyst (the class does not exist in its
    // scope yet), so a planted `window.customercatalyst` with lookalike
    // identify()/track() methods fails this check and is replaced, instead
    // of silently absorbing every customercatalyst.track() call for the rest
    // of the page's life. A genuine prior instance (this file loaded twice,
    // or a caller who built one with `new CustomerCatalyst()` themselves)
    // still short-circuits here.
    if (window.customercatalyst instanceof CustomerCatalyst) return window.customercatalyst;

    if (typeof document === 'undefined') return null;
    const script = document.currentScript ||
      (typeof document.querySelector === 'function' ? document.querySelector('script[api-key]') : null);
    if (!script) return null;

    const apiKey = script.getAttribute('api-key');
    // .trim() catches a whitespace-only attribute, not just an absent or
    // empty one: either would otherwise construct a live instance whose
    // every send fails against a key that was never going to work.
    if (!apiKey || !apiKey.trim()) return null;

    if (script.getAttribute('debug') !== null) CustomerCatalyst.debug = true;

    // Reaching here means something was at this name and it was NOT one of our
    // instances (the instanceof check above already returned for that case), so
    // it is either a planted lookalike (which must be replaced, that is the
    // whole point of the check) or a customer whose own page happens to use
    // this identifier. Replacing is right for the first and unavoidable for the
    // second, but the second deserves to be told rather than silently broken:
    // their `customercatalyst` stops being theirs and nothing else would say so.
    // Unconditional, not debugLog: an integration error nobody has turned
    // debugging on to find is exactly the one that needs to speak up.
    if (typeof window.customercatalyst !== 'undefined') {
      console.warn('[CustomerCatalyst] window.customercatalyst was already in use on this ' +
        'page and has been replaced. If that name is yours, remove the api-key attribute ' +
        'and construct the SDK manually instead: var mySdk = new CustomerCatalyst(key).');
    }

    window.customercatalyst = new CustomerCatalyst(apiKey);
    debugLog('auto-initialised from script tag for', redactKey(apiKey));
    return window.customercatalyst;
  };

  CustomerCatalyst.init();

  // Last chance to save what is still queued. 'hidden' fires on tab switch, app
  // switch, screen lock and close; 'beforeunload' misses most of those,
  // especially on mobile, which is why it is not used.
  function sendPending() {
    if (!navigator.sendBeacon) return;

    // The in-flight batch is already out of the queue and its request dies with
    // the page, so fold it back in. Resending is safe: the server deduplicates.
    if (inFlightItems.length > 0) {
      eventQueue = inFlightItems.concat(eventQueue);
      inFlightItems = [];
    }

    if (eventQueue.length === 0) return;

    // Form-encoded so no CORS preflight is needed: a page on its way out
    // cannot reliably complete one.
    let size = LIMITS.maxBatchSize;
    // Events a beacon cannot carry. Kept aside for the fetch path if the page
    // turns out to survive; lost with the rest of the queue if it does not,
    // which is already true of anything still queued at unload.
    const deferred = [];
    while (eventQueue.length > 0) {
      const batch = takeBatch(size);
      const body = new URLSearchParams({
        p_api_key: batch.key,
        p_events: JSON.stringify(payloadOf(batch.items))
      });

      // Form-encoding is what actually goes on the wire, and it percent-escapes
      // every { " : and , to three bytes; JSON roughly doubles. A batch sized
      // against the 28KB request limit becomes 50–70KB here, over the 64KB budget
      // the browser shares across every beacon on the page. Measuring the encoded
      // body means shrinking to fit directly, instead of learning it from two or
      // three refusals during the few moments a closing page still has.
      const encodedBytes = byteLength(body.toString());
      if (encodedBytes > LIMITS.maxBeaconBytes) {
        if (size > 1) {
          eventQueue = batch.items.concat(eventQueue);
          size = Math.max(1, Math.floor(size / 2));
          debugLog('beacon batch too large encoded (' + encodedBytes + ' bytes), halving size to', size);
          continue;
        }
        // One event that will not fit even on its own. Metadata of many short
        // key/value pairs encodes near the 3x ceiling, so an event comfortably
        // inside the 28KB request limit can land over this one. Sending it anyway
        // would claim most of the budget every other instance on the page is
        // trying to flush into at the same moment, and if the browser refused
        // it, the loop below abandons everything still queued, including other
        // organisations'.
        //
        // Set it aside rather than discard it: 'hidden' fires on tab switch as
        // well as on close, and a page that survives can still send this through
        // the fetch path, which only has to respect the 28KB limit it already
        // passes. Held in a local array, not put straight back, or takeBatch
        // would pick it up again on the next turn of this loop and never finish.
        debugLog('event unbeaconable even alone (' + encodedBytes + ' bytes), deferred to the fetch path');
        deferred.push.apply(deferred, batch.items);
        continue;
      }

      if (navigator.sendBeacon(BEACON_ENDPOINT, body)) {
        debugLog('beacon sent:', batch.items.length, 'event(s),', encodedBytes, 'bytes');
        // Grown back after a successful send. Left at whatever size a
        // previous shrink found, `size` would send the rest of a uniformly
        // large queue one event per beacon for the entire drain, burning
        // the shared page-wide beacon budget exactly when the page is
        // closing. Doubling rather than jumping straight back to
        // maxBatchSize avoids re-collapsing through the full halving ladder
        // on every batch if events stay large.
        size = Math.min(LIMITS.maxBatchSize, size * 2);
        continue;
      }

      // The browser's beacon budget is shared across all in-flight beacons, so
      // a refusal means "too big right now", not "never". Halve and retry
      // rather than abandoning everything still queued.
      eventQueue = batch.items.concat(eventQueue);
      if (size === 1) {
        console.warn('[CustomerCatalyst] Browser refused the final beacon, ' +
          eventQueue.length + ' event(s) could not be sent');
        break;
      }
      size = Math.max(1, Math.floor(size / 2));
      debugLog('beacon refused, halving size to', size);
    }

    // Restored after the loop, including on the break above, and at the front:
    // they are older than anything that arrives next.
    if (deferred.length > 0) eventQueue = deferred.concat(eventQueue);
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') sendPending();
  });
  window.addEventListener('pagehide', sendPending);


})(window);
