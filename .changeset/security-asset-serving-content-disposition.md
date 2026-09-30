---
"@armyofagents/server": patch
---

Force `Content-Disposition: attachment` for asset GETs unless the content type is on a safe-inline allowlist (images excluding SVG, PDF, plain text, markdown, JSON). Adds explicit `X-Content-Type-Options: nosniff` on every asset response. Closes the same-origin XSS window where a user-uploaded HTML or SVG file would otherwise execute under the AoA app origin. Upload policy is unchanged — all types are still accepted.
