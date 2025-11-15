# CustomerCatalyst JavaScript SDK

Lightweight JavaScript library for tracking customer usage events.

## Installation

Add this script to your HTML `<head>`:

```html
<script src="https://cdn.jsdelivr.net/gh/utkuairdev/customercatalyst-js@main/customercatalyst.js"></script>
```

## Quick Start

```html
<script>
  // Initialize with your API key
  var cc = new CustomerCatalyst('YOUR_API_KEY');
  
  // Identify the customer
  cc.identify({
    customerId: 'CUSTOMER_ID_FROM_DASHBOARD',
    customerName: 'Acme Corp' // optional
  });
  
  // Track events
  cc.track('login');
  cc.track('invoice_created', 1500);
  cc.track('feature_used', 1, { feature: 'reports' });
</script>
```

## Getting Your Credentials

### API Key
1. Go to **Settings → Integrations → SDK → API Keys**
2. Copy your API key (starts with `org_`)

### Customer IDs
1. Go to **Settings** in your dashboard
2. Export all of your Customers to get IDs

### Event Types
1. Go to **Metrics → Usage Metrics Settings**
2. Use the exact event names configured there

## API Reference

### `new CustomerCatalyst(apiKey)`
Initialize the SDK.

```javascript
var cc = new CustomerCatalyst('org_abc123xyz');
```

### `identify(customerData)`
Identify the current customer. Required before tracking.

```javascript
cc.identify({
  customerId: 'cust_12345',      // required
  customerName: 'Acme Corp'      // optional
});
```

### `track(eventType, value, metadata)`
Track a usage event.

```javascript
cc.track('login');                                    // simple
cc.track('purchase', 1500);                          // with value
cc.track('export', 1, { format: 'pdf' });           // with metadata
```

### `flush()`
Manually send queued events (rarely needed).

```javascript
cc.flush();
```

## Examples

### Single Page App

```javascript
var cc = new CustomerCatalyst('YOUR_API_KEY');
cc.identify({ customerId: 'CUSTOMER_ID' });

// Track throughout app
cc.track('login');
cc.track('invoice_created', 1500);
```

### Multi-Page Site

```html
<!-- On every page -->
<script src="https://cdn.jsdelivr.net/gh/utkuairdev/customercatalyst-js@main/customercatalyst.js"></script>
<script>
  var cc = new CustomerCatalyst('YOUR_API_KEY');
  cc.identify({ customerId: 'CUSTOMER_ID' });
  cc.track('login');
</script>
```

### Before Navigation

```javascript
button.addEventListener('click', function(e) {
  e.preventDefault();
  cc.track('login');
  cc.flush().then(() => window.location.href = '/logout');
});
```

## Best Practices

**✅ Do:**
- Call `identify()` once per session
- Use exact event names from dashboard
- Track meaningful business events

**❌ Don't:**
- Call `identify()` before every `track()`
- Use custom event names
- Track personal information in metadata

## Troubleshooting

**Events not showing?**
- Verify API key in Settings → API Keys
- Confirm Customer ID exists in dashboard
- Check event types match Metrics → Usage Metrics Settings
- Open browser console (F12) for errors
- Wait 1-2 minutes for processing

**Common Errors:**
- `"Must call identify()..."` → Call `identify()` first
- `"Invalid API key"` → Check your API key
- `"eventType must be..."` → Pass event name as string

## Browser Support

Chrome, Firefox, Safari, Edge, Opera (latest versions)

## Security

- API keys are safe for client-side use (write-only)
- Always use HTTPS
- Don't track PII in metadata

## Support

- Email: support@customercatalyst.com
- Dashboard: Click "Help"
- Docs: app.customercatalyst.com/integrations

---

© 2025 CustomerCatalyst. All rights reserved.
