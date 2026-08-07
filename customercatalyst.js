(function(window) {
  'use strict';

  const SUPABASE_URL = 'https://xfjgmzwigomtfmaloeun.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_23PVXON8PjsWYOCpjtgrEQ_dJJTYRMj';
  const API_ENDPOINT = SUPABASE_URL + '/rest/v1/rpc/track_events';

  // The beacon cannot set headers, so the publishable key travels in the query
  // string instead. Same gateway auth, different carrier.
  const BEACON_ENDPOINT = API_ENDPOINT + '?apikey=' + encodeURIComponent(SUPABASE_PUBLISHABLE_KEY);

  const RATE_LIMIT = {
    maxRequestsPerSecond: 10,
    maxBatchSize: 50 // server rejects more than 100 per call
  };

  let eventQueue = [];
  let isProcessing = false;
  let activeApiKey = null;
  let lastRequestTime = 0;

  class CustomerCatalyst {
    constructor(apiKey) {
      if (!apiKey) {
        throw new Error('API key is required');
      }
      
      this.apiKey = apiKey;
      activeApiKey = apiKey; // the page-hidden beacon runs outside any instance
      this.customerId = null;
      this.customerName = null;
      this.isStopped = false; // Flag to stop processing on fatal errors
      
      console.log('[CustomerCatalyst] SDK initialized');
    }

    identify(options) {
      if (!options || !options.customerId) {
        throw new Error('customerId is required');
      }
      
      this.customerId = options.customerId;
      this.customerName = options.customerName || null;
      
      console.log('[CustomerCatalyst] Customer identified:', this.customerName || this.customerId);
    }

    track(eventType, value, metadata) {
      if (!this.customerId) {
        throw new Error('Must call identify() before tracking events');
      }

      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped due to fatal error. Cannot track events.');
        return;
      }

      // The API key is sent once per request now, not once per event.
      const event = {
        customer_id: this.customerId,
        event_type: eventType,
        value: typeof value === 'number' ? value : 1,
        metadata: metadata || null
      };

      this._addToQueue(event);
    }

    _addToQueue(event) {
      eventQueue.push(event);
      
      if (!isProcessing && !this.isStopped) {
        this._processQueue();
      }
    }

    async _processQueue() {
      if (eventQueue.length === 0 || this.isStopped) {
        isProcessing = false;
        return;
      }

      isProcessing = true;

      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      const minInterval = 1000 / RATE_LIMIT.maxRequestsPerSecond;

      if (timeSinceLastRequest < minInterval) {
        setTimeout(() => this._processQueue(), minInterval - timeSinceLastRequest);
        return;
      }

      const batch = eventQueue.splice(0, RATE_LIMIT.maxBatchSize);
      lastRequestTime = Date.now();

      try {
        await this._sendEvents(batch);
        console.log('[CustomerCatalyst] Successfully tracked', batch.length, 'event(s)');
      } catch (error) {
        console.error('[CustomerCatalyst] Failed to send events:', error);
        
        // Check if this is a fatal error (non-retryable)
        if (this._isFatalError(error)) {
          console.error('[CustomerCatalyst] Fatal error detected. Stopping SDK.', error.message);
          this.isStopped = true;
          eventQueue = []; // Clear the queue
          isProcessing = false;
          return; // Stop processing
        }
        
        // For retryable errors, put events back in queue
        console.warn('[CustomerCatalyst] Retryable error. Events will be retried.');
        eventQueue.unshift(...batch);
      }

      if (eventQueue.length > 0 && !this.isStopped) {
        setTimeout(() => this._processQueue(), minInterval);
      } else {
        isProcessing = false;
      }
    }

    _isFatalError(error) {
      // A 4xx means the request itself is wrong — bad key, bad payload, missing
      // function — and retrying cannot help. 5xx and network failures are
      // transient, so those keep their retry.
      if (typeof error.status === 'number') {
        return error.status >= 400 && error.status < 500;
      }
      return false;
    }

    async _sendEvents(events) {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ p_api_key: this.apiKey, p_events: events })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error('API Error: ' + errorText);
        error.status = response.status; // Attach status code
        throw error;
      }

      // The server reports what it actually stored. Comparing it against what we
      // sent is what turns silent data loss into a visible warning.
      const result = await response.json().catch(function () { return null; });
      if (result && typeof result.inserted === 'number' && result.inserted !== events.length) {
        console.warn('[CustomerCatalyst] Sent ' + events.length +
          ' event(s) but the server stored ' + result.inserted);
      }
    }

    async flush() {
      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped. Cannot flush.');
        return;
      }

      if (eventQueue.length === 0) return;

      console.log('[CustomerCatalyst] Flushing', eventQueue.length, 'queued event(s)');

      // Deliberately bypasses the pacing: flush() is an explicit "send it now",
      // and callers await it before navigating away. Drains fully, unlike a
      // single _processQueue() pass, which only handles one batch.
      while (eventQueue.length > 0 && !this.isStopped) {
        const batch = eventQueue.splice(0, RATE_LIMIT.maxBatchSize);
        try {
          await this._sendEvents(batch);
          console.log('[CustomerCatalyst] Flushed', batch.length, 'event(s)');
        } catch (error) {
          if (this._isFatalError(error)) {
            console.error('[CustomerCatalyst] Fatal error during flush. Stopping SDK.', error.message);
            this.isStopped = true;
            eventQueue = [];
          } else {
            eventQueue.unshift(...batch);
          }
          throw error;
        }
      }
    }

    // Method to restart SDK after fixing the issue
    restart() {
      console.log('[CustomerCatalyst] Restarting SDK...');
      this.isStopped = false;
      eventQueue = [];
      isProcessing = false;
    }
  }

  window.CustomerCatalyst = CustomerCatalyst;

  // Last chance to save whatever is still queued. Fires on tab switch, app
  // switch, screen lock and close — 'beforeunload' misses most of those,
  // especially on mobile, which is why it is not used here.
  function sendPending() {
    if (!activeApiKey || eventQueue.length === 0 || !navigator.sendBeacon) return;

    // Form-encoded so the browser needs no CORS preflight, which it cannot do
    // reliably while the page is going away. 100 is the server's per-call cap.
    while (eventQueue.length > 0) {
      const batch = eventQueue.splice(0, 100);
      const body = new URLSearchParams({
        p_api_key: activeApiKey,
        p_events: JSON.stringify(batch)
      });
      if (!navigator.sendBeacon(BEACON_ENDPOINT, body)) {
        // Refused (usually the ~64KB payload limit) — keep them for a retry.
        eventQueue.unshift(...batch);
        break;
      }
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendPending();
  });
  window.addEventListener('pagehide', sendPending);

  console.log('[CustomerCatalyst] SDK loaded and ready');

})(window);
