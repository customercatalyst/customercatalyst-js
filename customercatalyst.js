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
    maxBatchSize: 50,      // server refuses more than 100 per call
    maxBeaconBatch: 50,
    maxQueueLength: 1000,  // an unreachable endpoint must not grow memory forever
    maxBackoffMs: 30000
  };

  // Queue state is module-level so that one page sending from two instances
  // still paces itself as a whole. Each item carries its own key, so events are
  // never sent under a different organisation's credentials.
  let eventQueue = [];
  let isProcessing = false;
  let inFlight = null;
  let lastRequestTime = 0;
  let consecutiveFailures = 0;

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

  // Takes only consecutive events belonging to one organisation, so a batch is
  // always sendable with a single key.
  function takeBatch(limit) {
    const key = eventQueue[0].key;
    const items = [];
    while (items.length < limit && eventQueue.length > 0 && eventQueue[0].key === key) {
      items.push(eventQueue.shift());
    }
    return { key: key, items: items };
  }

  function payloadOf(batch) {
    return batch.items.map(function(item) { return item.event; });
  }

  class CustomerCatalyst {
    constructor(apiKey) {
      if (typeof apiKey !== 'string' || apiKey === '') {
        throw new Error('API key is required');
      }

      this.apiKey = apiKey;
      this.customerId = null;
      this.customerName = null;
      this.isStopped = false;

      console.log('[CustomerCatalyst] SDK initialized');
    }

    identify(options) {
      if (!options || typeof options.customerId !== 'string' || options.customerId === '') {
        throw new Error('customerId is required and must be a string');
      }

      this.customerId = options.customerId;
      this.customerName = options.customerName || null;

      console.log('[CustomerCatalyst] Customer identified:', this.customerName || this.customerId);
    }

    track(eventType, value, metadata) {
      if (!this.customerId) {
        throw new Error('Must call identify() before tracking events');
      }

      if (typeof eventType !== 'string' || eventType.trim() === '') {
        throw new Error('eventType is required and must be a non-empty string');
      }

      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped due to fatal error. Cannot track events.');
        return;
      }

      if (eventQueue.length >= LIMITS.maxQueueLength) {
        console.warn('[CustomerCatalyst] Queue is full (' + LIMITS.maxQueueLength + ') — dropping event');
        return;
      }

      eventQueue.push({
        key: this.apiKey,
        event: {
          // Lets the server recognise a resent event instead of counting it
          // twice. Scores are sums, so a duplicate is as wrong as a loss.
          event_id: newEventId(),
          customer_id: this.customerId,
          event_type: eventType,
          value: (typeof value === 'number' && isFinite(value)) ? value : 1,
          metadata: safeMetadata(metadata)
        }
      });

      if (!isProcessing && !this.isStopped) {
        this._processQueue();
      }
    }

    async _processQueue() {
      if (this.isStopped || eventQueue.length === 0) {
        isProcessing = false;
        return;
      }

      isProcessing = true;

      const minInterval = 1000 / LIMITS.maxRequestsPerSecond;
      const wait = minInterval - (Date.now() - lastRequestTime);
      if (wait > 0) {
        setTimeout(() => this._processQueue(), wait);
        return;
      }

      const batch = takeBatch(LIMITS.maxBatchSize);
      lastRequestTime = Date.now();

      try {
        inFlight = this._sendEvents(batch.key, payloadOf(batch));
        await inFlight;
        consecutiveFailures = 0;
        console.log('[CustomerCatalyst] Successfully tracked', batch.items.length, 'event(s)');
      } catch (error) {
        console.error('[CustomerCatalyst] Failed to send events:', error.message);

        if (this._isFatalError(error)) {
          console.error('[CustomerCatalyst] Fatal error detected. Stopping SDK.');
          this.isStopped = true;
          eventQueue = [];
          isProcessing = false;
          inFlight = null;
          return;
        }

        consecutiveFailures++;
        console.warn('[CustomerCatalyst] Retryable error. Events will be retried.');
        eventQueue = batch.items.concat(eventQueue);
      } finally {
        inFlight = null;
      }

      if (eventQueue.length > 0 && !this.isStopped) {
        // Backing off matters during an outage: without it every open tab
        // retries ten times a second for as long as the endpoint is down.
        const delay = consecutiveFailures > 0
          ? Math.min(LIMITS.maxBackoffMs, minInterval * Math.pow(2, consecutiveFailures))
          : minInterval;
        setTimeout(() => this._processQueue(), delay);
      } else {
        isProcessing = false;
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

      // The server reports what it stored. Surfacing a mismatch is what turns
      // silent data loss into something someone can actually notice.
      const result = await response.json().catch(function() { return null; });
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

      // Waits on the in-flight batch too. That batch has already left the queue,
      // so checking the queue alone would report "done" with events still on
      // the wire — which is exactly what callers use flush() to avoid.
      while (inFlight || eventQueue.length > 0) {
        if (inFlight) {
          await inFlight.catch(function() {});
          continue;
        }

        const batch = takeBatch(LIMITS.maxBatchSize);
        try {
          inFlight = this._sendEvents(batch.key, payloadOf(batch));
          await inFlight;
          console.log('[CustomerCatalyst] Flushed', batch.items.length, 'event(s)');
        } catch (error) {
          if (this._isFatalError(error)) {
            console.error('[CustomerCatalyst] Fatal error during flush. Stopping SDK.');
            this.isStopped = true;
            eventQueue = [];
          } else {
            eventQueue = batch.items.concat(eventQueue);
          }
          throw error;
        } finally {
          inFlight = null;
        }
      }
    }

    restart() {
      console.log('[CustomerCatalyst] Restarting SDK...');
      this.isStopped = false;
      consecutiveFailures = 0;
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
    if (eventQueue.length === 0 || !navigator.sendBeacon) return;

    // Form-encoded so no CORS preflight is needed — a page on its way out
    // cannot reliably complete one.
    let size = LIMITS.maxBeaconBatch;
    while (eventQueue.length > 0) {
      const batch = takeBatch(size);
      const body = new URLSearchParams({
        p_api_key: batch.key,
        p_events: JSON.stringify(payloadOf(batch))
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

  console.log('[CustomerCatalyst] SDK loaded and ready');

})(window);
