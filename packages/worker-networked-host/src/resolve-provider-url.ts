// packages/worker-networked-host/src/resolve-provider-url.ts
//
// DEP-011 Slice 2b-ii — resolve the adapter-manager base URL from the environment.
//
// The FIRST code reader of `AOA_WORKER_PROVIDER_URL` (it was set DEAD in
// `docker-compose.d1.yml` before this slice, "read by NO code"). The switch that opts a
// container boot into the networked provider: set ⇒ the bin builds a per-run
// `makeRunProvider` factory over that URL; unset/empty ⇒ `{kind:"none"}`, and the bin boots
// exactly as the inert `worker-daemon`/`container-host` default (refuses `no_provider`).
//
// Mirrors `worker-keystore/src/bin/sandbox-provider.ts`'s `{kind:"none"|…}` resolution shape.
// The `{kind:"none"}` default is what the boot-roots guard's `resolverNoneMarker` pins: this
// resolver's shipped default resolves to NO provider, so the new bin can never become a
// zero-gate boot root.

/** The switch that opts a container boot into the networked provider. Unset ⇒ `{kind:"none"}`. */
export const PROVIDER_URL_ENV = "AOA_WORKER_PROVIDER_URL";

export type ProviderUrlResolution =
  | { readonly kind: "none" }
  | { readonly kind: "url"; readonly url: string };

/**
 * Resolve the adapter-manager base URL, or `{kind:"none"}` when `AOA_WORKER_PROVIDER_URL` is
 * unset/empty/whitespace — the shipped default. No validation beyond presence: an ill-formed
 * URL surfaces when the driver first dials it (construction is inert; I/O only on an op call),
 * exactly as `NetworkedProviderDriver` normalizes and uses it lazily.
 */
export function resolveProviderUrl(env: Record<string, string | undefined>): ProviderUrlResolution {
  const raw = env[PROVIDER_URL_ENV]?.trim();
  if (raw === undefined || raw === "") return { kind: "none" };
  return { kind: "url", url: raw };
}
