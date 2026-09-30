/**
 * MIG-008 (E10 desktop-migration) D3 — ADDITIVE E2B provider-control credential
 * authority move.
 *
 * The adapter boundary (`packages/sandbox-e2b-provider/src/real-transport.ts`,
 * `RealE2bTransportOptions.apiKey`) is the credential source of truth for
 * reconciled/new work: the default key comes from the confined env read; a
 * per-company BYO key is resolved via `resolveRuntimeProviderConfig`
 * (`environment-runtime.ts`) and injected — NEVER persisted. This module is the
 * AoA-side resolver + attribution primitive:
 *
 *   - a per-company monotonic KEY-GENERATION attribution tag (derived from the
 *     `company_secret_versions` / `runtime_provider_keys` pointer) recorded on the
 *     crosswalk + resolvable at inject time; and
 *   - an OLD-KEY-DENIAL primitive: it refuses to resolve/inject a superseded
 *     generation.
 *
 * IMPORTANT (Decision #104 / D3 §5.2): this is ADDITIVE. The live inline
 * `resolveE2bApiKey` path in `sandbox-provider-runtime.ts` is NOT removed — it is
 * retired when MIG-006/007 cut crew/one-shot execution over. This module makes the
 * boundary authoritative for reconciled/new work only. The LIVE force-kill of
 * sandboxes tagged with a superseded generation was deferred here to REL-004's kill-switch
 * primitive (§5.3), and REL-004 Lane D has now BUILT it: the acquire path records the generation
 * into `environment_leases.metadata.keyGeneration`, and the warm-sandbox reaper reclaims PAUSED
 * snapshots whose recorded generation is no longer current. Scoped to paused deliberately — a
 * superseded snapshot is dead weight because THIS module refuses to resolve the old generation,
 * so AoA will never resume it; live work is left to drain. This module still builds only the
 * AoA-side resolve/inject refusal.
 *
 * No hosted-API call is added (Rule #11): the E2B provider-control key is a
 * confined credential, not an LLM/embeddings call.
 */

/**
 * A key-generation ATTRIBUTION identity. It is SECRET-AWARE — the composite of the
 * backing secret id + its intra-secret version — because the default-e2b
 * `runtime_provider_keys.secretId` is a REPOINTABLE FK and `companySecretVersions.version`
 * restarts at 1 per secret. A bare per-secret version is NOT monotonic across a
 * rotation (repoint old secret v5 → fresh secret v1), so comparing bare versions would
 * ACCEPT a rotated-away key. The identity is serialized as `"<secretId>:<version>"`.
 */
export function formatKeyGeneration(secretId: string, version: number): string {
  return `${secretId}:${version}`;
}

function parseKeyGeneration(generation: string): { secretId: string; version: number } | null {
  const idx = generation.lastIndexOf(":");
  if (idx <= 0) return null;
  const secretId = generation.slice(0, idx);
  const version = Number(generation.slice(idx + 1));
  if (!Number.isFinite(version)) return null;
  return { secretId, version };
}

/** Raised when a superseded (older / rotated-away) key generation is requested. */
export class SupersededKeyGenerationError extends Error {
  readonly requestedGeneration: string;
  readonly currentGeneration: string;
  constructor(requestedGeneration: string, currentGeneration: string) {
    super(
      `E2B key generation ${requestedGeneration} is superseded by current generation ${currentGeneration} — refusing to resolve/inject an old key`,
    );
    this.name = "SupersededKeyGenerationError";
    this.requestedGeneration = requestedGeneration;
    this.currentGeneration = currentGeneration;
  }
}

/**
 * Old-key denial (SECRET-AWARE): a requested generation is refused when it names a
 * DIFFERENT backing secret than the current one (a key from a repointed-away secret is
 * ALWAYS superseded — this is the ordinary "replace my E2B key" rotation), OR the same
 * secret at a strictly older version. A current/newer version of the SAME secret is
 * accepted. An unparseable generation string fails CLOSED (refused).
 */
export function assertKeyGenerationCurrent(
  requestedGeneration: string,
  currentGeneration: string,
): void {
  if (requestedGeneration === currentGeneration) return;
  const requested = parseKeyGeneration(requestedGeneration);
  const current = parseKeyGeneration(currentGeneration);
  if (requested === null || current === null) {
    throw new SupersededKeyGenerationError(requestedGeneration, currentGeneration);
  }
  // A different backing secret → the requested key was rotated away → superseded.
  // Same secret → a strictly-older intra-secret version is superseded.
  if (requested.secretId !== current.secretId || requested.version < current.version) {
    throw new SupersededKeyGenerationError(requestedGeneration, currentGeneration);
  }
}

export interface E2bCredentialResolverDeps {
  /** Confined env read (defaults to `process.env`). The default-key source. */
  readonly env: Record<string, string | undefined>;
  /**
   * Resolve the per-company E2B provider config (reuse `resolveRuntimeProviderConfig`).
   * A configured BYO key surfaces as `resolvedApiKey`; a company on the operator
   * default returns no key (env fallback fires).
   */
  resolvePerCompanyConfig(companyId: string): Promise<{ resolvedApiKey?: string }>;
  /** The current per-company key generation (secret-aware `"<secretId>:<version>"`), or null. */
  currentKeyGeneration(companyId: string): Promise<string | null>;
}

export interface ResolvedE2bCredential {
  /** The key to inject into `RealE2bTransportOptions.apiKey`. NEVER persisted. */
  readonly apiKey: string;
  /** The secret-aware generation this resolution was attributed with (recorded on the crosswalk). */
  readonly keyGeneration: string | null;
}

/**
 * Resolve the E2B provider-control credential for reconciled/new work at the
 * adapter boundary: a per-company BYO key when configured, else the confined env
 * default. Refuses a superseded generation (old-key denial). Returns ONLY the
 * apiKey to inject + the attribution generation — no config blob, no key material
 * beyond the injected apiKey.
 */
export async function resolveE2bCredentialAuthority(
  input: { companyId: string; requestedKeyGeneration?: string },
  deps: E2bCredentialResolverDeps,
): Promise<ResolvedE2bCredential> {
  const current = await deps.currentKeyGeneration(input.companyId);

  // Old-key denial: a caller asking to resolve/inject a specific generation must
  // not be handed a superseded one.
  if (input.requestedKeyGeneration !== undefined && current !== null) {
    assertKeyGenerationCurrent(input.requestedKeyGeneration, current);
  }

  const perCompany = await deps.resolvePerCompanyConfig(input.companyId);
  const byoKey =
    typeof perCompany.resolvedApiKey === "string" && perCompany.resolvedApiKey.length > 0
      ? perCompany.resolvedApiKey
      : null;
  const envDefault = deps.env.E2B_API_KEY;
  const apiKey = byoKey ?? (typeof envDefault === "string" && envDefault.length > 0 ? envDefault : null);

  if (!apiKey) {
    throw new Error(
      "E2B credential authority: no per-company BYO key and no confined E2B_API_KEY default available",
    );
  }

  return { apiKey, keyGeneration: current };
}
