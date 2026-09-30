// packages/worker-keystore/src/bin/sandbox-provider.ts
//
// DEP-010 (Sprint 2) — THE ONE FILE that may name `@armyofagents/sandbox-e2b-provider`.
//
// `scripts/lib/worker-keystore-boundary.mjs` (PROVIDER_HOST_PATH) rejects that package from
// every other runtime source path here, because its transitive closure pulls the `e2b`
// network SDK into a process that holds the device private key. Confining it to one reviewable
// file is the tighter-guard half of go-book §8 decision D-3.
//
// WHY THE IMPORT IS A LITERAL DYNAMIC `import(...)`. A static import would load the `e2b` SDK
// at module scope on EVERY boot — including the default desktop boot that constructs no
// provider (`@armyofagents/sandbox-e2b-provider`'s barrel statically re-exports the transport,
// which imports `e2b`). The dynamic import defers that to the opt-in path only.
//
// WHY THE PROVIDER-CONTROL CREDENTIAL IS NOT NAMED HERE. This file passes NO key to the
// transport: `createRealE2bTransport()` reads the credential itself (DEP-006 confinement, in
// the e2b leaf's `real-transport.ts`), so the key never crosses this package. The boundary
// checker now forbids the credential's NAME outright in this package's runtime source — so it
// is not spelled here even in prose. A missing credential surfaces by PROPAGATING the
// transport's own synchronous constructor error into a `refused` reason (that message names
// the variable; this file does not).
//
// WHY A BAD CONFIGURATION IS A REFUSAL, NOT A DEGRADE. `kind: "none"` means "no provider was
// requested" — the shipped default. `kind: "refused"` means "a provider WAS requested and
// could not be honoured." An explicit opt-in that silently degraded to no-provider would show
// the operator `no_provider` (the message for a build that CANNOT have one) and send them to
// rebuild something already fine. An opt-in that cannot be honoured must fail loudly.

import type { SandboxProvider } from "@armyofagents/worker-daemon";

/** The switch that opts a desktop boot into a real provider. Unset ⇒ `{kind:"none"}`. */
export const PROVIDER_ENV = "AOA_WORKER_SANDBOX_PROVIDER";
/** The E2B sandbox template. Required when `PROVIDER_ENV=e2b`; absent ⇒ a refusal to boot. */
export const TEMPLATE_ENV = "AOA_WORKER_E2B_TEMPLATE";

/** The provider kinds this resolver understands. `none` is the shipped default. */
export const PROVIDER_KINDS = ["e2b", "none"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type ProviderResolution =
  | { readonly kind: "none" }
  | { readonly kind: "provider"; readonly provider: SandboxProvider }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The STRUCTURAL shape consumed from the provider package. Declared here so this file can name
 * `E2bSandboxProvider` and `createRealE2bTransport` for the loader without a STATIC import that
 * would pull the `e2b` SDK in at module load. The injected-loader seam also lets a test pair the
 * REAL provider with a MOCK transport without the mock ever being reachable from production.
 */
export interface ProviderModule {
  readonly E2bSandboxProvider: new (options: {
    readonly transport: unknown;
    readonly templateId?: string;
  }) => SandboxProvider;
  readonly createRealE2bTransport: () => unknown;
}

export type ProviderModuleLoader = () => Promise<ProviderModule>;

/** The default loader: a LITERAL dynamic import so the boundary checker accepts it and the SDK
 * is loaded only on the opt-in path. This is the ONE reference to the provider package. */
export const loadProviderModule: ProviderModuleLoader = async () =>
  (await import("@armyofagents/sandbox-e2b-provider")) as unknown as ProviderModule;

/**
 * Resolve a sandbox provider from the environment, or refuse — never guess.
 *
 * The loader is NOT called on the `none` path, so the `e2b` SDK does not enter the process
 * image of a default desktop boot.
 */
export async function resolveSandboxProvider(
  env: Record<string, string | undefined>,
  load: ProviderModuleLoader = loadProviderModule,
): Promise<ProviderResolution> {
  const requested = env[PROVIDER_ENV]?.trim();
  if (requested === undefined || requested === "" || requested === "none") {
    return { kind: "none" };
  }
  if (requested !== "e2b") {
    return {
      kind: "refused",
      reason: `${PROVIDER_ENV}=${JSON.stringify(requested)} is not a recognised provider (expected "e2b", "none", or unset)`,
    };
  }
  const template = env[TEMPLATE_ENV]?.trim();
  if (template === undefined || template === "") {
    return {
      kind: "refused",
      reason: `${PROVIDER_ENV}=e2b requires ${TEMPLATE_ENV} to name a sandbox template`,
    };
  }
  try {
    const mod = await load();
    // No key passed: the transport reads the provider-control credential itself (DEP-006).
    // A missing credential throws SYNCHRONOUSLY from the transport constructor; we turn that
    // into a refusal by propagating the message, which names the variable — this file does not.
    const transport = mod.createRealE2bTransport();
    const provider = new mod.E2bSandboxProvider({ transport, templateId: template });
    return { kind: "provider", provider };
  } catch (err) {
    return { kind: "refused", reason: (err as Error).message };
  }
}
