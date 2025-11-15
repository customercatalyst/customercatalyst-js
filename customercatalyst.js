/**
 * CustomerCatalyst Usage Tracking SDK
 * Tracks customer usage events for your CustomerCatalyst dashboard
 * Version: 1.0.0
 */

(function(window) {
  'use strict';

  // Configuration
  const SUPABASE_URL = 'https://xfjgmzwigomtfmaloeun.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_23PVXON8PjsWVOCpjtgrEQ_dJJTYRMj';
  const API_ENDPOINT = SUPABASE_URL + '/rest/v1/usage_events';
  
  // Rate limiting
  const RATE_LIMIT = {
    maxRequestsPerSecond: 10,
    maxBatchSize: 100
  };

  // Event queue
  let eventQueue = [];
  let isProcessing = false;
  let lastRequestTime = 0;

  /**
   * CustomerCatalyst Tracking SDK
   */
  class CustomerCatalyst {
    constructor(apiKey) {
      if (!apiKey) {
        throw new Error('CustomerCatalyst: API key is required');
      }
      
      if (!apiKey.startsWith('org_')) {
        console.warn('CustomerCatalyst: API key should start with "org_"');
      }
      
      this.apiKey = apiKey;
      this.customerId = null;
      this.customerName = null;
      this.isInitialized = false;
      
      console.log('[CustomerCatalyst] SDK initialized');
    }

    identify(customerData) {
      if (!customerData || !customerData.customerId) {
        console.error('[CustomerCatalyst] identify() requires customerId');
        return;
      }

      this.customerId = customerData.customerId;
      this.customerName = customerData.customerName || null;
      this.isInitialized = true;

      console.log('[CustomerCatalyst] Customer identified:', this.customerName || this.customerId);
    }

    track(eventType, value, metadata) {
      if (!this.isInitialized) {
        console.error('[CustomerCatalyst] Must call identify() before tracking events');
        return;
      }

      if (!eventType || typeof eventType !== 'string') {
        console.error('[CustomerCatalyst] eventType must be a non-empty string');
        return;
      }

      const event = {
        api_key: this.apiKey,
        customer_id: this.customerId,
        event_type: eventType,
        value: typeof value === 'number' ? value : 1,
        metadata: metadata || null,
        created_at: new Date().toISOString()
      };

      this._addToQueue(event);
    }

    _addToQueue(event) {
      eventQueue.push(event);
      
      if (!isProcessing) {
        this._processQueue();
      }
    }

    async _processQueue() {
      if (eventQueue.length === 0) {
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
        eventQueue.unshift(...batch);
      }

      if (eventQueue.length > 0) {
        setTimeout(() => this._processQueue(), minInterval);
      } else {
        isProcessing = false;
      }
    }

    async _sendEvents(events) {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'x-api-key': this.apiKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(events.length === 1 ? events[0] : events)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error('API Error: ' + errorText);
      }
    }

    async flush() {
      if (eventQueue.length > 0) {
        console.log('[CustomerCatalyst] Flushing', eventQueue.length, 'queued event(s)');
        await this._processQueue();
      }
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
