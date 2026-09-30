import { ProviderUnavailableError } from "../provider-resolution.js";

/**
 * U12: founder-facing guidance for a cloud run that has no company provider
 * key configured. NEVER points at "install the CLI" — the operator login is
 * never used on the shared cloud pool, so the only actionable fix is
 * configuring a company key in Settings -> Providers.
 */
export class CloudProviderKeyMissingError extends Error {
  constructor(provider: string, sink: string) {
    super(
      `No ${provider} provider key is configured for this company. ${sink} runs on cloud require a ` +
      `company API key — configure it in Settings → Providers. (The operator login is never used on ` +
      `the shared cloud pool.)`,
    );
    this.name = "CloudProviderKeyMissingError";
  }
}

/**
 * Map a credential-resolution FAILURE to founder-facing guidance.
 *
 * WHY a catch-mapper, not a source-check gate: on cloud (multi_tenant) the ONLY
 * "no company key" outcome from resolveProviderCredential is a THROWN
 * ProviderUnavailableError (provider-resolution.ts:450) — it NEVER returns
 * source:"host_login_fallback" there (that branch is self-hosted-only, :449). So
 * there is nothing to assert on a RETURNED credential; the credential never
 * returns. Callers instead CATCH the throw (crew top-level catch in runner.ts;
 * Commander at the resolveCommanderSpawnEnvPatch call sites — deferred, see
 * CLAUDE.md/plan for the Commander wiring skip in this build) and pass it here.
 *
 * Returns the mapped guidance error when tenant isolation is enforced AND `err` is
 * a provider-unavailable failure; returns null otherwise (caller keeps the
 * original error). On desktop the resolver returns host_login_fallback and never
 * throws, so this is never triggered — the operator login stays legitimate.
 */
export function mapCloudProviderKeyError(
  err: unknown,
  opts: { tenantIsolationEnforced: boolean; provider: string; sink: string },
): CloudProviderKeyMissingError | null {
  if (!opts.tenantIsolationEnforced) return null;
  const isProviderUnavailable =
    err instanceof ProviderUnavailableError ||
    (!!err && typeof err === "object" && (err as { code?: string }).code === "provider_unavailable");
  return isProviderUnavailable ? new CloudProviderKeyMissingError(opts.provider, opts.sink) : null;
}
