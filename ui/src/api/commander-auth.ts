import { api } from "./client";
import type { CommanderProvider } from "@armyofagents/shared";

/**
 * Commander auth client (Plan 3 / §6.1+§6.2). Two ways to make the Commander
 * CLI usable from onboarding's Verify step without touching a terminal:
 *  - `saveCommanderKey` — paste an API key (stored encrypted server-side; the
 *    raw value never comes back).
 *  - `startCommanderLogin` / `getCommanderLoginStatus` — drive the interactive
 *    device login; open `loginUrl`, poll until `completed`, then re-verify.
 *  - `cancelCommanderLogin` — abandon a still-pending challenge (e.g. the founder
 *    navigates away) so the detached CLI child + the shared login slot are freed.
 */

export type CommanderLoginStatus = "pending" | "completed" | "failed" | "timeout";
export type CommanderSubscriptionMode = "device_code" | "paste_code" | "none";
export type CommanderAuthCapability = {
  provider: CommanderProvider;
  mode: CommanderSubscriptionMode;
  enabled: boolean;
  browserSafeRemotely: boolean;
  reason: string | null;
  cliInstalled?: boolean;
  cliVersion?: string | null;
  cliVersionSupported?: boolean;
};

export function getCommanderAuthCapabilities(args: {
  companyId: string;
}): Promise<{
  topology: {
    platform: string;
    installProfile: string;
    networkLocation: "local" | "remote";
    trustBoundary: string;
    executionOwnership: string;
  };
  providers: Record<CommanderProvider, CommanderAuthCapability>;
}> {
  return api.get(`/companies/${args.companyId}/internal-agent/commander-login/capabilities`);
}

export function saveCommanderKey(args: {
  companyId: string;
  provider: CommanderProvider;
  value: string;
}): Promise<{ ok: boolean; secretId: string; verification: "verified" }> {
  return api.post(`/companies/${args.companyId}/internal-agent/commander-key`, {
    provider: args.provider,
    value: args.value,
  });
}

export function startCommanderLogin(args: {
  companyId: string;
  provider: CommanderProvider;
}): Promise<{
  challengeId: string;
  loginUrl: string;
  mode: CommanderSubscriptionMode;
  userCode: string | null;
  expiresAt: string;
}> {
  return api.post(`/companies/${args.companyId}/internal-agent/commander-login/start`, {
    provider: args.provider,
  });
}

export function getCommanderLoginStatus(args: {
  companyId: string;
  challengeId: string;
}): Promise<{ status: CommanderLoginStatus; loginUrl: string | null }> {
  return api.get(`/companies/${args.companyId}/internal-agent/commander-login/${args.challengeId}`);
}

/**
 * Cancel a pending login challenge (founder-gated + company-scoped server-side).
 * Fire-and-forget from the UI: a cross-tenant or already-terminal id is a
 * server no-op, so callers don't need to await or handle the result.
 */
export function cancelCommanderLogin(args: {
  companyId: string;
  challengeId: string;
}): Promise<{ ok: boolean }> {
  return api.post(
    `/companies/${args.companyId}/internal-agent/commander-login/${args.challengeId}/cancel`,
    {},
  );
}

/**
 * Deliver the code the founder pasted from the browser sign-in page.
 *
 * Claude's `claude auth login` blocks reading this on stdin; the server writes
 * it to the live child. A 404/410 means the sign-in session is gone (server
 * restarted, or the CLI exited) and the founder must start again.
 */
export function submitCommanderLoginCode(args: {
  companyId: string;
  challengeId: string;
  code: string;
}): Promise<{ ok: true }> {
  return api.post(
    `/companies/${args.companyId}/internal-agent/commander-login/${encodeURIComponent(args.challengeId)}/code`,
    { code: args.code },
  );
}
