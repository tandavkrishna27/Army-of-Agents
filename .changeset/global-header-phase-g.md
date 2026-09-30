---
"@armyofagents/ui": patch
---

Global header redesign (Phase G): slims the BreadcrumbBar from
h-12/h-14 to h-11. Drops the theme toggle, Commander quick-link, and
entityColor border-top accent. Breadcrumb shows the last 2 levels
with a middot separator (single title for top-level pages).
Hamburger menu is mobile-only — desktop uses the external sidebar
collapse toggle.

Theme toggle migrates to Settings > General > Appearance as a
3-option picker (Dark / Light / System). The "System" option follows
the OS preference via prefers-color-scheme media query.

Audit pass: pages that previously relied on the BreadcrumbBar to
display their title gain their own body h1 for visual hierarchy and
accessibility (one h1 per page).
