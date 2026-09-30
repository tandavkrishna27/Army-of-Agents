# Baseline correction plan — independent review and author disposition

**Reviewed documentation:** `3820e88888dd3fae596beaa2867fcb45858762ff`. TK supplied the Claude report reproduced below. Codex checked its findings against the plan, the six source files, Git ancestry and the recorded shard totals. Neither reviewer ran a new runtime qualification. Attachment SHA-256: `b0ab4187a832e0d33bbed282434c2af8f2e9bfadd79111262dba01e6f0f45784`.

## Author disposition

The main verdict is supported: the plan is concrete enough for TK to approve the bounded correction work. No blocking plan finding was established. This is review acceptance, not execution approval or a green baseline.

| Item | Verified disposition |
|---|---|
| F1/F2/F3 diagnoses and source identity | Confirmed. The six named files have no diff between the Universe pin and tested candidate. DNS test dependence, missing Git metadata and the unhandled opener launch error are correctly attributed. |
| LOW-1 ownership and landing | Clarify, not an unassigned implementation team: Codex is already the implementation/evidence author, TK the acceptance owner and TK-managed Claude the independent reviewer. The replatform landing owner/path still needs recording before landing or adopting the fix. The report's quoted wording about an unassigned implementer/reviewer is not present in this correction plan and must not override the accepted roles. |
| LOW-2 portability | Accepted and already gated. The proposal qualifies the exact corrected candidate; a different later base needs delta review and justified requalification. Identical affected files do not certify the rest of a different tree. |
| LOW-3 launch event assumption | Keep the existing proposed behavior and make the assumption precise. Node reports successful initial launch with `spawn` and failed launch with `error`; additional errors may occur after successful launch. The report's lifetime-wide “exactly one” wording is too broad. The proposed persistent error listener and settled guard already cover later errors. No additional timeout is added by this clarification. |
| Evidence limitation | Accepted. Recomputed stored totals: pin 24,229 passed / 3 failed / 76 skipped; candidate 24,238 passed / 3 failed / 76 skipped; one unhandled error each. Build remains unrun. Recomputing stored results is not rerunning tests. |

[Node's child-process event documentation](https://nodejs.org/api/child_process.html#event-error) distinguishes launch failure from subsequent kill/send/abort errors; [spawn event documentation](https://nodejs.org/api/child_process.html#event-spawn) specifies the initial launch signal. The plan does not infer a time-bounded guarantee under arbitrary runtime failure. Its tests and command runner have their own stated bounds.

The red test would stop at its first failed assertion; the report's statement that it fails both the response and listener assertions should be read as two requirements that the old route violates, not two independently observed failures in a single run. No new red/green evidence exists yet.

## Next authorized boundary

TK authorized recording this review and its clarifications. The [updated plan](baseline-correction-plan.md) awaits explicit permission to author and offline-qualify only the three-file correction on the proposed isolated branch from the exact tested replatform candidate. Scope includes branch/worktree creation, controlled test edits, the route fix, offline setup and bounded regressions/typecheck/shards/build. Local correction commits and evidence are part of that proposed qualification; any remote source publication must use an explicitly approved destination. No merge, base adoption or Universe implementation is included.

These clarifications do not change the reviewed code proposal, security guards, source base or test scope, so another unchanged Claude review is not requested. Material changes or new findings must still be reviewed.

## Original supplied Claude report

The following is the received report, retained as review evidence with line endings normalized. Its observations are subject to the author dispositions above.

# Universe — review: bounded baseline-correction plan (F1/F2/F3)

**Reviewed documentation head (SHA):** `3820e88888dd3fae596beaa2867fcb45858762ff` ("plan and review bounded baseline corrections"), local == `origin/codex/universe-interface`.
**Pinned Universe source:** `183e46a9c65fc3105c7e3d125629276814df7dbb`. **Tested replatform candidate:** `9200a66c42633019349de937a8b97979acac0f7a` (verified: a *descendant* of the pinned base, "DE-27…", 2026-09-12 — a newer replatform revision, not yet adopted).
**Change:** docs-only across the 4 commits since the last review (0 non-docs); adds `baseline-correction-plan.md` (310L), `baseline-retry-results.md`, `baseline-retry-findings.md`. Review-only: I ran no tests/installs/providers and made no edits/branch changes.

## Verdict

**Yes — the plan is sufficiently concrete for TK to approve its bounded execution**, scoped to *authoring + offline-qualifying the three-file correction on the isolated branch*, with base adoption and E1.1 implementation kept as separate later approvals (which the plan already does). Every F1/F2/F3 diagnosis is **source-accurate at the candidate**, the six named files are byte-identical between pin and candidate (verified), the three fixes preserve the security/path guards, and evidence handling is honest (baseline correctly reported **not green**; skips/unhandled-error not upgraded). **No Critical/High/Medium findings** — only LOW items and one review limitation. Settled product/privacy/version/scope decisions are untouched (slice counts 69/69 unchanged; 0 non-docs).

---

## Source-anchor verification (all accurate at candidate `9200a66c`; files == pin)

| Anchor | Verified | Result |
|---|---|---|
| Six F1–F3 files identical pin↔candidate | `git diff 183e46a9c 9200a66c` empty for all six | **CONFIRMED** ("no diff" claim true) |
| F1: `validateAndResolveFetchUrl(urlString):Promise<ValidatedFetchTarget>`; `dnsLookup(host,{all:true})`; `resolvedAddress`/`hostHeader`/`tlsServername`; errors `All resolved IPs`, `DNS resolution failed` | outbound-url-guard.ts:9,215-219,235,281,309-311,267/302,323 | **CONFIRMED** |
| F1 test at 374-384: `validateAndResolveFetchUrl("https://user:pass@…")` credential-stripping, "public-resolving DNS" comment | outbound-url-guard.test.ts:374-384 | **CONFIRMED** (plan's added `resolvedAddress`/`tlsServername`/`{all:true}` assertions map to real fields) |
| F2: `execFileSync("git",["grep",…"buildConnectorProcessEnv","mergeConnectorEnv"…])` with `catch { return [] // exits 1 on no match }`; two `[ESC-7]` assertions | mcp-connector-install-adversarial.test.ts:~1807-1838 | **CONFIRMED** — catch swallows *any* Git error (incl. "not a git repository"), exactly the finding |
| F2 caller: `cli-mode.ts` imports `mergeConnectorEnv`(37)/`buildScrubbedCliEnv`(36); invokes at 1477 & 1894 | cli-mode.ts:36-37,1477,1894 | **CONFIRMED** — the caller exists → ESC-7 failure was missing `.git`, not dead code |
| F3: `spawn(cmd,[target],{detached,stdio:"ignore"})` + `unref()` + `{ok:true}`, **no `child.on("error")`** | filesystem.ts:205-207 | **CONFIRMED** |
| F3 guards preserved-above: instance-admin gate `assertCanManageInstanceSettings(req)` (line 177), home-boundary 400 (188), `fs.access`→404 (195) | filesystem.ts:177,188,195; "403 reveal for non-admin" test | **CONFIRMED** — the fix sits strictly below every guard |
| F3 test: loose "not 400" at 79-90 with comment anticipating "500 (spawn error in CI)" | filesystem-routes.test.ts:79-90 | **CONFIRMED** |

---

## F1/F2/F3 fix assessment

### F1 (Task 2) — test-scoped DNS mock preserves the actual URL guard — SOUND
Mocks only `node:dns/promises` in the test module (`vi.mock` spreading `importOriginal` + overriding `lookup`); default `mockRejectedValue` so no test silently falls through to public DNS; production `validateAndResolveFetchUrl`/`outbound-url-guard.ts` unchanged. It **exercises** the guard, not bypasses it: adds a resolved-private-address case (`127.0.0.1` → rejects `/All resolved IPs/`) and a resolver-failure case (→ rejects `/DNS resolution failed/`) — both error strings verified real. Replaces the failing case body (no duplicate leaving the red intact). Faithful to the real `{all:true}` / `{address,family}[]` / `resolvedAddress` shape.

### F2 (Task 1) — offline real-Git checkout, reproducible commit/patch identity — SOUND
No source change (correctly: the ESC-7 caller exists; the failure was the archive's missing `.git`). The plan builds a real Git-backed offline checkout from an exported **bundle** (no host-repo/home/SSH/Docker mount), clones detached, asserts `git rev-parse HEAD` == recorded SHA, clean `--porcelain`, and re-runs the unchanged ESC-7 assertions; the caller-discovery result must include `cli-mode.ts`. Reproducibility is anchored by a run manifest (SHA + patch SHA-256 + author HEAD + changed-path list). Red/green uses per-stage **cumulative binary diffs restricted to the 3 allowlisted files** (`git apply --check`, restore-from-candidate then apply), explicitly separated from the **clean committed clone** used for final qualification (Task 4): "Never describe these intermediate patched runs as clean-commit qualification." Honest.

### F3 (Task 3) — child-process lifecycle + controlled regression without weakening guards — SOUND
Route fix wraps `spawn` in a Promise: `child.on("error", …→resolve(false))`, `child.once("spawn", …→unref()+resolve(true))`, `try/catch` for synchronous throw, `!launched → 500`, else `{ok:true}`; the error listener stays attached so a later error cannot become an uncaught exception, and a `settled` guard prevents a second HTTP response. It replaces **only** the spawn/unref block — every guard above (admin gate, home boundary, `fs.access`) is preserved, and the tests add `spawn not called` to the non-admin / outside-home / sibling-prefix / missing-path cases. The controlled fake child uses a protective observer **plus** `expect(child.listenerCount("error")).toBeGreaterThan(1)`, so the red test fails on *both* the 500 assertion and the listener-count (proving the route itself must register a handler — the observer can't conceal a missing fix). Node guarantees exactly one of `spawn`/`error` per `spawn()`, so the Promise always resolves (no hang) — see LOW-3.

---

## Process checks (all satisfied)
- **Task order:** F2 Git checkout + env (Task 1) → F1 DNS test (Task 2) → F3 route+tests (Task 3) → clean exact-commit qualification (Task 4) → adoption/implementation boundary (Task 5). Logical and acyclic.
- **Exact file scope:** three files (`outbound-url-guard.test.ts`, `filesystem.ts`, `filesystem-routes.test.ts`) + the offline Git environment; "Only the named route and two test files may change outside documentation." Allowlisted, tight.
- **Red/green transfer:** red captured before each fix with exact command/source/patch identity; "No passing result may be prefilled." Honest.
- **Clean final qualification:** Task 4 uses a *fresh committed clone* (`/workspace/qualified`), HEAD == recorded correction SHA, clean status, full prebuild + `-r typecheck` + 4 shards + build; separated from the patched targeted-test checkout.
- **Bounds:** setup 15 min / targeted 30 min / final 150 min; one red + one green per correction + one combined + one final sequence; "no open-ended retries."
- **Skipped/error evidence:** retain all four shard outcomes; "any failure or unhandled error blocks build"; skips "explained… without upgrading them to passes"; the unhandled error means the shard "cannot be accepted merely because other assertions passed" (matches the retry results).
- **Scope separation:** correction execution ≠ base adoption ≠ Universe/E1.1 implementation — "Do not merge into replatform, main or Universe as part of qualification"; base integration and E1.1 each need separate approval; "No V1 scope or accepted UX/privacy decision changes."
- **Settled decisions preserved:** product/privacy/version/release scope untouched; slice packet unchanged (69/69).

---

## Findings (severity-ranked)

**No Critical/High/Medium.**

- **[LOW-1 — governance, plan-gated] The F3 fix edits shared replatform-lineage production source (`server/src/routes/filesystem.ts`); its landing path and owner are unassigned.** F3 is an inherited defect on both revisions, so the fix belongs to the replatform program, not the Universe docs branch. The plan handles this correctly — authors on an isolated `codex/universe-baseline-corrections` branch from the candidate, "Prefer landing the inherited fix through the replatform review path," "Do not merge into replatform/main/Universe as part of qualification," and flags "actual accountable implementer/reviewer is still unassigned." **Recommendation:** TK's bounded-execution approval should explicitly cover *author + offline-qualify on the isolated branch only*, and require a named replatform owner/review path before the fix is landed or the candidate adopted. (Plan-consistent; just make the scope of approval explicit.)
- **[LOW-2 — portability, verified-mitigated] The correction is qualified against candidate `9200a66c`, not the pinned base `183e46a9c`.** Portability rests on the six F1–F3 files being byte-identical across both — which I verified. If a *different* base is eventually adopted, the fix + its qualification must be re-verified there; the plan anticipates this ("If upstream advances or takes an equivalent fix first, inspect that exact change… identify which checks need repeating"). Low risk given the verified identity.
- **[LOW-3 — hardening note] The F3 route Promise has no timeout; it relies on Node emitting exactly one of `spawn`/`error`.** That is Node's documented guarantee for every `spawn()` returning a ChildProcess (plus the `try/catch` for a synchronous throw), so a hung request is not a realistic path — acceptable as written. Worth stating the assumption explicitly, or adding a bounded await, for defense in depth.
- **[LIMITATION — review-only, not a plan defect] I did not re-run the suite.** I verified every F1/F2/F3 source anchor, the no-diff-pin↔candidate claim, and the preserved admin/path guards; I relied on the published retry evidence for the aggregate counts (24,229 / 24,238 passed, 3 failed, 76 skipped, 1 unhandled error) and the ledger/summary JSON, which I did not independently execute. The baseline remains correctly treated as **not green / unresolved** (as the plan and results state); the correction's green result is a future, approval-gated output ("The code sketches are uncompiled proposals").

---

## Standing caveats (unchanged; not defects)
- Planning deliverable only; all code sketches uncompiled; the three fixes, the offline checkout, and the final qualification are proposals awaiting explicit execution-scope approval.
- Baseline is **not green**; F1/F2 are qualification-environment/test corrections and F3 an inherited source defect — all *unresolved* until the approved batch runs clean.
- **Bounded execution, if approved, authorizes authoring + offline qualifying the 3-file correction only. Base adoption (candidate `9200a66c` or its accepted descendant) and E1.1 implementation remain separate, later approvals. Settled product/privacy/version/scope decisions are preserved. No implementation, installs, test/provider runs, branch changes, commits or merges are authorized by this review.**

*Reviewed doc head `3820e88888dd3fae596beaa2867fcb45858762ff`; Universe source pin `183e46a9c65fc3105c7e3d125629276814df7dbb`; tested candidate `9200a66c42633019349de937a8b97979acac0f7a`.*
