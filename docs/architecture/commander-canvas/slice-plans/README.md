# Universe — individual slice plans

**Current sequencing:** [The complete execution sequence](../execution-sequence.md) and [original-increment map](../execution-increment-map.md) stitch these plans together. Author-reviewed scheduling is complete; individual runtime gates and explicit implementation approval remain distinct.

September 12, 2026. **Planning only; implementation is not authorized.** All 31 existing slices have individual outlines, comprising 69 work increments. The [release allocation](../release-plans/README.md) is accepted; detailed coding plans are now drafted for review, with the replatform branch direction agreed and coding approval still withheld. A premature isolated implementation exists and remains paused and excluded from delivery. See the authoritative [planning reset](../planning-reset.md) and [coverage audit](../planning-audit.md).

Each plan carries its own outcome, files, interface responsibility, ordered increments, dependency conditions and acceptance. The outlines retain acceptance and dependency context; [detailed addenda](../coding-plans/README.md) now specify each increment. Exact schema/function/provider bindings, actual failing test code and measurement limits are required at the accepted base before an increment starts. Open qualification work has a concrete deliverable rather than a guessed API. See the [coding readiness contract](coding-readiness.md).

| Slice | Agreed release | Plan |
|---|---|---|
| E0.1 | V1 | [Bind the implementation base](e0-1.md) |
| E1.0 | V1 | [Complete the design-state inventory](e1-0.md) |
| E1.1 | V1 | [Build one canvas and panel controller](e1-1.md) |
| E1.2 | V1 | [Persist layout with revisions and recovery](e1-2.md) |
| E1.3 | V1 | [Persist destination-specific drafts safely](e1-3.md) |
| E1.4 | V1 | [Implement tray, overview and reference navigation](e1-4.md) |
| E1.5 | V1 | [Implement independent Commander surfaces](e1-5.md) |
| E1.6 | V1 | [Implement viewport-aware motion and accessibility](e1-6.md) |
| E2.1 | V1 | [Bind selected references to the existing conversation](e2-1.md) |
| E2.2 | V1 | [Add read-only outcome lookup and bind execution](e2-2.md) |
| E2.3 | V1 | [Build truthful catch-up and snapshot reconciliation](e2-3.md) |
| E2.4 | V1 | [Reuse task content in a reliable conversation panel](e2-4.md) |
| E3.1 | V1 | [Qualify and integrate OpenAI realtime](e3-1.md) |
| E3.2 | V1 | [Implement independent voice controls and recovery](e3-2.md) |
| E3.3 | V1 | [Qualify Gemini and ElevenLabs independently](e3-3.md) |
| E3.4 | V2 | [Plan later speech pipelines and local speech](e3-4.md) |
| E4.1 | V1 | [Make original intake durable](e4-1.md) |
| E4.2 | V1 | [Qualify format processing independently](e4-2.md) |
| E4.3 | V1 | [Preserve revisions and qualify generation](e4-3.md) |
| E5.1 | V1 | [Build reviewed interactive block registry](e5-1.md) |
| E5.2 | V1 | [Qualify isolated executable host](e5-2.md) |
| E6.0 | V1 | [Prove browser compatibility before selecting transport details](e6-0.md) |
| E6.1 | V1 | [Integrate automation through governed worker path](e6-1.md) |
| E6.2 | V1 | [Implement cloud live view and takeover](e6-2.md) |
| E6.3 | V1 | [Implement remote access to local browser](e6-3.md) |
| E6.4 | V1 | [Implement lifecycle, transfer and gated profile reuse](e6-4.md) |
| E7.1 | V1 | [Connect conversational routines to existing scheduler](e7-1.md) |
| E7.2 | V1 | [Add durable authorized follow-up intent](e7-2.md) |
| E7.3 | V1 | [Upgrade shared attention delivery and add Universe presentation](e7-3.md) |
| E8.1 | V1 | [Implement scoped settings with each consumer](e8-1.md) |
| E8.2 | V1 | [Qualify integrated release and rollback](e8-2.md) |

Epics can span releases. E8.1 contracts are established early and implemented with consumers; E8.2 is the V1 integration gate and supplies a reusable checklist for V2, not a second assignment of the same slice. Multi-screen remains a deferred feature record outside the 31-slice set.
