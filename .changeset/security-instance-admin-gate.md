---
"@armyofagents/server": patch
---

fix(security): require instance-admin (or local_implicit) for filesystem routes (C2) and adapter operations (C6). Lifts `assertCanManageInstanceSettings` to `routes/authz.ts` so `instance-settings.ts` and `feedback.ts` use the same shared helper. `/filesystem/reveal` additionally bounds spawn targets to the home directory.
