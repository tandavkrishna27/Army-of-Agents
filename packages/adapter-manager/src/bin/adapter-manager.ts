// packages/adapter-manager/src/bin/adapter-manager.ts
//
// DEP-012 Slice 3 · Wave β2 — THE ONE composition-root that may name
// `@armyofagents/sandbox-e2b-provider`, and the SOLE guard on the control-plane key.
//
// `scripts/lib/adapter-manager-boundary.mjs` (PROVIDER_HOST_PATH) confines that package —
// bare or any subpath — to this file, because its transitive closure pulls the `e2b`
// network SDK into the adapter-manager host process. Every request-path file stays
// provider-free; the SDK enters here, once, from a LITERAL DYNAMIC import.
//
// ★ WHY FAIL-CLOSED IS THE PRIMARY GUARANTEE (review B1). `createProviderServer`'s
// `controlPlanePublicKey?` is OPTIONAL, and the whole gate reduces to
// `gated = controlPlanePublicKey !== undefined` (server.ts). A missing key ⇒ `undefined` ⇒
// create + execute fall to RAW, UNGATED handlers — the cross-tenant `execute` oracle B1
// closed. There is NO compiler backstop: the bin is the only thing standing between "no
// key configured" and "an ungated server on the network." So EVERY way the key can fail to
// load — env/path unset or empty; file missing; file unreadable; readable-but-unparseable;
// parsed-but-non-ed25519; a private-key PEM — is a REFUSAL TO BOOT, never a benign default.
// `createProviderServer` is never called on any of those paths.
//
// ★ WHY THE PROVIDER-CONTROL CREDENTIAL IS NOT NAMED HERE. This file passes NO key to the
// transport: `createRealE2bTransport()` reads the provider-control credential itself
// (DEP-006 confinement, in the e2b leaf). The boundary checker forbids that credential's
// NAME in this package's source outright, so it is not spelled here even in prose. A
// missing credential surfaces by PROPAGATING the transport's own synchronous constructor
// error into a refusal.
//
// ★ WHY A BAD PROVIDER CONFIG IS A REFUSAL, NOT A DEGRADE. The adapter-manager IS the
// provider host; it cannot do its job without a provider. Unlike the desktop worker (where
// `none`/unset is the shipped default), here an unset/unrecognised provider — or a provider
// whose construction throws — is a loud refusal, never a silent boot with no provider.

import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import type { ProviderOpContext, SandboxProvider } from "@armyofagents/worker-daemon";

import { createProviderServer, type CreateProviderServerOptions } from "../server.js";
import { reconcileReaper, type ReaperLogger } from "../reconcile-reaper.js";
import { makeControlPlaneResolveTruth, TRUTH_SHARED_SECRET_ENV } from "../reaper-truth-client.js";
import { accumulateReaperMetrics, createReaperMetrics } from "../reaper-metrics.js";
import {
  realReaperScheduler,
  resolveReaperConfig,
  startReaperLoop,
  type ReaperScheduler,
} from "../reaper-loop.js";

/** Opts the host into a real sandbox provider. Unset/empty/`none` ⇒ REFUSE (this is the
 * provider HOST — it cannot boot without one). */
export const PROVIDER_ENV = "AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER";
/** The E2B sandbox template. Required when `PROVIDER_ENV=e2b`; absent ⇒ a refusal. */
export const TEMPLATE_ENV = "AOA_ADAPTER_MANAGER_E2B_TEMPLATE";
/** Path to the ed25519 control-plane PUBLIC key (PEM SPKI). Unset/empty/unloadable ⇒
 * REFUSE — a missing key would boot an UNGATED server (the primary security guarantee). */
export const CONTROL_PLANE_PUBLIC_KEY_FILE_ENV = "AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE";
/** Directory the β1 durable idempotency ledger persists into. A configured out-of-tree
 * volume in a real deployment; when unset the server defaults to a fresh OS temp dir. */
export const IDEMPOTENCY_LEDGER_DIR_ENV = "AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR";

/**
 * The STRUCTURAL shape consumed from the provider package. Declared here so this file can
 * name `E2bSandboxProvider` and `createRealE2bTransport` for the loader WITHOUT a static
 * import that would pull the `e2b` SDK in at module load. The injected-loader seam also lets
 * a test pair a stub provider with a stub transport without either being reachable from
 * production.
 */
export interface ProviderModule {
  readonly E2bSandboxProvider: new (options: {
    readonly transport: unknown;
    readonly templateId?: string;
  }) => SandboxProvider;
  readonly createRealE2bTransport: () => unknown;
}

export type ProviderModuleLoader = () => Promise<ProviderModule>;

/** The default loader: a LITERAL dynamic import of the BARE barrel so the boundary checker
 * accepts it and the `e2b` SDK loads only here. This is the ONE reference to the provider
 * package in the whole package. */
export const loadProviderModule: ProviderModuleLoader = async () =>
  (await import("@armyofagents/sandbox-e2b-provider")) as unknown as ProviderModule;

/** Injectable dependencies. The seam cuts at fs-BYTES (a file-bytes reader), not at a
 * ready-made KeyObject, so the REAL `createPublicKey` runs on the injected bytes and the
 * unparseable / non-ed25519 / private-key refuse paths are genuinely exercised. */
export interface AdapterManagerDeps {
  readonly env: Record<string, string | undefined>;
  readonly loadProviderModule?: ProviderModuleLoader;
  readonly readKeyFileBytes?: (path: string) => Buffer;
  readonly createProviderServer?: (options: CreateProviderServerOptions) => Server;
  /** DEP-011 reaper Slice C — the injected timer seam (default: `setTimeout`-backed). A
   * test passes a fake scheduler to assert the loop is (not) armed without real timers. */
  readonly reaperScheduler?: ReaperScheduler;
}

export type AdapterManagerBootResult =
  | { readonly kind: "listening"; readonly server: Server }
  | { readonly kind: "refused"; readonly reason: string };

function refused(reason: string): AdapterManagerBootResult {
  return { kind: "refused", reason };
}

/**
 * Boot the adapter-manager provider host, or REFUSE — never guess, never degrade.
 *
 * The order is deliberate: resolve the provider, then load+assert the control-plane key,
 * and ONLY if both succeed call `createProviderServer` and `.listen`. Any failure returns a
 * `refused` result with `createProviderServer` untouched.
 */
export async function bootAdapterManager(deps: AdapterManagerDeps): Promise<AdapterManagerBootResult> {
  const { env } = deps;
  const load = deps.loadProviderModule ?? loadProviderModule;
  const readKeyFileBytes = deps.readKeyFileBytes ?? ((p: string) => readFileSync(p));
  const startServer = deps.createProviderServer ?? createProviderServer;

  // ── 1. Resolve the provider (unset/none/unrecognised/construct-throw ⇒ refuse). ──
  const requested = env[PROVIDER_ENV]?.trim();
  if (requested === undefined || requested === "" || requested === "none") {
    return refused(
      `${PROVIDER_ENV} must name a sandbox provider ("e2b") — the adapter-manager is the provider host and cannot boot without one`,
    );
  }
  if (requested !== "e2b") {
    return refused(`${PROVIDER_ENV}=${JSON.stringify(requested)} is not recognised (expected "e2b")`);
  }
  const template = env[TEMPLATE_ENV]?.trim();
  if (template === undefined || template === "") {
    return refused(`${PROVIDER_ENV}=e2b requires ${TEMPLATE_ENV} to name a sandbox template`);
  }
  let provider: SandboxProvider;
  try {
    const mod = await load();
    // No key passed: the transport reads the provider-control credential itself (DEP-006).
    // A missing credential throws SYNCHRONOUSLY from the transport constructor; that becomes
    // a refusal here (refuse-not-degrade), never an ungated boot.
    const transport = mod.createRealE2bTransport();
    provider = new mod.E2bSandboxProvider({ transport, templateId: template });
  } catch (err) {
    return refused(`sandbox provider could not be constructed: ${(err as Error).message}`);
  }

  // ── 2. Load + assert the control-plane PUBLIC key. This is the fail-open field: a
  // `undefined` key ⇒ an UNGATED server, so every failure below is a refusal, not a skip. ──
  const keyPath = env[CONTROL_PLANE_PUBLIC_KEY_FILE_ENV]?.trim();
  if (keyPath === undefined || keyPath === "") {
    return refused(
      `${CONTROL_PLANE_PUBLIC_KEY_FILE_ENV} must point at the ed25519 control-plane PUBLIC key (PEM SPKI) — ` +
        "the adapter-manager refuses to boot UNGATED (a missing key would leave create/execute unprotected)",
    );
  }
  let controlPlanePublicKey: KeyObject;
  try {
    // The seam cuts here — the injected reader returns raw bytes, and the REAL parser runs.
    const bytes = readKeyFileBytes(keyPath);
    if (bytes.toString("utf8").includes("PRIVATE KEY")) {
      // Key-hygiene: createPublicKey would silently derive the public half of a private key.
      // A mounted PRIVATE key is an operator error that must fail loudly, not be accepted.
      return refused(
        `${CONTROL_PLANE_PUBLIC_KEY_FILE_ENV} points at a PRIVATE key — mount the ed25519 PUBLIC SPKI PEM only`,
      );
    }
    // createPublicKey MUST sit inside this try: an unparseable PEM throws here, and that
    // throw is a refusal (a catch scoped only to the read, or a default to undefined, would
    // fail OPEN). Single-arg form ⇒ Node defaults to PEM (no format arg).
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      return refused(
        `${CONTROL_PLANE_PUBLIC_KEY_FILE_ENV} is a ${String(key.asymmetricKeyType)} key, expected ed25519`,
      );
    }
    controlPlanePublicKey = key;
  } catch (err) {
    return refused(
      `${CONTROL_PLANE_PUBLIC_KEY_FILE_ENV} could not be loaded as an ed25519 PUBLIC key: ${(err as Error).message}`,
    );
  }

  // ── 2.5. Resolve the reaper start decision BEFORE listening (B2C-F6): flag-on but the
  // control-plane URL missing is a loud REFUSAL, not a half-started server with a
  // silently-dead reaper. Flag-off is the only clean no-op. ──
  const reaperConfig = resolveReaperConfig(env);
  if (reaperConfig.kind === "refused") {
    return refused(reaperConfig.reason);
  }

  // ── 3. Both resolved — construct the GATED server and listen. β1's ledger points at the
  // configured out-of-tree volume when set; otherwise the server defaults to an OS temp dir. ──
  // The reaper metric counter is created HERE, BEFORE startServer (B2C-F9), and shared with
  // BOTH the server's /metrics arm AND the loop below (single event loop ⇒ no race).
  const reaperMetrics = createReaperMetrics();
  const idempotencyLedgerDir = env[IDEMPOTENCY_LEDGER_DIR_ENV]?.trim() || undefined;
  const server = startServer({ provider, controlPlanePublicKey, idempotencyLedgerDir, reaperMetrics });
  // The staging compose pins PORT (=8090) + a :8090/healthz check; unset ⇒ an ephemeral port.
  server.listen(env.PORT);

  // ── 4. Arm the reaper loop (ONLY when enabled — flag-off left this a no-op above). The
  // reconcile thunk closes over the raw `provider`, a per-op-fresh makeCtx, and B2's real
  // resolveTruth; tick containment lives in `startReaperLoop`. ──
  if (reaperConfig.kind === "enabled") {
    const logger: ReaperLogger = {
      info: (obj, msg) => console.log(msg, obj),
      error: (obj, msg) => console.error(msg, obj),
    };
    // DEP-012 Slice 4+5 (P3) — the AM↔CP shared-secret bearer, read HERE via `env[CONST]`
    // (never a `process.env.AOA_…` literal in this package). Additive: unset ⇒ no header
    // (the CP truth route stays double-gated + inert). The reaper client never rejects, so
    // a mismatch degrades to CP-404 → "unknown", never a mass-reclaim.
    const truthSharedSecret = env[TRUTH_SHARED_SECRET_ENV]?.trim() || undefined;
    const resolveTruth = makeControlPlaneResolveTruth(
      reaperConfig.controlPlaneUrl,
      undefined,
      undefined,
      truthSharedSecret,
    );
    const makeCtx = (): ProviderOpContext => ({
      deadlineMs: Date.now() + reaperConfig.intervalMs,
      idempotencyKey: randomUUID(),
    });
    const reconcile = async () => {
      const result = await reconcileReaper({ provider, resolveTruth, makeCtx, now: () => Date.now(), logger });
      accumulateReaperMetrics(reaperMetrics, result);
      return result;
    };
    startReaperLoop({
      scheduler: deps.reaperScheduler ?? realReaperScheduler,
      reconcile,
      logger,
      intervalMs: reaperConfig.intervalMs,
    });
  }

  return { kind: "listening", server };
}

async function main(): Promise<void> {
  const result = await bootAdapterManager({ env: process.env });
  if (result.kind === "refused") {
    console.error(`adapter-manager refused to boot: ${result.reason}`);
    process.exit(1);
  }
  console.log(`adapter-manager listening (PORT=${process.env.PORT ?? "<ephemeral>"})`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
