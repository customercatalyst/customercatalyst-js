# CustomerCatalyst JavaScript SDK

Track customer usage events and monitor product adoption with CustomerCatalyst's lightweight JavaScript tracking library.

## Features

- 🚀 **Lightweight** - Minimal footprint, loads asynchronously
- 📊 **Automatic batching** - Queues and batches events for optimal performance
- 🔒 **Secure** - Uses your organization's unique API key
- ⚡ **Rate limiting** - Built-in protection against API abuse
- 🎯 **Simple API** - Just 2 methods: `identify()` and `track()`
- 📱 **Cross-browser** - Works in all modern browsers

## Installation

Add the following script tag to your HTML, preferably in the `<head>` section:

```html
<script src="https://cdn.jsdelivr.net/gh/utkuairdev/customercatalyst-js@main/customercatalyst.js"></script>
```

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/gh/utkuairdev/customercatalyst-js@main/customercatalyst.js"></script>
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

Manually send all queued events immediately (rarely needed).

```javascript
cc.flush();
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
<script src="https://cdn.jsdelivr.net/gh/utkuairdev/customercatalyst-js@main/customercatalyst.js"></script>
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

When these errors occur, the SDK stops processing:
- Invalid API key
- Authentication errors
- Configuration errors

```javascript
// SDK detects fatal error and stops
[CustomerCatalyst] Failed to send events: Invalid API key
[CustomerCatalyst] Fatal error detected. Stopping SDK.

// Future track() calls are ignored
cc.track('event'); // Won't send
```

### Retryable Errors (SDK Auto-Retries)

The SDK automatically retries temporary errors:
- Network timeouts
- Server errors
- Rate limiting

```javascript
[CustomerCatalyst] Failed to send events: Network timeout
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

- **"Invalid API key"**  
  Verify your API key starts with `org_` and is active

- **"eventType must be a non-empty string"**  
  Pass a valid event name as the first parameter

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
