(function(window) {
  'use strict';

  const SUPABASE_URL = 'https://xfjgmzwigomtfmaloeun.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_23PVXON8PjsWYOCpjtgrEQ_dJJTYRMj';
  const API_ENDPOINT = SUPABASE_URL + '/rest/v1/rpc/track_events';

  // A beacon cannot set headers, so the publishable key travels in the query
  // string instead. Same gateway auth, different carrier. The organisation key
  // never goes in a URL — it stays in the request body.
  const BEACON_ENDPOINT = API_ENDPOINT + '?apikey=' + encodeURIComponent(SUPABASE_PUBLISHABLE_KEY);

  const LIMITS = {
    maxRequestsPerSecond: 10,
    maxBatchSize: 50,       // half the server's 100, so a retry can never trip it
    maxBatchBytes: 28000,   // server refuses over 32768; leave room for the envelope
    maxBeaconBytes: 48000,  // form-encoded, against a 64KB budget shared page-wide
    maxQueueLength: 1000,   // an unreachable endpoint must not grow memory forever
    maxBackoffMs: 30000,
    maxAttempts: 10,        // a batch that keeps failing is dropped, not retried forever
    maxFlushWaitMs: 5000,   // flush() must never hang a page navigation
    maxFieldLength: 255     // server drops anything longer
  };

  // There is deliberately no way to override these at runtime. The suite needs
  // smaller values to prove retries terminate without waiting 81 seconds, and it
  // gets them by rewriting the literals above before evaluating this file — not
  // through any hook that ships. Both a mutable `CustomerCatalyst.LIMITS` and a
  // free `__ccTestLimits` identifier were tried and rejected: either lets a
  // script sharing the customer's page raise the rate and queue caps for every
  // organisation on it. A free identifier is not private — its scope chain ends
  // at the global object.

  // Queue state is module-level so that one page sending from two instances
  // still paces itself as a whole. Each item carries its own key, so events are
  // never sent under a different organisation's credentials.
  let eventQueue = [];
  let isProcessing = false;
  let inFlight = null;
  let inFlightKey = null;
  let inFlightItems = [];   // the batch on the wire — already out of the queue,
                            // so the beacon has to be told about it separately
  let lastRequestTime = 0;
  let drainWaiters = [];

  // Backoff is counted per key. A shared counter let one organisation's healthy
  // traffic reset the backoff another had earned from real failures.
  const failuresByKey = new Map();

  // Stopping is tracked per key, not per instance: two instances sharing one
  // queue must not be able to discard each other's events.
  const stoppedKeys = new Set();

  // Dropping a batch is quieter than stopping a key, which is the point — but a
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
    // Discarding the backlog is correct — a dead credential cannot send it — but
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
  // .length guard therefore passes payloads the server then refuses — and a
  // refusal used to stop the organisation's tracking outright.
  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function byteLength(str) {
    // No TextEncoder means a browser old enough that .length is the best
    // available guess. Degrading is right here; throwing on a customer's page
    // to protect a size estimate is not.
    return textEncoder ? textEncoder.encode(str).length : str.length;
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
  // value that cannot be serialised from throwing later inside the send loop —
  // which would jam the queue behind an event that can never leave it.
  function safeMetadata(metadata) {
    if (metadata === null || metadata === undefined) return null;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      console.warn('[CustomerCatalyst] metadata must be a plain object — ignoring it');
      return null;
    }
    try {
      JSON.stringify(metadata);
    } catch (e) {
      console.warn('[CustomerCatalyst] metadata could not be serialised — ignoring it');
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
      console.warn('[CustomerCatalyst] value must be a non-negative number — using 1 instead of', value);
      return 1;
    }
    return Math.round(value * 1000000) / 1000000;
  }

  // Takes only consecutive events belonging to one organisation, so a batch is
  // always sendable with a single key, and stops before the server's byte limit
  // — exceeding it returns a 400, which would otherwise look fatal.
  function takeBatch(limit) {
    const key = eventQueue[0].key;
    const items = [];
    let bytes = 2;

    while (items.length < limit && eventQueue.length > 0 && eventQueue[0].key === key) {
      const next = eventQueue[0];
      if (items.length > 0 && bytes + next.size > LIMITS.maxBatchBytes) break;
      bytes += next.size;
      items.push(eventQueue.shift());
    }

    return { key: key, items: items };
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
    // 200 body. Both can succeed later — but see maxAttempts: "later" is bounded.
    if (typeof status !== 'number') return 'retry';

    if (status === 401 || status === 403 || status === 404) return 'fatal';

    // Malformed, too large, or unprocessable. Retrying is pointless: the same
    // bytes will be refused again. The next batch may be perfectly fine.
    if (status === 400 || status === 413 || status === 422) return 'drop';

    // 408, 429, 5xx, and anything unrecognised. Unrecognised leans retry because
    // the attempt ceiling makes guessing wrong cheap, while dropping is final.
    return 'retry';
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

    // Dropping a batch keeps the SDK alive, which is right — but it is still
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
      if (options.customerId.length > LIMITS.maxFieldLength) {
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
      if (eventType.length > LIMITS.maxFieldLength) {
        throw new Error('eventType must be ' + LIMITS.maxFieldLength + ' characters or fewer');
      }

      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped due to fatal error. Cannot track events.');
        return;
      }

      if (eventQueue.length >= LIMITS.maxQueueLength) {
        console.warn('[CustomerCatalyst] Queue is full (' + LIMITS.maxQueueLength + ') — dropping event');
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
        console.warn('[CustomerCatalyst] Event is too large to send (' + size + ' bytes) — dropping it');
        return;
      }

      eventQueue.push({ key: this.apiKey, size: size, event: event });

      if (!isProcessing) {
        this._processQueue();
      }
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
        setTimeout(() => this._processQueue(), wait);
        return; // isProcessing stays true: a timer is pending
      }

      const batch = takeBatch(LIMITS.maxBatchSize);
      lastRequestTime = Date.now();
      inFlightItems = batch.items;
      inFlightKey = batch.key;

      try {
        inFlight = this._sendEvents(batch.key, payloadOf(batch.items));
        await inFlight;
        failuresByKey.delete(batch.key);
      } catch (error) {
        console.error('[CustomerCatalyst] Failed to send events:', error.message);

        const outcome = classifyError(error);

        if (outcome === 'fatal') {
          console.error('[CustomerCatalyst] Fatal error detected. Stopping SDK for this API key.');
          // Only this key's events are discarded — another instance on the page
          // may be sending under a key that is perfectly healthy.
          //
          // Pass the in-flight count ONLY if the batch is still on the wire. If
          // the page was hidden during the request, sendPending() has already
          // taken these items back — either folding them into the queue, where
          // stopKey's own filter will count them, or sending them by beacon, in
          // which case they were not lost at all. Both cases clear inFlightItems,
          // so it is the discriminator: counting batch.items unconditionally
          // would double-count the first and invent losses in the second.
          stopKey(batch.key, inFlightItems.length > 0 ? batch.items.length : 0);
          inFlight = null;
          inFlightKey = null;
          inFlightItems = [];

          // Another key's events may still be queued behind this one — stopping
          // one organisation must not strand another's.
          if (eventQueue.length > 0) {
            setTimeout(() => this._processQueue(), minInterval);
          } else {
            isProcessing = false;
            settleDrain();
          }
          return;
        }

        if (outcome === 'drop') {
          recordDrop(batch.key, batch.items.length);
          console.error('[CustomerCatalyst] Server rejected the batch — dropping ' +
            batch.items.length + ' event(s) and continuing');
          // Not the key's fault, so no backoff: the next batch may be fine and
          // there is no reason to slow it down.
          failuresByKey.delete(batch.key);
        } else {
          failuresByKey.set(batch.key, (failuresByKey.get(batch.key) || 0) + 1);

          // A batch that can never succeed — a permanently unreachable endpoint,
          // or a server reporting failure on every attempt — would otherwise cycle
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
          // check — without this the cap can be exceeded by a batch's worth.
          // Never trim more than we just appended: the re-queued items sit at the
          // tail and all belong to batch.key, so capping at retryable.length keeps
          // the drop inside this organisation. Taking the whole overflow could eat
          // another key's backlog while reporting the loss against this one — the
          // queue can be over cap from a path other than this concat (sendPending
          // merges the in-flight batch back to the front on tab hide).
          const over = Math.min(eventQueue.length - LIMITS.maxQueueLength, retryable.length);
          if (over > 0) {
            eventQueue.length = eventQueue.length - over;
            recordDrop(batch.key, over);
            console.warn('[CustomerCatalyst] Queue is full — dropped ' + over + ' re-queued event(s)');
          }
        }
      } finally {
        inFlight = null;
        inFlightKey = null;
        inFlightItems = [];
      }

      if (eventQueue.length > 0) {
        // Backing off matters during an outage: without it every open tab
        // retries ten times a second for as long as the endpoint is down.
        // Paced by whichever key is next in line, not by a shared counter.
        const failures = failuresByKey.get(eventQueue[0].key) || 0;
        const delay = failures > 0
          ? Math.min(LIMITS.maxBackoffMs, minInterval * Math.pow(2, failures))
          : minInterval;
        setTimeout(() => this._processQueue(), delay);
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
        throw error;
      }

      const result = await response.json().catch(function() { return null; });

      // Belt and braces: if the server ever reports failure with a 200, treat it
      // as retryable rather than assuming the events landed.
      if (result && result.success === false) {
        throw new Error('Server reported failure: ' + (result.error || 'unknown'));
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

      // Waits for the drain loop rather than sending in parallel with it.
      // Sending here too would bypass the rate limit and, worse, two senders
      // sharing one in-flight slot let flush() return while a request it never
      // knew about was still on the wire.
      if (!isProcessing) this._processQueue();

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

    // Form-encoded so no CORS preflight is needed — a page on its way out
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
      // every { " : and , to three bytes — JSON roughly doubles. A batch sized
      // against the 28KB request limit becomes 50–70KB here, over the 64KB budget
      // the browser shares across every beacon on the page. Measuring the encoded
      // body means shrinking to fit directly, instead of learning it from two or
      // three refusals during the few moments a closing page still has.
      if (byteLength(body.toString()) > LIMITS.maxBeaconBytes) {
        if (size > 1) {
          eventQueue = batch.items.concat(eventQueue);
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        // One event that will not fit even on its own. Metadata of many short
        // key/value pairs encodes near the 3x ceiling, so an event comfortably
        // inside the 28KB request limit can land over this one. Sending it anyway
        // would claim most of the budget every other instance on the page is
        // trying to flush into at the same moment — and if the browser refused
        // it, the loop below abandons everything still queued, including other
        // organisations'.
        //
        // Set it aside rather than discard it: 'hidden' fires on tab switch as
        // well as on close, and a page that survives can still send this through
        // the fetch path, which only has to respect the 28KB limit it already
        // passes. Held in a local array, not put straight back, or takeBatch
        // would pick it up again on the next turn of this loop and never finish.
        deferred.push.apply(deferred, batch.items);
        continue;
      }

      if (navigator.sendBeacon(BEACON_ENDPOINT, body)) continue;

      // The browser's beacon budget is shared across all in-flight beacons, so
      // a refusal means "too big right now", not "never". Halve and retry
      // rather than abandoning everything still queued.
      eventQueue = batch.items.concat(eventQueue);
      if (size === 1) {
        console.warn('[CustomerCatalyst] Browser refused the final beacon — ' +
          eventQueue.length + ' event(s) could not be sent');
        break;
      }
      size = Math.max(1, Math.floor(size / 2));
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
