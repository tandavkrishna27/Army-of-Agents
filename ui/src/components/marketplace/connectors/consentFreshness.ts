/**
 * Consent-token freshness.
 *
 * A consent token minted by `GET …/mcp-connectors/catalog` lives
 * `CONSENT_TOKEN_TTL_MS` (15 minutes) and binds to the exact `(entryId,
 * command, args)` that same response carried. A shelf rendered and then left
 * alone — a founder opens Settings, wanders off, comes back — therefore holds a
 * token the server will reject with a 400 the moment Install is pressed.
 *
 * Rather than translating that 400 into apologetic copy after the fact, the
 * shelf refetches BEFORE opening the dialog whenever this returns false. The
 * refetch also re-reads the catalog, so the command the founder is shown is
 * once again the command the token signs — which is the property the whole
 * consent mechanism exists to guarantee.
 *
 * Deliberately NOT `expiresAt > now`: a token with four seconds left renders a
 * dialog the founder cannot realistically read and confirm in time. The margin
 * is the expected human dwell time in the dialog, not a clock-skew allowance.
 */
export const CONSENT_REFRESH_MARGIN_MS = 60_000;

export function isConsentFresh(
  entry: { consentToken?: string; consentExpiresAt?: number },
  now: number = Date.now(),
): boolean {
  if (!entry.consentToken || typeof entry.consentExpiresAt !== "number") return false;
  return entry.consentExpiresAt - now > CONSENT_REFRESH_MARGIN_MS;
}
