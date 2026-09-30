---
"@armyofagents/ui": patch
---

Per-company Settings redesign: replaces the 7-tab PageTabBar layout
with a SecondarySidebar pattern (parity with InstanceSettings).
Sections grouped into Company / Operations / Extensions / Danger.
Commander is now a Settings section with its 4 sub-tabs preserved
(Execution & Model / Capabilities / Budget & Spend / Run History).
Activity is promoted out of Settings to its own page at /activity.
GitHub PAT management exits Settings (handed off to the Plugins
flow — separate effort). Three previously API-only fields get UI
controls (proactiveIntervalMinutes, marketplaceSettings.updateWindow,
rootFolder).
