# Messenger Worker

Serves the support form (`../widgets/form/form.js`) and Messenger (`../widgets/messenger/messenger.js`)
widgets and sits between visitors' browsers and the Supabase `messenger` function. Each widget is served
as one closure around `../widgets/shared/kit.js` (helpers both use) and the widget file; no build step. Contract and decisions:
`customercatalyst-dev/docs/scopes/messenger.md` ("Phase 1 build contract").

## Wire shapes (Worker ⇄ function, browser ⇄ Worker)

### Config — `GET /v1/form/config?key=pk_…` or `?slug=…` (exactly one)

Worker → function: `POST SUPABASE_FUNCTION_URL`, header `X-CC-Worker-Secret`, JSON body

```json
{ "action": "form_config", "key": "pk_…" | null, "slug": "sightl" | null,
  "origin_host": "shop.example", "client_ip": "203.0.113.9" }
```

`origin_host` is host[:port] from the browser's `Origin` (no scheme; default ports dropped, so
`shop.example`, `localhost:3000`), the same form track_events matches; for a same-origin
request from our hosted page (no `Origin`, `Sec-Fetch-Site: same-origin`) it is the Worker's own
host. No browser Origin → the Worker answers 403 itself.

Function → Worker (the Worker passes on only `success`, `error`, `config`, and the status code;
200 answers are cached 60 s per key|slug + host):

```json
{ "success": true,
  "config": {
    "enabled": true,                     // form on AND sending ready; false → embed renders nothing, hosted says closed
    "org_name": "Sightl",
    "color": "#0E6B5C",                  // hex; invalid → default
    "logo_url": "https://…" ,            // or "//…cdn.bubble.io/…"; "" = none
    "corners": "square" | "rounded" | "pill",
    "font": "site" | "inter",
    "title": "", "description": "", "button_text": "",   // "" = widget default (description: hidden)
    "help_site_url": "https://help.sightl.com", "help_mode": "none" | "link" | "first",
    "after_send": "text" | "redirect", "thank_you_text": "…*REQUESTER_NAME*…*TICKET_NUMBER*…*REQUESTER_EMAIL*…", "redirect_url": "",
    "files_on": true,                    // missing = true
    "page_title": "", "page_subtitle": "",   // page-layout header; "" = "<org_name> support" / "We'll reply by email." (one line, ≤120)
    "topics": [ { "id": "<bubble id>", "name": "Billing", "short_text": "", "article_url": "" } ],
    "fields": [ { "id": "<bubble id>", "label": "Order number", "hint": "", "kind": "short" | "long" | "list" | "checkbox",
                  "options": ["Low", "High"], "required": false } ]
  } }
```

Refused: `{ "success": false, "error": "origin_not_allowed" | "not_found" | … }` with a 4xx status.
The settings preview no longer fetches a config (it is fed by postMessage, see below).

A **slug** (config and submit) is accepted only when the page is our own hosted page (page host
= the Worker's host, or `HOSTED_HOST`); from any other site it answers `403 {"success":false,
"error":"invalid_api_key"}` like an unknown key. Embeds use `data-key`.

### Submit — `POST /v1/form/submit`, `multipart/form-data`

Browser → Worker fields:

| field | value |
|---|---|
| `key` or `slug` | exactly one |
| `name`, `email`, `subject`, `message` | text (client caps: 200 / 254 / 200 / 20000 chars) |
| `topic` | topic `id`; omitted when the org has no topics |
| `field_<id>` | one per extra field: text, the chosen option, or `yes`/`no` for a checkbox (caps: short 500, long 5000) |
| `files` | repeated, one per file (≤10 files, ≤10 MB each, ≤25 MB total, OS Attachment Type extensions) |
| `turnstile_token` | consumed by the Worker, never forwarded |

The Worker checks: Origin present, `Content-Length` ≤ 26 MB, rate limit per IP then per key/slug,
Turnstile siteverify (`hostname` must be the Worker's host). Then it deletes any browser-sent
`action` / `origin_host` / `client_ip` / `turnstile_token` and forwards the same multipart to the
function with header `X-CC-Worker-Secret` and added fields:

`action=form_submit`, `origin_host=<page hostname>`, `client_ip=<CF-Connecting-IP>`

Function → Worker (the Worker passes on only these keys + status):

```json
{ "success": true, "ticket_id_label": "SUP-59", "name": "Maria", "email": "maria@lund.no" }
{ "success": false, "error": "form_closed" | "origin_not_allowed" | "validation" | …,
  "errors": { "email": "Check the email address.", "field_<id>": "…", "files": "…" } }   // errors optional, shown under the fields
```

Worker-own errors: 400 `turnstile_required` / `turnstile_failed` / `bad_request`, 403
`origin_required`, 411, 413 `too_large`, 415, 429 `rate_limited`, 502 `upstream_error` /
`turnstile_unavailable`, 503 `not_configured`.

The Worker adds two fields of its own to every `config`: `turnstile_mode` (`managed` |
`invisible`, from the `TURNSTILE_MODE` var) and `privacy_url` (from `PRIVACY_URL`, `""` = no link).
Managed: visible widget and the "Protected by Cloudflare Turnstile" line. Invisible: no widget space,
no line, a "Privacy" link next to "Powered by CustomerCatalyst".

**Switching to invisible** is a var change plus two things outside this repo:
`wrangler turnstile widget update <sitekey> --mode invisible` (the sitekey's own mode must match),
and the Turnstile Privacy Addendum referenced in our privacy policy (invisible shows visitors no
Cloudflare notice, so the policy has to).

### Live settings preview (Bubble → preview iframe)

The settings page frames `<host>/v1/preview?layout=embedded|page` (form.js with defaults; the hosted
page `/f/<slug>` is never framable) and sends the values with

```js
iframe.contentWindow.postMessage({ type: "cc-form-preview", config: { /* any subset of the config above */ } }, "<host>");
```

form.js accepts it only in preview mode and only from `window.parent`. It merges the values over
what it has and re-renders in place. Values go through the same clean-up as a fetched config.
Send stays disabled, so nothing is ever sent.

### Messenger (phase 1b)

Same shapes as the form, key only (a slug answers 400):
`GET /v1/messenger/config?key=pk_…` → function action `messenger_config` (cached 60 s per key + host,
apart from the form config); `POST /v1/messenger/submit` (multipart, same fields as the form submit) →
`messenger_submit`. The config is the form's plus `messenger: { position: "left"|"right",
launcher_shown, icon: "bubble"|"question"|"headset"|"dots"|"envelope", texts: { title, greeting,
reply_time, new_button, message_hint, after_send } }` ("" = widget default; greeting and after_send keep
line breaks, ≤2000 chars, the others are one line). Submit success may carry `confirmation: false` (no
confirmation mail went out): Sent then promises no copy. Missing = true. Errors the widget words
itself: `messenger_closed` (403), `daily_limit` (429, also on the form), `rate_limited` (429), `try_again` (503, also on the form; the input stays).
Submit (form and Messenger) and `/v1/messenger/reply` success may carry `files_failed: <n>`: the message
went in, n files could not be stored; the widget says so.

Phase 2 routes (POST, token only in bodies): `/v1/messenger/conversations` {key, tokens[≤20]}
(malformed tokens dropped, indexes kept; non-array / >20 → 400; limits: `RL_LIST_IP` 10/min per IP +
`RL_READ_KEY`), `/thread` and `/file` (`RL_READ_IP` + `RL_READ_KEY`), `/reply` multipart
(`RL_REPLY_IP` + `RL_REPLY_KEY`) → `{success, id, at, ticket_id_label?, files_failed?}`;
`ticket_id_label` only when a Closed ticket got a follow-up, the same token now points at it.

Settings preview: frame `<host>/v1/messenger/preview` and send
`postMessage({ type: "cc-messenger-preview", config }, "<host>")`; it opens on Home and re-renders in place,
staying on the screen in view. It answers `{ type: "cc-messenger-preview-ready" }` on every load.

### Preview framing

`/v1/preview` and `/v1/messenger/preview` send `frame-ancestors` = the `PREVIEW_PARENT_ORIGINS` var
(space-separated https origins, the Bubble app hosts) and pass the same list to the widget, which
accepts a preview message only from `window.parent` on one of those origins and sends its ready ping
to those origins only (never `"*"`).

## Routes

`GET /v1/form.js` · `GET /v1/form/config` · `GET /v1/turnstile?origin=<page origin>` (Turnstile on
our host, token posted to that origin only) · `POST /v1/form/submit` · `GET /f/<slug>` (hosted page;
production: `widget.customercatalyst.io/f/<slug>`) · `GET /v1/preview` (settings preview with
nothing saved yet) · `GET /v1/messenger.js` · `GET /v1/messenger/config` · `POST /v1/messenger/submit` ·
`GET /v1/messenger/preview` · `GET /demo?key=pk_…&slug=…` (test env only; with a key it also loads the
Messenger).

## Environments

| env | Worker | URL |
|---|---|---|
| `test` | customercatalyst-messenger-test | https://customercatalyst-messenger-test.customercatalyst.workers.dev |
| `production` | customercatalyst-messenger | widget.customercatalyst.io via a Pages proxy + service binding (configured, not deployed) |

Always pass `--env`. Secrets per env: `MESSENGER_WORKER_SECRET`, `TURNSTILE_SECRET`
(`wrangler secret bulk <file> --env test`, never on the command line).

```sh
npm test                               # node --test, no dependencies
CLOUDFLARE_ACCOUNT_ID=21649d75dfaa2b2797d371a308d5f078 wrangler deploy --env test
```

This folder and `../widgets/` are not part of the Cloudflare Pages build (`build.sh` → `dist/`), so
the CDN still serves only the tracking SDK.
