# pages-proxy — customercatalyst-widget (Cloudflare Pages)

`public/_worker.js` hands every request, untouched, to the Messenger/form Worker (`../worker`) via a
service binding. It exists so the Worker gets our hostnames without moving DNS (like `customercatalyst-mcp`).

| Pages env | Branch | Worker | URL |
|---|---|---|---|
| preview | `test` | `customercatalyst-messenger-test` | https://test.customercatalyst-widget.pages.dev |
| production | `main` | `customercatalyst-messenger` | widget.customercatalyst.io (CNAME, LIVE cutover 8a) |

Deploy from this folder: `npx wrangler pages deploy --project-name customercatalyst-widget --branch test --commit-dirty=true`.
