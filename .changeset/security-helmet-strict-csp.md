---
"@armyofagents/server": patch
---

Graduate helmet from light defaults to a strict Content-Security-Policy in `authenticated` and other production deployment modes. Adds `script-src 'self' 'sha256-<bootloader>'` (the Vite bootloader inline script hash is computed at server startup by reading the served `index.html`), locked `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`, and a `connect-src 'self'` lock-down (the UI never calls LLM APIs directly — all LLM traffic is server-mediated). Local-trusted dev mode skips CSP because Vite HMR requires inline + WebSocket + eval. Cross-Origin-Opener-Policy moves to `same-origin-allow-popups` and Cross-Origin-Resource-Policy to `same-site`; COEP intentionally remains off to allow external avatar/image loading without forcing every host to emit a CORP header. Closes Sprint 4 finding S4-G.
