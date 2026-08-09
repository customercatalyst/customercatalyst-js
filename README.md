# CustomerCatalyst JavaScript SDK

Track customer usage events and monitor product adoption with CustomerCatalyst's lightweight JavaScript tracking library.

## Installation

The simplest install is one script tag with your API key on it, in the `<head>`:

```html
<script src="https://cdn.customercatalyst.io/customercatalyst.js" api-key="YOUR_API_KEY"></script>
```

That's `api-key`, not `data-api-key`. It creates a ready-to-use instance at `window.customercatalyst`
automatically, with no `new CustomerCatalyst(...)` call needed.

If you need more than one instance on a page, the key is only known at runtime, or you're bundling
this into a module-based build, omit the attribute and construct it yourself (see
[Manual initialization](#manual-initialization)).

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.customercatalyst.io/customercatalyst.js" api-key="YOUR_API_KEY"></script>
</head>
<body>
  <script>
    // window.customercatalyst is ready as soon as this script has run
    customercatalyst.identify({
      customerId: 'CUSTOMER_ID',
      customerName: 'Acme Corporation' // optional
    });

    customercatalyst.track('login');
    customercatalyst.track('invoice_created', 1500);
    customercatalyst.track('report_generated', 1, { type: 'monthly' });
  </script>
</body>
</html>
```

Typing `customercatalyst` on every call is a mouthful, so capture it in a short local variable if you'd
rather not:

```javascript
var cc = customercatalyst;
cc.identify({ customerId: 'CUSTOMER_ID' });
cc.track('login');
```

This is safe even on a page that shares `window` with other scripts. `var cc = customercatalyst` reads
`window.customercatalyst` once and holds onto that instance from then on, so it doesn't matter if some
other, unrelated script later does `window.cc = somethingElse`. Your `cc` already has its own reference
and is unaffected.

### Manual initialization

Skip the `api-key` attribute and construct the instance yourself with `new CustomerCatalyst(apiKey)`.
Use this instead of the default script-tag path when:
- you need more than one instance on a page (each API key gets its own instance)
- the key is only known at runtime (fetched from your own backend, a feature flag, etc.), not at
  page-load time
- you're bundling this file into a module-based build rather than loading it as a plain `<script>`

```html
<script src="https://cdn.customercatalyst.io/customercatalyst.js"></script>
<script>
  var cc = new CustomerCatalyst('YOUR_API_KEY');
  cc.identify({ customerId: 'CUSTOMER_ID' });
  cc.track('login');
</script>
```

Name the variable whatever you like, but not `CustomerCatalyst` or `customercatalyst`. Either one
shadows something this file relies on (the class itself, or the auto-init instance), and the failure
it causes ranges from a confusing `TypeError` on the next `new CustomerCatalyst(...)` to silently
overwriting the script tag's own instance. Any other name, including the `cc` used here, is safe.

Both paths behave identically once you have an instance. `identify()` is still required before
`track()` either way. Auto-init is idempotent, not overwrite-proof: if `window.customercatalyst` is
already a real `CustomerCatalyst` instance (this script loaded twice, or you constructed one yourself
before the tag ran), it's reused untouched. Anything else found at `window.customercatalyst`
(including something a different script planted there before this one ran) is replaced with a real
instance built from the tag's own `api-key`, so a lookalike object can't silently absorb your
`.track()` calls.

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

Everything below assumes you already have an instance: either `window.customercatalyst`, the one the
script tag creates automatically (see [Installation](#installation)), or one you built yourself with
`new CustomerCatalyst(apiKey)` and assigned to a variable of your own choosing (see
[Manual initialization](#manual-initialization)). The examples below use `customercatalyst`; if you went
the manual route, substitute whatever you named your instance.

### `identify(customerData)`

Identify the current customer. Must be called before tracking events.

```javascript
customercatalyst.identify({
  customerId: 'customer_12345',      // required
  customerName: 'Acme Corporation'   // optional
});
```

**Parameters:**
- `customerData` (object, required)
  - `customerId` (string, required): Customer ID from your dashboard
  - `customerName` (string, optional): Display name for the customer

---

### `track(eventType, value, metadata)`

Track a usage event.

```javascript
// Simple event
customercatalyst.track('login');

// Event with value
customercatalyst.track('purchase', 1500);

// Event with metadata
customercatalyst.track('export_report', 1, { format: 'pdf', pages: 24 });
```

**Parameters:**
- `eventType` (string, required): Event name from Metrics → Usage Metrics Settings
- `value` (number, optional): Numeric value, defaults to 1
- `metadata` (object, optional): Additional event context as JSON

---

### `flush()`

Send everything still queued and wait for it to land (rarely needed; events
send on their own, and anything still queued is sent automatically when the page
is hidden or closed).

```javascript
await customercatalyst.flush();
```

Returns a promise. It resolves once the queue has drained, or after 5 seconds if
the server is unreachable, so it can never hold up a page navigation. Sending
stays rate limited, so a large queue takes a moment.

---

### `restart()`

Resume after a fatal error stopped the SDK. Only useful if the cause was
temporary. For a wrong API key, create a new instance with the correct key
instead, since the key is fixed when the instance is created.

```javascript
customercatalyst.restart();
```

---

### `stats`

Read-only snapshot of this key's queue. Dropping a batch or a backlog keeps the SDK alive, which is
right, but it's still a real loss, and this is how you find out one happened.

```javascript
customercatalyst.stats; // { queued: 3, droppedEvents: 0, droppedBatches: 0 }
```

- `queued`: events for this API key currently waiting to send
- `droppedEvents` / `droppedBatches`: events and batches lost for this key. That covers a malformed or
  oversized batch the server rejected outright (see [Dropped Batches](#dropped-batches-bad-request-not-fatal)),
  a batch that kept failing until it hit the retry ceiling, or a backlog discarded when a
  [fatal error](#fatal-errors-sdk-stops) stopped the key.

---

### `isStopped`

`true` once a [fatal error](#fatal-errors-sdk-stops) has stopped this API key. `track()` calls are
silently ignored while this is `true`.

```javascript
if (customercatalyst.isStopped) { /* show a warning, alert monitoring, etc. */ }
```

---

### `CustomerCatalyst.init()`

What the script tag calls automatically to build `window.customercatalyst` from its `api-key`
attribute. It is documented here because it's what runs behind [Installation](#installation), not
because you need to call it yourself. Idempotent: calling it again returns the same instance rather
than building a second one, as long as `window.customercatalyst` genuinely is a `CustomerCatalyst`
instance already.

```javascript
CustomerCatalyst.init(); // returns window.customercatalyst, creating it first if needed
```

## Examples

### Single Page Application

```html
<script src="https://cdn.customercatalyst.io/customercatalyst.js" api-key="YOUR_API_KEY"></script>
```

```javascript
customercatalyst.identify({ customerId: 'CUSTOMER_ID' });

// Track throughout the application
customercatalyst.track('dashboard_viewed');
customercatalyst.track('invoice_created', 1500);
customercatalyst.track('settings_updated');
```

### Multi-Page Website

This is where the script tag pays off most: one `<script>` on every page, no per-page wiring.

```html
<!-- Include on every page -->
<script src="https://cdn.customercatalyst.io/customercatalyst.js" api-key="YOUR_API_KEY"></script>
<script>
  customercatalyst.identify({ customerId: 'CUSTOMER_ID' });
  customercatalyst.track('page_viewed');
</script>
```

### Before Page Navigation

```javascript
logoutButton.addEventListener('click', function(e) {
  e.preventDefault();
  customercatalyst.track('logout');
  customercatalyst.flush().then(() => {
    window.location.href = '/logout';
  });
});
```

## Error Handling

The SDK automatically handles errors to prevent infinite retry loops.

### Fatal Errors (SDK Stops)

Only a credential failure stops the key. The SDK assumes it will never work again, so it discards
everything still queued for it rather than retrying forever:
- **401 / 403**: invalid or revoked API key
- **404**: wrong endpoint (an unusually old or mis-hosted copy of this file)

```javascript
// SDK detects fatal error and stops
[CustomerCatalyst] Failed to send events: API Error 401: {"success":false,"error":"invalid_api_key"}
[CustomerCatalyst] Fatal error detected. Stopping SDK for this API key.

// Future track() calls are ignored
customercatalyst.track('event'); // Won't send
```

### Dropped Batches (Bad Request, Not Fatal)

A malformed or oversized batch is dropped, not retried (the same bytes would just be rejected again),
but the key itself is fine, so the SDK keeps sending everything else normally:
- **400**: malformed request
- **413**: batch too large
- **422**: unprocessable batch

```javascript
[CustomerCatalyst] Server rejected the batch — dropping 3 event(s) and continuing
```

This is silent otherwise; check [`customercatalyst.stats`](#stats) (`droppedEvents` / `droppedBatches`)
to see it.

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

The escalating wait is tracked per organization key, not globally, and it holds regardless of what
else happens on the page while it is pending, including that same key's own further `track()` calls,
or another key's healthy traffic sharing the queue. It is not just a delay before the next retry
attempt; it is remembered, so nothing arriving mid-wait can shorten it.

For a rate-limited (429) response specifically, the SDK waits as long as the server asks instead of
its own backoff schedule, bounded to at most 5 minutes so a garbage or hostile wait value can't park a
key for hours. If more than one organization's key is sending from the same page, a quota wait on one
key does not hold up another's healthy events queued behind it: the SDK sends whichever key is
currently allowed to send, skipping past a waiting one rather than blocking the whole page on its
clock. That wait comes from the response body, not the `Retry-After` header, because browsers don't
expose that header across origins on this endpoint, so the server also returns the same value as
`retry_after_seconds` in the 429 body.

### Restarting After Configuration Fix

`restart()` resumes the *same* key. Use it when the cause was temporary (a key that was briefly
suspended and is valid again, for example), not to swap in a different key:

```javascript
// The key is valid again. Resume the same instance, no reload needed:
customercatalyst.restart();
// Events now send successfully ✅
```

If the key itself was wrong, `restart()` won't help (see [`restart()`](#restart)). Fix the `api-key`
attribute and reload, or construct a new instance with the correct key.

## Debug Logging

Turn on verbose console logging while integrating, or when diagnosing why events aren't showing up.

Via the script tag:

```html
<script src="https://cdn.customercatalyst.io/customercatalyst.js" api-key="YOUR_API_KEY" debug></script>
```

Or at runtime, from either initialization path:

```javascript
CustomerCatalyst.debug = true;
```

With it on, the console shows events being queued, batches being sent (event count and byte size),
the server's response counters, why a given retry delay was chosen, and beacon sizes and refusals on
page unload. It's silent by default; nothing is logged unless you turn this on. API keys are shown
redacted (last 4 characters only) in this output, never in full.

`CustomerCatalyst.debug` is a single global switch, not a per-instance setting. Turning it on affects
every `CustomerCatalyst` instance on the page, however each one was created.

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
  Call `.identify()` before any `.track()` calls on your instance

- **"API Error 401"** (`{"success":false,"error":"invalid_api_key"}`)  
  Your API key is wrong, inactive, or was revoked. This is a
  [fatal error](#fatal-errors-sdk-stops), so the SDK stops the key and drops anything still queued for
  it. Verify your API key starts with `org_` and is active, then create a new instance with the
  corrected key (see [`restart()`](#restart) for why restarting the same instance won't help here).

- **"eventType is required and must be a non-empty string"**  
  Pass a valid event name as the first parameter

- **"metadata must be a plain object, ignoring it"**  
  Pass an object, not an array or a string. The event is still recorded, without
  the metadata.

- **"value must be a non-negative number, using 1 instead of …"**  
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
| Events per `track()` call | always 1 | N/A |
| `customerId` length | 255 characters | `identify()` throws. |
| `eventType` length | 255 characters | `track()` throws. |
| `value` | 0 or greater, up to 12 digits and 6 decimals | Stored as `1`, with a console warning. |
| Single event size | About 28 KB, including `metadata` | The event is dropped with a warning. Batches are split to stay under this. |
| Queued events | 1,000 total on the page | Further events are dropped with a warning until the queue drains. |
| Queued events per organization | 500 | Further events for that organization are dropped with a warning until its own backlog drains; other organizations sharing the page are unaffected. |

`customerId` and `eventType` length is counted in characters (Unicode code points), not JavaScript
string length. An emoji counts as one character here even though it's two UTF-16 units internally.

### How events are counted

One `track()` call is one event, whatever `value` you pass. `value` is the quantity recorded against
that event, not a multiplier on it:

```javascript
customercatalyst.track('invoice_created', 50);   // 1 event, contributes 50
```

Batching does not change this. The SDK groups events into fewer network requests for efficiency, but
50 batched events are still 50 events.

Since metrics are totalled from `value`, recording a quantity once is equivalent to recording it
piece by piece, and far cheaper:

```javascript
// Same result. The first is one event, the second is fifty.
customercatalyst.track('invoices_created', 50);
for (var i = 0; i < 50; i++) customercatalyst.track('invoices_created');
```

Prefer the first whenever you already know the quantity. It uses a fraction of your hourly allowance
and far less of your users' bandwidth.

Sending is capped at 10 requests per second, and events are batched, so a burst of activity is sent
in a few requests rather than hundreds. The first `track()` call after the queue has been idle waits
briefly (50ms) before sending, so a burst of calls fired in the same tick lands in one request
instead of several. `flush()` skips that wait; it's meant for the moment a page is navigating away,
which can't afford it.

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

## License

Proprietary. © 2025 CustomerCatalyst. All rights reserved.

This SDK is provided for use by CustomerCatalyst customers only.
