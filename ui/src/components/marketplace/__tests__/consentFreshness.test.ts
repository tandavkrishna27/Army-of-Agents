/**
 * Consent-token freshness. Moved here with the shelf (Marketplace → Connectors);
 * the assertions are unchanged from the Settings-era suite.
 *
 * The margin is deliberately not "expires > now": a token with four seconds left
 * renders a dialog the founder cannot realistically read and confirm in time, so
 * the shelf refetches first.
 */
import { describe, it, expect } from "vitest";
import {
  isConsentFresh,
  CONSENT_REFRESH_MARGIN_MS,
} from "../connectors/consentFreshness";

describe("isConsentFresh", () => {
  const now = 1_000_000;

  it("is false without a token", () => {
    expect(isConsentFresh({ consentExpiresAt: now + 10 * 60_000 }, now)).toBe(false);
  });

  it("is false when the token expires inside the safety margin", () => {
    expect(
      isConsentFresh(
        { consentToken: "t", consentExpiresAt: now + CONSENT_REFRESH_MARGIN_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  it("is true for a comfortably live token", () => {
    expect(
      isConsentFresh(
        { consentToken: "t", consentExpiresAt: now + CONSENT_REFRESH_MARGIN_MS + 1 },
        now,
      ),
    ).toBe(true);
  });
});
