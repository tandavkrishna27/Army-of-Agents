# DEP-012 · Slice 3 · Wave β2 — result

**Status:** ✅ SHIPPED CI-GREEN. **Independently verified against the repo** (not the build report) by the
orchestrator/verifier session, 2026-08-29.

**Commits:** `688b30916` (feat — the bin + guard + devDep→dep) + `8ba98ed7f` (fix — `check-gate-clause-wiring`
reference count 2→4). Branch `docs/replatform-program`, PR #323.
**CI:** run `33238551668`, `conclusion=success` on the exact tip SHA `8ba98ed7f` (policy + all 4 verify shards +
e2e + e2e-pgvector + brand-check + migrations + lint + browser + distributed-contract).

## What shipped

1. **The composition-root bin** `packages/adapter-manager/src/bin/adapter-manager.ts` (192 lines) — the ONE file
   that may name `@armyofagents/sandbox-e2b-provider`. Env-gated provider switch
   (`AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER` / `_E2B_TEMPLATE` / `_CONTROL_PLANE_PUBLIC_KEY_FILE` /
   `_IDEMPOTENCY_LEDGER_DIR`); a LITERAL dynamic `import()` of the BARE barrel →
   `new E2bSandboxProvider({ transport: createRealE2bTransport() })`; the ed25519 control-plane key loaded via
   single-arg `createPublicKey(bytes)` (PEM SPKI) + `asymmetricKeyType === "ed25519"` assert; β1's ledger dir
   wired; `.listen(process.env.PORT)`.
   - **FAIL-CLOSED — the SOLE guard on the OPTIONAL `controlPlanePublicKey?`.** `createProviderServer` treats
     `undefined` key as an UNGATED server (`gated = key !== undefined`), so the bin refuses to boot on EVERY key
     failure — provider unset/empty/none/unrecognised, template unset, key path unset/empty, file missing,
     unreadable, readable-but-unparseable, non-ed25519, private-key PEM, provider-construct throw — with
     `createProviderServer` NEVER called. Verified by the 15-case bin vitest (14 refuse paths + 1 happy) using
     REAL key material (RSA / garbage / empty buffer) through an injected fs-BYTES seam so the real parser runs.
   - The provider-control credential is NEVER named here — `createRealE2bTransport()` reads it itself (DEP-006).

2. **The boundary guard** `scripts/lib/adapter-manager-boundary.mjs` (+ runner + self-test) — a default-deny
   ALLOW-LIST: the provider is confined PREFIX-based (bare + any subpath) to the ONE bin FULL path; the
   non-confined deps (`provider-wire`, `worker-daemon`) are allow-listed bare + subpath (so `server.ts`'s
   `provider-wire/codec` and `capability-verify.ts`'s `.../capability` pass — the G1 false-positive an exact-match
   template copy would RED); `e2b` is default-denied EVERYWHERE; `E2B_API_KEY` is banned over RAW source
   (comments too); required-deps `[provider-wire, sandbox-e2b-provider, worker-daemon]` exact-set (no `e2b`).
   Verified by the 18-case self-test (incl. the subpath false-positive green, the provider-subpath-from-non-bin
   rejection, the same-named-subdirectory path check, credential-in-a-comment, and a `peerDependencies` dodge).

3. **devDep→dep** — `sandbox-e2b-provider` moved to a dependency (`e2b` omitted, transitive); `pnpm-lock.yaml`
   committed.

## Registration (5-part + pr.yml)

`scripts/lib/adapter-manager-boundary.mjs` + `scripts/check-adapter-manager-boundary.mjs` +
`scripts/check-adapter-manager-boundary.test.mjs` + a `guard-inventory.json` runner entry + a
`test-execution-census.json` self-test entry (`{status:"runs", workflow:"pr.yml", step:"Sandbox e2b provider
dependency boundary"}`) + both commands appended to that pr.yml step. Verified live: `check-guard-inventory`,
`check-execution-census`, and `check-gate-clause-wiring` all green locally.

## Verification (run independently)

AM vitest **98/98** (9 files); boundary self-test **18/18**; bin fail-closed test **15/15**; the guard runner
PASS on the real tree; the structural `ProviderModule` cast matches the real `E2bSandboxProvider({transport,
templateId?})` ctor + `createRealE2bTransport(options={})` (both barrel-exported) — the seam that CI's key-less
lanes cannot exercise.

## The one design-vs-repo discrepancy (build caught + fixed)

The β2 design's §β2.6 guard list **omitted `check-gate-clause-wiring`**. The bin names `E2bSandboxProvider` twice
(a `ProviderModule` interface property + `new mod.E2bSandboxProvider(...)`), bumping the gated symbol's caller
count 2→4 and firing `unwired_but_now_has_caller` → policy RED on first push. Fixed (`8ba98ed7f`): raise
`expectedReferences` to 4, keep **E7-1-coding-journey `unwired`** (the bin is in no image; the staging compose
neither runs it nor injects the control-plane key = Slice-5 deploy-owed; the bin fail-closes without it; DEP-011
owns the daemon consumer). Lesson: whenever a wave adds a construction seam for a gated symbol, the guard sweep
must include `gate-clause-wiring.json`.

## Still open (Tier-0 remainder)

The real control-plane keypair + mint; **DEP-011**'s through-the-daemon composition seam (incl. the `(compose)`
no-op/trust `CleanupAuthority` variant + the reconcile idempotent-inversion guard); **Slices 4–5** (credential
crossing = (i); deploy = the AM Docker image + the compose control-plane-key env). The real `RealE2bTransport`
connect + the real-E2B conformance subset run only in the operator-dispatched keyed lane.
