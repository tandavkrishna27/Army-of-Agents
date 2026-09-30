---
"@armyofagents/server": patch
---

fix(security): sanitize mammoth DOCX HTML output via DOMPurify to strip `javascript:` hyperlinks and dangerous tags (C8). Mount helmet with light defaults (X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, Referrer-Policy: no-referrer, X-Powered-By removed). Strict CSP deferred to Sprint 2 with C7.
