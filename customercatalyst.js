(function(window) {
  'use strict';

  const SUPABASE_URL = 'https://xfjgmzwigomtfmaloeun.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmamdtendpZ29tdGZtYWxvZXVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMyMzY3NjQsImV4cCI6MjA3ODgxMjc2NH0.WWU-x9fFvhsPBNG3QfhdqmGE2SgAHcoW0L3U_QMspgY';
  const API_ENDPOINT = SUPABASE_URL + '/rest/v1/rpc/track_event';

  const RATE_LIMIT = {
    maxRequestsPerSecond: 10,
    maxBatchSize: 10
  };

  let eventQueue = [];
  let isProcessing = false;
  let lastRequestTime = 0;

  class CustomerCatalyst {
    constructor(apiKey) {
      if (!apiKey) {
        throw new Error('API key is required');
      }
      
      this.apiKey = apiKey;
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

      const event = {
        p_api_key: this.apiKey,
        p_customer_id: this.customerId,
        p_event_type: eventType,
        p_value: typeof value === 'number' ? value : 1,
        p_metadata: metadata || null
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
      const errorMessage = error.message || '';
      
      // Fatal errors that should stop the SDK
      const fatalPatterns = [
        'Invalid API key',
        '401',
        '403',
        'Unauthorized',
        'Forbidden',
        'api_key column not found',
        'PGRST204'
      ];
      
      return fatalPatterns.some(pattern => 
        errorMessage.includes(pattern)
      );
    }

    async _sendEvents(events) {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(events.length === 1 ? events[0] : events)
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error('API Error: ' + errorText);
        error.status = response.status; // Attach status code
        throw error;
      }
    }

    async flush() {
      if (this.isStopped) {
        console.error('[CustomerCatalyst] SDK stopped. Cannot flush.');
        return;
      }
      
      if (eventQueue.length > 0) {
        console.log('[CustomerCatalyst] Flushing', eventQueue.length, 'queued event(s)');
        await this._processQueue();
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

  window.addEventListener('beforeunload', function() {
    if (eventQueue.length > 0) {
      const data = JSON.stringify(eventQueue);
      navigator.sendBeacon(API_ENDPOINT, data);
    }
  });

  console.log('[CustomerCatalyst] SDK loaded and ready');

})(window);
