/**
 * Non-blocking cloud onboarding guidance. On AoA Cloud (`cloud_auth`) the shared
 * host has no per-company keyless-CLI login to borrow, so agents / Commander
 * fail closed until the founder sets a per-company provider key. This
 * callout routes them to Settings → Providers. Renders nothing on self-hosted
 * (keyless-CLI still works there). Pure/presentational — the mount site supplies
 * `deploymentMode`.
 *
 * NOTE: Extraction is deliberately NOT in that list. Extraction is CLI-only
 * (Decision #104 / CLAUDE.md Rule #11) and never reads a provider key, so a
 * provider key does not enable it. Do not re-add "extraction" here.
 */
export function CloudProviderKeyNotice({
  deploymentMode,
}: {
  deploymentMode?: string | null;
}) {
  if (deploymentMode !== "cloud_auth") return null;
  return (
    <div
      data-testid="cloud-provider-key-notice"
      className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-left text-xs text-dim"
    >
      <p className="text-text">You're on AoA Cloud.</p>
      <p>
        Agents and Commander run on a per-company provider key. Set one in
        Settings → Providers so your agents can run — you can finish setup first, this
        isn't required to continue.
      </p>
      <a
        href="/settings?tab=providers"
        className="inline-block font-medium text-brand-hover underline underline-offset-2"
      >
        Open Settings → Providers
      </a>
    </div>
  );
}
