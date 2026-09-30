import type {
  PostAuthJourneyResult,
  OnboardingJourney,
  OnboardingState,
  FirstRunPersona,
} from "@armyofagents/shared";

export type FlowProgress = { completedStates: OnboardingState[] };

export async function getOnboardingProgress(companyId: string | null): Promise<FlowProgress | null> {
  const q = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const res = await fetch(`/api/onboarding/progress${q}`, { credentials: "include" });
  if (!res.ok) throw new Error(`progress fetch failed: ${res.status}`);
  const data = (await res.json()) as { progress?: { completedStates?: OnboardingState[] } | null };
  return data.progress ? { completedStates: data.progress.completedStates ?? [] } : null;
}

export async function advanceOnboarding(args: {
  companyId: string | null;
  journey: OnboardingJourney;
  requestedState: OnboardingState;
}): Promise<FlowProgress | null> {
  const res = await fetch("/api/onboarding/progress", {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`advance failed: ${res.status}`);
  const data = (await res.json()) as { progress?: { completedStates?: OnboardingState[] } | null };
  return data.progress ? { completedStates: data.progress.completedStates ?? [] } : null;
}

/** The FlowEngineApi backed by the real endpoints. */
export const onboardingApi = { getProgress: getOnboardingProgress, advance: advanceOnboarding };

/**
 * Fix 2 (dead-end fix, see CLAUDE.md WS0b note) — writes the WS0b
 * first-run-done flag. Originally called from the wizard's `ReviewStep.finish()`;
 * WS0c removed `ReviewStep` from the founder wizard (the wizard now ends at
 * the spine's terminal step, which does NOT call this — see
 * `SpineCompleteStep.tsx`) and the write moves to Home's first-run tail
 * (WS9). This function is kept here for WS9 to call. Until WS9 lands,
 * `server/src/services/home.ts`'s `isLegacySetupComplete` transitional
 * fallback covers a founder who never gets this write. Deliberately
 * best-effort: swallow any error/non-OK response and resolve either way
 * rather than surface it to the caller, since the caller must never block
 * navigation on this write.
 */
export async function setFirstRunCompleted(companyId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/onboarding/first-run", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, completed: true }),
    });
    if (!res.ok) {
      // Best-effort: the transitional home.ts fallback (isLegacySetupComplete)
      // covers this failing. Log for observability only. Returns false so the
      // caller can avoid clearing resume state on an unconfirmed write.
      console.warn(`setFirstRunCompleted: non-OK response (${res.status})`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("setFirstRunCompleted: request failed", e);
    return false;
  }
}

/**
 * WS9 — writes the WS0b door-band persona (`firstRunPersona`) via the same
 * endpoint `setFirstRunCompleted` uses. Best-effort like its sibling: the
 * caller (`FirstRunHome`) must never block navigation on this write — a
 * failed persona write just means a resumed session falls back to showing
 * the door band again (see `getFirstRunProgress` below), which is a safe,
 * re-askable default, not a dead end.
 */
export async function setFirstRunPersona(companyId: string, persona: FirstRunPersona): Promise<void> {
  try {
    const res = await fetch("/api/onboarding/first-run", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, firstRunPersona: persona }),
    });
    if (!res.ok) {
      console.warn(`setFirstRunPersona: non-OK response (${res.status})`);
    }
  } catch (e) {
    console.warn("setFirstRunPersona: request failed", e);
  }
}

export type FirstRunProgress = {
  firstRunPersona: FirstRunPersona | null;
  firstRunCompleted: boolean;
};

/**
 * WS9 — reads the WS0b persona/completion fields for the door-band resume
 * check (`FirstRunHome`: "if firstRunPersona is already in_flight, skip the
 * door band"). Reuses the existing GET progress endpoint (server already
 * projects `firstRunPersona`/`firstRunCompletedAt` on every row — see
 * `services/onboarding.ts` `mapRow`) rather than adding a new route.
 */
export async function getFirstRunProgress(companyId: string): Promise<FirstRunProgress> {
  const res = await fetch(`/api/onboarding/progress?companyId=${encodeURIComponent(companyId)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`progress fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    progress?: { firstRunPersona?: FirstRunPersona | null; firstRunCompletedAt?: string | null } | null;
  };
  return {
    firstRunPersona: data.progress?.firstRunPersona ?? null,
    firstRunCompleted: data.progress?.firstRunCompletedAt != null,
  };
}

/**
 * Fetch the post-auth journey for the signed-in user. The invite token (if any)
 * is NOT sent here — it lives in a server-side handoff consumed at accept time
 * (revC RC3); the server reads it from the handoff cookie when resolving the
 * invited journey.
 */
export async function fetchJourney(): Promise<PostAuthJourneyResult> {
  const res = await fetch("/api/onboarding/journey", { credentials: "include" });
  if (!res.ok) {
    // Carry the HTTP status — the terminal distinguishes a dead session (401 →
    // back to sign-in) from a transient failure (retry next tick).
    throw Object.assign(new Error(`journey fetch failed: ${res.status}`), { status: res.status });
  }
  return (await res.json()) as PostAuthJourneyResult;
}

/** Map a journey to the route the user should land on after login. */
export function destinationForJourney(j: PostAuthJourneyResult): string {
  if (j.journey === "returning") return "/";
  if (j.journey === "invited") return `/onboarding/join?company=${j.targetCompanyId ?? ""}`;
  return "/onboarding";
}

export type FinalizeInvitedJoinResult = {
  admitted: boolean;
  status: "approved" | "pending" | "rejected" | "invite_invalid";
};

/**
 * Invited auto-admit (spec §8): asks the server to finalize the caller's own
 * join request for the company — admits immediately when the verified email
 * matches the invite; otherwise the request stays pending for the founder.
 *
 * `opts.acceptOpenInvite` is the server-side consent assertion for the
 * tokenless/re-invite CLAIM branch (mirrors the terminal's "Join {company}"
 * click) — omit it for the filed-request path, which carried consent at
 * token-accept time.
 */
export async function finalizeInvitedJoin(
  companyId: string,
  opts?: { acceptOpenInvite?: boolean },
): Promise<FinalizeInvitedJoinResult> {
  const res = await fetch("/api/onboarding/join/finalize", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId, ...(opts?.acceptOpenInvite ? { acceptOpenInvite: true } : {}) }),
  });
  if (!res.ok) {
    // Carry the HTTP status — the terminal distinguishes a dead session (401 →
    // back to sign-in) from a transient failure (retry next tick).
    throw Object.assign(new Error(`finalize failed: ${res.status}`), { status: res.status });
  }
  return (await res.json()) as FinalizeInvitedJoinResult;
}
