# CustomerCatalyst JavaScript SDK

Track customer usage events and monitor product adoption with CustomerCatalyst's lightweight JavaScript tracking library.

## Installation

Add the following script tag to your HTML, preferably in the `<head>` section:

```html
<script src="https://cdn.customercatalyst.io/customercatalyst.js"></script>
```

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.customercatalyst.io/customercatalyst.js"></script>
</head>
<body>
  <script>
    // Initialize with your API key
    var cc = new CustomerCatalyst('YOUR_API_KEY');
    
    // Identify the customer
    cc.identify({
      customerId: 'CUSTOMER_ID',
      customerName: 'Acme Corporation' // optional
    });
    
    // Track events
    cc.track('login');
    cc.track('invoice_created', 1500);
    cc.track('report_generated', 1, { type: 'monthly' });
  </script>
</body>
</html>
```

## Getting Your Credentials

### API Key

1. Log in to your CustomerCatalyst dashboard
2. Navigate to **Settings → API Keys**
3. Copy your organization's API key (starts with `org_`)

### Customer IDs

1. Go to **Customers** in your dashboard
2. Each customer displays their unique ID
3. Export all customer IDs via **Customers → Export**

### Event Types

1. Go to **Metrics → Usage Metrics Settings**
2. Use the exact event names configured there

## API Reference

### `new CustomerCatalyst(apiKey)`

Initialize the SDK with your organization's API key.

```javascript
var cc = new CustomerCatalyst('org_abc123xyz');
```

**Parameters:**
- `apiKey` (string, required) - Your organization's API key from the dashboard

---

### `identify(customerData)`

Identify the current customer. Must be called before tracking events.

```javascript
cc.identify({
  customerId: 'customer_12345',      // required
  customerName: 'Acme Corporation'   // optional
});
```

**Parameters:**
- `customerData` (object, required)
  - `customerId` (string, required) - Customer ID from your dashboard
  - `customerName` (string, optional) - Display name for the customer

---

### `track(eventType, value, metadata)`

Track a usage event.

```javascript
// Simple event
cc.track('login');

// Event with value
cc.track('purchase', 1500);

// Event with metadata
cc.track('export_report', 1, { format: 'pdf', pages: 24 });
```

**Parameters:**
- `eventType` (string, required) - Event name from Metrics → Usage Metrics Settings
- `value` (number, optional) - Numeric value, defaults to 1
- `metadata` (object, optional) - Additional event context as JSON

---

### `flush()`

Send everything still queued and wait for it to land (rarely needed — events
send on their own, and anything still queued is sent automatically when the page
is hidden or closed).

```javascript
await cc.flush();
```

Returns a promise. It resolves once the queue has drained, or after 5 seconds if
the server is unreachable, so it can never hold up a page navigation. Sending
stays rate limited, so a large queue takes a moment.

---

### `restart()`

Resume after a fatal error stopped the SDK. Only useful if the cause was
temporary — for a wrong API key, create a new instance with the correct key
instead, since the key is fixed when the instance is created.

```javascript
cc.restart();
```

## Examples

### Single Page Application

```javascript
var cc = new CustomerCatalyst('YOUR_API_KEY');
cc.identify({ customerId: 'CUSTOMER_ID' });

// Track throughout the application
cc.track('dashboard_viewed');
cc.track('invoice_created', 1500);
cc.track('settings_updated');
```

### Multi-Page Website

```html
<!-- Include on every page -->
<script src="https://cdn.customercatalyst.io/customercatalyst.js"></script>
<script>
  var cc = new CustomerCatalyst('YOUR_API_KEY');
  cc.identify({ customerId: 'CUSTOMER_ID' });
  cc.track('page_viewed');
</script>
```

### Before Page Navigation

```javascript
logoutButton.addEventListener('click', function(e) {
  e.preventDefault();
  cc.track('logout');
  cc.flush().then(() => {
    window.location.href = '/logout';
  });
});
```

## Error Handling

The SDK automatically handles errors to prevent infinite retry loops.

### Fatal Errors (SDK Stops)

When these errors occur, the SDK stops sending for that API key:
- Invalid API key
- Authentication errors
- Anything else the server rejects as a bad request

```javascript
// SDK detects fatal error and stops
[CustomerCatalyst] Failed to send events: API Error 400: Invalid API key
[CustomerCatalyst] Fatal error detected. Stopping SDK for this API key.

// Future track() calls are ignored
cc.track('event'); // Won't send
```

### Retryable Errors (SDK Auto-Retries)

The SDK automatically retries temporary errors, waiting longer after each
failure so a struggling server is not overwhelmed:
- Network timeouts
- Server errors
- Rate limiting (429) and request timeouts (408)

```javascript
[CustomerCatalyst] Failed to send events: Failed to fetch
[CustomerCatalyst] Retryable error. Events will be retried.
// Automatically retries ✅
```

### Restarting After Configuration Fix

```javascript
// Reinitialize with correct API key
var cc = new CustomerCatalyst('CORRECT_API_KEY');
cc.identify({ customerId: 'CUSTOMER_ID' });
// Events now send successfully ✅
```

## Best Practices

**✅ Do:**
- Call `identify()` once per user session
- Use exact event names from your dashboard
- Track meaningful business actions
- Use HTTPS on your website

**❌ Don't:**
- Call `identify()` before every `track()` call
- Create custom event names not in your dashboard
- Track personally identifiable information in metadata
- Hardcode customer IDs in your code

## Troubleshooting

**Events not appearing in dashboard?**

1. Verify your API key in **Settings → API Keys**
2. Confirm Customer ID exists in your **Customers** list
3. Check event types match **Metrics → Usage Metrics Settings**
4. Open browser console (F12) and check for errors
5. Wait 1-2 minutes for events to process

**Common Errors:**

- **"Must call identify() before tracking events"**  
  Call `cc.identify()` before any `cc.track()` calls

- **"API Error 400: Invalid API key"**  
  Verify your API key starts with `org_` and is active

- **"eventType is required and must be a non-empty string"**  
  Pass a valid event name as the first parameter

- **"metadata must be a plain object — ignoring it"**  
  Pass an object, not an array or a string. The event is still recorded, without
  the metadata.

- **"value must be a non-negative number — using 1 instead of …"**  
  Values must be finite and zero or greater. The event is still recorded, with a
  value of 1.

- **"Server rejected N of M event(s) as invalid"**  
  A customer ID or event name was blank or longer than 255 characters. Those
  events were not stored.

## Limits

The SDK paces itself and batches automatically, so normal use never approaches these. They are
documented so you know what happens at the edges.

| Limit | Value | What happens if exceeded |
|---|---|---|
| Events per organization | 50,000 per hour | Further events are refused until the next hour. The SDK treats this as temporary and retries. |
| Events per `track()` call | always 1 | — |
| `customerId` length | 255 characters | `identify()` throws. |
| `eventType` length | 255 characters | `track()` throws. |
| `value` | 0 or greater, up to 12 digits and 6 decimals | Stored as `1`, with a console warning. |
| Single event size | About 28 KB, including `metadata` | The event is dropped with a warning. Batches are split to stay under this. |
| Queued events | 1,000 | Further events are dropped with a warning until the queue drains. |

### How events are counted

One `track()` call is one event, whatever `value` you pass. `value` is the quantity recorded against
that event, not a multiplier on it:

```javascript
cc.track('invoice_created', 50);   // 1 event, contributes 50
```

Batching does not change this. The SDK groups events into fewer network requests for efficiency, but
50 batched events are still 50 events.

Since metrics are totalled from `value`, recording a quantity once is equivalent to recording it
piece by piece — and far cheaper:

```javascript
// Same result. The first is one event, the second is fifty.
cc.track('invoices_created', 50);
for (var i = 0; i < 50; i++) cc.track('invoices_created');
```

Prefer the first whenever you already know the quantity. It uses a fraction of your hourly allowance
and far less of your users' bandwidth.

Sending is capped at 10 requests per second, and events are batched, so a burst of activity is sent
in a few requests rather than hundreds.

If the server rejects individual events as invalid, the SDK reports it:

```
[CustomerCatalyst] Server rejected 2 of 50 event(s) as invalid
```

That means a `customerId` or `eventType` was blank or too long. The remaining events were stored.

## Browser Support

Works in all modern browsers:
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Opera (latest)

> Internet Explorer is not supported.

## Security

- **API Keys:** Safe for client-side use (write-only access)
- **HTTPS Required:** Always use HTTPS to protect data in transit
- **No PII:** Do not track personal information in metadata

## Support

Need help? Contact our support team:

- **Email:** support@customercatalyst.com
- **Dashboard:** Click "Help" in your CustomerCatalyst dashboard
- **Documentation:** [docs.customercatalyst.com](https://docs.customercatalyst.com)

## License

Proprietary - © 2025 CustomerCatalyst. All rights reserved.

This SDK is provided for use by CustomerCatalyst customers only.
