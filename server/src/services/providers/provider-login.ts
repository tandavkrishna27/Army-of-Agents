/**
 * Whether a provider may expose an IN-APP "Sign in" button.
 *
 * The bar is not "does a login command exist" — it is "can that login finish
 * without a terminal". Only one provider clears it today:
 *
 *   - `codex login` (openai) spawns a local callback listener on :1455, so the
 *     founder opens the URL, signs in, and the CLI finalizes on its own. The
 *     lifecycle in commander-login.ts observes the child's exit plus the
 *     credential file and reports `completed`.
 *   - `claude auth login` (anthropic) redirects to a REMOTE callback and then
 *     BLOCKS on a stdin "Paste code here" prompt. The runner can surface the URL
 *     but the child never finishes, so an in-app button would spin until the
 *     5-minute completion deadline reaps it and reports `timeout`. See the
 *     comment in packages/adapters/claude-local/src/server/login.ts.
 *   - everything else has no wired runner at all.
 *
 * So the catalog's `credential.selfCompletingLogin` is the single gate, pinned
 * by the catalog test ("only claims selfCompletingLogin where it is actually
 * wired"). Providers that fail the gate expose `credential.manualLoginCommand`,
 * which the UI renders as copyable text — a command a founder can run beats a
 * button that cannot complete.
 *
 * Stage B adds a provider by flipping `selfCompletingLogin` in the catalog AND
 * adding a runner entry in commander-login-runtime.ts. Nothing here changes.
 */
import { getProviderById } from "@armyofagents/shared";

export interface LoginCapability {
  canLogin: boolean;
  /** Present only when a non-self-completing provider documents a CLI command. */
  manualCommand?: string;
}

export function resolveLoginCapability(providerId: string): LoginCapability {
  const descriptor = getProviderById(providerId);
  if (!descriptor) throw new Error(`Unknown provider: ${providerId}`);
  if (descriptor.credential.selfCompletingLogin) return { canLogin: true };
  const manualCommand = descriptor.credential.manualLoginCommand;
  return { canLogin: false, ...(manualCommand ? { manualCommand } : {}) };
}
