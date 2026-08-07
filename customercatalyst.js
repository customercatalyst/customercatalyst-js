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
    maxBatchSize: 50,       // server refuses more than 100 per call
    maxBatchBytes: 28000,   // server refuses over 32768; leave room for the envelope
    maxQueueLength: 1000,   // an unreachable endpoint must not grow memory forever
    maxBackoffMs: 30000,
    maxFlushWaitMs: 5000,   // flush() must never hang a page navigation
    maxFieldLength: 255     // server drops anything longer
  };

  // Queue state is module-level so that one page sending from two instances
  // still paces itself as a whole. Each item carries its own key, so events are
  // never sent under a different organisation's credentials.
  let eventQueue = [];
  let isProcessing = false;
  let inFlight = null;
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

  function stopKey(key) {
    stoppedKeys.add(key);
    failuresByKey.delete(key);
    eventQueue = eventQueue.filter(function(item) { return item.key !== key; });
  }

  function settleDrain() {
    const waiting = drainWaiters;
    drainWaiters = [];
    waiting.forEach(function(resolve) { resolve(); });
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

      const size = JSON.stringify(event).length + 1;
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

      try {
        inFlight = this._sendEvents(batch.key, payloadOf(batch.items));
        await inFlight;
        failuresByKey.delete(batch.key);
      } catch (error) {
        console.error('[CustomerCatalyst] Failed to send events:', error.message);

        if (this._isFatalError(error)) {
          console.error('[CustomerCatalyst] Fatal error detected. Stopping SDK for this API key.');
          // Only this key's events are discarded — another instance on the page
          // may be sending under a key that is perfectly healthy.
          stopKey(batch.key);
          inFlight = null;
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

        failuresByKey.set(batch.key, (failuresByKey.get(batch.key) || 0) + 1);
        console.warn('[CustomerCatalyst] Retryable error. Events will be retried.');
        // Back of the queue, not the front. Re-claiming the front meant a key
        // whose endpoint was failing held position zero on every retry forever,
        // starving every other key on the page and eventually pushing their
        // events out against the shared queue cap.
        eventQueue = eventQueue.concat(batch.items);
      } finally {
        inFlight = null;
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

    _isFatalError(error) {
      if (typeof error.status !== 'number') return false;
      // Throttling and request timeouts are the retryable 4xx — treating them
      // as fatal would discard the whole queue over a passing traffic spike.
      if (error.status === 408 || error.status === 429) return false;
      return error.status >= 400 && error.status < 500;
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
      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped. Cannot flush.');
        return;
      }

      if (eventQueue.length === 0 && !isProcessing) return;

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
    while (eventQueue.length > 0) {
      const batch = takeBatch(size);
      const body = new URLSearchParams({
        p_api_key: batch.key,
        p_events: JSON.stringify(payloadOf(batch.items))
      });

      if (navigator.sendBeacon(BEACON_ENDPOINT, body)) continue;

      // The browser's beacon budget is shared across all in-flight beacons, so
      // a refusal means "too big right now", not "never". Halve and retry
      // rather than abandoning everything still queued.
      eventQueue = batch.items.concat(eventQueue);
      if (size === 1) break;
      size = Math.max(1, Math.floor(size / 2));
    }
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') sendPending();
  });
  window.addEventListener('pagehide', sendPending);


})(window);
