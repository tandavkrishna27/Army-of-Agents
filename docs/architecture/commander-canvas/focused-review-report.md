# Universe — received focused review record

TK supplied the report below. It reviews ac7b9a494f9e3207142d77405036685445a4332f and was checked read-only against that commit. Preserve its review scope: the two corrected contract areas and structural regression checks, not a fresh audit of all 31 slices, runtime qualification or implementation approval. Current decisions are tracked in [the final planning decision packet](final-planning-decisions.md).

---

# Universe — focused re-review: attention ownership + layout persistence

**Reviewed SHA (latest head):** `ac7b9a494f9e3207142d77405036685445a4332f` ("docs(universe): align attention ownership and layout persistence contracts"), local == `origin/codex/universe-interface`.
**Compared against:** `11ab248b618dae228f2ac6efca8e02f4b4e4d132`. **Source base:** unchanged `183e46a9c65fc3105c7e3d125629276814df7dbb` (still an ancestor).
**Change:** one docs-only commit, 13 files, +86/−19; whole branch still 0 non-docs files, 0 new files.
**Scope of this review:** the two areas requested (attention producer/consumer direction; full layout-state pipeline) + UAT-05 + regression on counts/anchors/cross-references. Not a full re-audit of all 31 slices. **Nothing here is executed engineering:** every cited test is a *proposed, unrun* check and every runtime gate remains open.

## Verdict

**Both requested items are resolved and internally consistent across the whole packet.** No remaining inconsistency was found in either focus area. No count/scope/anchor drift was introduced (69/69 increments, 31 slices, 30 V1 / E3.4 V2, 82 anchors = 70 runtime + 12 bundled — re-verified). Implementation still requires TK's explicit approval; a clean re-review does not authorize coding.

---

## 1. Attention: E7.3/1 owns service/GET/client/tests; E2.3 & E7.3/2 consume; no reverse dependency — CONFIRMED

The producer was previously mis-placed under E7.3/2 (Attention surfaces). This commit moves it into a dedicated **"Read-only attention producer owned by E7.3/1"** subsection and rewrites E7.3/2 to consume it.

- **Ownership (producer = E7.3/1).** `coding-plans/e7-3.md:128` (E7.3/1 subsection): *Create `server/src/services/universe-attention-projection.ts`, `server/src/routes/universe-attention.ts`, `ui/src/api/universe-attention.ts` and `server/src/__tests__/universe-attention-projection.test.ts`; register the GET route in `server/src/app.ts`.* A whole-packet grep finds these files created **only** here.
- **Consumers.** `coding-plans/e7-3.md` E7.3/2 "**Files:** Consume the completed E7.3/1 projection service, GET route and API client. Create `AttentionRail.tsx`, `AttentionQuestion.tsx`, component test, e2e." `coding-plans/e2-3.md:9`: "Reuse existing domain read services and **E7.3/1's authorized read-only attention projection**."
- **No reverse dependency (verified both directions):**
  - Producer→consumer only: `e7-3.md:132` — the projection "neither imports `universe-catchup.ts` nor requires E7.3/2's React surfaces, answer adapters, E2.4 Task host, or E7.3/3's delivery ledger. **E2.3 snapshot integration and E7.3/2 are consumers of this completed E7.3/1 API.**"
  - Consumer disclaims reverse edge: `e2-3.md:9` — "**E7.3's canonical projection does not consume this snapshot service, so there is no reverse dependency.**"
  - `implementation-bindings.md` "Reconciled producer order": "E7.3/1 owns the source-authorized attention service, GET route, validated client, projection tests and shared delivery policy. **E7.3/2 owns the consuming React surfaces/source-answer forms; it does not produce the GET route.** E2.3 consumes that projection; E7.3/1 never calls the Universe catch-up service."
- **Dependency declarations now agree.** `slice-plans/e7-3.md` E7.3/1 deliverable: "Produce/test the read-only attention service, GET route, validated API client…before E2.3 or E7.3/2 consumes it." `implementation-plans/e7-routines-attention.md` start condition: "E7.3/1…owns the read-only projection consumed by E2.3 and E7.3/2." `slice-plans/e2-3.md:18` start conditions now list "E7.3/1 authorized attention projection for integrated snapshot completion" — closing the earlier undeclared-forward-dependency (old M8).
- **Producer testable in isolation** (honest gate handling): `e7-3.md:135` — "Test the GET route with the Universe catch-up, question UI and delivery modules absent/disabled; authorized IDs/counts/cursors still work… Track producer completion separately from the whole E7.3 slice." Distributed source kinds "remain subject to their existing gates."

**Result:** direction is correct and acyclic (E7.3/1 → {E2.3, E7.3/2}); ownership is single-sourced; no reverse edge anywhere.

---

## 2. Layout persistence pipeline: viewport / order / selected / maximized / normal geometry — TRACED end-to-end, CONFIRMED

This closes the exact gap from the first review (no `select` op; `maximized` unpersisted; camera unspecified). Every field now has a complete, single-sourced path:

| Stage | viewport (camera) | order (z) | selected | maximized | normal geometry |
|---|---|---|---|---|---|
| **UI callback** | `onViewportCommit` (e1-1:294; e1-6 wires it) | `onStateChange` → order | `onStateChange` → presentation | `onStateChange` → presentation | `onStateChange` → geometry |
| **LayoutOp** | `{type:'viewport';x;y;zoom}` | `{type:'order';keys}` | `{type:'presentation';selected;maximized}` | same `presentation` pair | `{type:'geometry';rect}` (e1-2:16–24) |
| **Validation** | finite ±1e6, zoom 0.25–2 (e1-2 table; e1-1:298) | full permutation, every panel once incl. minimized | non-null must exist+visible | must equal selected & be last in order | bounds; cannot modify minimized/maximized target |
| **Atomic receipt** | same expectedRevision/operationId protocol; candidate published only after final invariants (e1-2 "Complete layout write/read contract") | — | coupled conflict group with order/maximize | — | — |
| **Persisted row** | `universe_layouts` JSON now "(viewport, order, selected, maximized and panel records…)" (e1-2 E1.2/1) | ✓ | ✓ | ✓ | ✓ |
| **GET snapshot** | `AuthorizedLayoutSnapshot.viewport` (e1-1:272) | `.order` | `.selected` | `.maximized` | `.panels[].rect` |
| **Hydration** | `viewportFromLayout(snapshot)` (e1-1:286,306) | `hydrateLayout` | `hydrateLayout` | `hydrateLayout` | `hydrateLayout` (preserves normal rect) |
| **Conflict/reload** | journaled + reconciled; camera/maximize compatibility (e1-2 rebase; e1-2/2 deliverable) | coupled group | coupled group | coupled group | restore keeps normal geometry |

Key single-source-of-truth checks (no drift): exactly one `LayoutOp` union (e1-2), and every enumeration includes `presentation`; exactly one `AuthorizedLayoutSnapshot` (e1-1:270) carrying all five; E1.1 `State` (e1-1:56–58) holds `selected`/`maximized` with focus/maximize/restore/minimize/close reducer handling and the frame's Maximize/Restore control (e1-1:241–243).

Correctness invariants worth noting (all present):
- **No unsolicited save on read:** "Hydration, ResizeObserver measurements and smaller-screen display fitting do not emit user commits or overwrite saved camera/normal geometry" (e1-1 "Persisted camera and presentation round trip"); e1-6 "hydration and display-only clamping never emit that save."
- **Camera ⟷ maximize coupling:** camera movement disabled while maximized; a save batch may carry a completed pre-maximize camera then maximize; restore-from-maximize returns to the saved camera and preserved normal rect (e1-2 viewport/presentation rows).
- **Atomic candidate:** "Transient intermediate presentation mismatch… allowed only inside the atomic candidate; no invalid state becomes externally visible"; invalid patches → 400 with no partial write/receipt/audit; stale revision/reused id → 409.
- **state-contract** now stores viewport and adds a "Layout round-trip binding" section pointing to E1.2's write/read contract.

---

## 3. UAT-05 and dependent plans — CONFIRMED aligned

`user-acceptance-plan.md` UAT-05 step 1 was rewritten to exercise the full contract: *"Move/minimize a panel, pan/zoom to a nondefault camera, focus then maximize another panel… Save/reload, restore the maximized panel and reopen at a smaller viewport. Verify acknowledged camera, selection, stacking, maximized state, normal geometry and draft; safe clamping must not destroy preferred dimensions/camera or trigger a save merely from hydration."* This matches every stage above, including the no-save-on-hydration and preserve-normal-geometry invariants. UAT-05's other steps (two-tab conflict, dropped-ack, failed-save/destination/company switch) remain and are consistent with the coupled-conflict-group and draft-isolation contracts. Both `e1-2` integration and `universe-persistence.spec.ts` e2e checklist items enumerate the same nondefault-camera + maximize + save→reload→restore + lost-ack + concurrent + small-screen cases — labelled "planned checks, not executed evidence."

---

## 4. Remaining inconsistencies

**None material** in the two focus areas. One negligible clarity observation (not a defect): the prose "the workspace handles live `onViewportChange` locally" (e1-1) refers to React Flow's own viewport callback wired internally; only `onViewportCommit` is a `WorkspaceProps` field — so there is no dangling prop, but a one-line note that `onViewportChange` is React Flow's internal (not a Workspace prop) would remove any ambiguity for an implementer.

---

## 5. Standing caveats (unchanged; not defects)

- Everything above is **planning text with proposed, unrun tests**; no runtime, migration, or provider work was executed. Documented gates and "planned checks" are not completed engineering.
- Pre-existing open **decisions** remain: BASE refresh + reviewer/owner assignment; E4/E5 ledger & index security data class; media/speech permitted paths; the 8 runtime gate owners; premature-draft disposition.
- **Implementation still requires TK's explicit approval.** This re-review confirms contract consistency only; it does not authorize coding.

*Reviewed `ac7b9a494f9e3207142d77405036685445a4332f`; base `183e46a9c65fc3105c7e3d125629276814df7dbb`.*
