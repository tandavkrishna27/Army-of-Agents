import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { commanderLoginChallenges, providerCredentials } from "@armyofagents/db";
import { and, eq, sql } from "drizzle-orm";
import { runCodexLogin } from "@armyofagents/adapter-codex-local/server";
import {
  runClaudeLoginStreaming,
  CLAUDE_CREDENTIAL_FILE_NAME,
} from "@armyofagents/adapter-claude-local/server";
import { terminateByPidIfMatches } from "../utils/terminate-process.js";
import {
  createCommanderLoginService,
  type ChallengeRow,
  type ChallengeStore,
  type CommanderLoginProvider,
  type CommanderLoginService,
  type LoginRunLike,
} from "./commander-login.js";
import {
  assertProviderLoginUrl,
  prepareScopedCliAuthHome,
  resolveCliAuthTopology,
  scopedCliAuthEnv,
} from "./cli-auth-topology.js";
import { loadConfig } from "../config.js";
import { assertSubscriptionAllowed } from "./provider-connections.js";

/** Route-facing discovery cap — bounds how long `start` waits for the URL. */
const LOGIN_URL_DISCOVERY_MS = 60_000;

/**
 * Everything provider-specific about driving an interactive CLI login, in ONE
 * place (Task 9b). Previously these three concerns were three separate
 * `provider === "openai" ? … : …` ternaries, which made "add a provider" mean
 * "find and correctly extend every ternary, and get the ELSE branch right" —
 * the else branch silently claimed every unknown provider was Claude.
 */
interface ProviderLoginRunner {
  /**
   * The credential home this login writes into. NOTE it takes only `env` — there
   * is no companyId — so the (provider, authHome) single-flight slot is
   * HOST-shared and genuinely cross-tenant. Two companies on one host contend
   * for one slot; the loser gets a 409.
   */
  runLogin: (args: { runId: string; env: NodeJS.ProcessEnv; authHome: string }) => LoginRunLike;
  /**
   * Completion evidence, relative to authHome (Codex P1 #9 — do NOT hardcode
   * auth.json for both):
   *   - openai/codex → `auth.json`
   *   - anthropic/claude → `CLAUDE_CREDENTIAL_FILE_NAME` (`.credentials.json`)
   *
   * Claude's is imported from the adapter rather than re-spelled here: crew
   * config-home provisioning copies the SAME file, and two literals would let
   * "which file is the credential" drift between the two answers.
   */
  credentialFileName: string;
}

/**
 * Keyed by the catalog's `ProviderId`. Presence here is what makes a provider
 * DRIVABLE; the catalog's `selfCompletingLogin` is separately what makes it
 * OFFERABLE in-app (see services/providers/provider-login.ts). Anthropic is
 * drivable but not offerable — the onboarding Verify step drives it and accepts
 * that the founder finishes in a terminal.
 */
const LOGIN_RUNNERS: Partial<Record<CommanderLoginProvider, ProviderLoginRunner>> = {
  openai: {
    runLogin: (args) =>
      runCodexLogin({
        runId: args.runId,
        env: scopedCliAuthEnv(args.env, args.authHome, "openai"),
        discoveryTimeoutMs: LOGIN_URL_DISCOVERY_MS,
      }),
    credentialFileName: "auth.json",
  },
  anthropic: {
    runLogin: (args) =>
      runClaudeLoginStreaming({
        runId: args.runId,
        env: scopedCliAuthEnv(args.env, args.authHome, "anthropic"),
        discoveryTimeoutMs: LOGIN_URL_DISCOVERY_MS,
      }),
    credentialFileName: CLAUDE_CREDENTIAL_FILE_NAME,
  },
};

/**
 * Whether an interactive login runner is wired for this provider at all.
 *
 * A VALUE check, not `hasOwnProperty` (review M-1). On a `Partial<Record<…>>`
 * an entry written `google: undefined` — precisely the half-finished Stage B
 * edit this gate exists to catch — HAS the own property, so a presence check
 * would wave it through the route's 400 guard and into `requireLoginRunner`'s
 * throw, surfacing as a 502 "sign-in could not start" instead of the honest
 * 400 "no in-app sign-in for this provider".
 */
export function hasLoginRunner(providerId: string): providerId is CommanderLoginProvider {
  return LOGIN_RUNNERS[providerId as CommanderLoginProvider] !== undefined;
}

/**
 * Exported for test (review I-2): this throw is the ENTIRE guard against
 * spawning the wrong provider's CLI against the wrong credential home, so it
 * needs a test of its own. Without it a "helpful" default would reintroduce
 * that hazard with a fully green suite.
 */
export function requireLoginRunner(provider: CommanderLoginProvider): ProviderLoginRunner {
  const runner = LOGIN_RUNNERS[provider];
  // Explicit throw rather than an implicit "else = claude" fallback: driving the
  // WRONG CLI would spawn a login against another provider's credential home.
  if (!runner) throw new Error(`No interactive login runner for provider: ${provider}`);
  return runner;
}

function mapRow(r: typeof commanderLoginChallenges.$inferSelect): ChallengeRow {
  return {
    id: r.id,
    companyId: r.companyId,
    provider: r.provider as CommanderLoginProvider,
    authHome: r.authHome,
    loginUrl: r.loginUrl,
    pid: r.pid,
    pgid: r.pgid,
    status: r.status as ChallengeRow["status"],
    startedByUserId: r.startedByUserId,
    startedAt: r.startedAt,
  };
}

/** Exported for tests (commander-login-runtime-store.test.ts). */
export function drizzleChallengeStore(db: Db): ChallengeStore {
  return {
    async claim({ provider, authHome, row, onExisting }) {
      // Atomic single-flight claim (Codex P1): the (provider, auth_home,
      // status) index is NON-unique, so without mutual exclusion two
      // overlapping starts both see "no pending row" and both insert.
      // Serialized by a transaction-scoped advisory lock on the slot key —
      // same pattern as first-user-bootstrap.ts.
      return await (
        db as unknown as { transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> }
      ).transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`commander-login:${provider}:${authHome}`}))`,
        );
        const [existing] = await tx
          .select()
          .from(commanderLoginChallenges)
          .where(
            and(
              eq(commanderLoginChallenges.provider, provider),
              eq(commanderLoginChallenges.authHome, authHome),
              eq(commanderLoginChallenges.status, "pending"),
            ),
          )
          .orderBy(commanderLoginChallenges.startedAt)
          .limit(1);
        if (existing) {
          // Throws on conflict → transaction rolls back, nothing inserted.
          onExisting(mapRow(existing));
          await tx
            .delete(commanderLoginChallenges)
            .where(eq(commanderLoginChallenges.id, existing.id));
        }
        await tx.insert(commanderLoginChallenges).values({
          id: row.id,
          companyId: row.companyId,
          provider: row.provider,
          authHome: row.authHome,
          loginUrl: row.loginUrl,
          pid: row.pid,
          pgid: row.pgid,
          status: row.status,
          startedByUserId: row.startedByUserId,
          startedAt: row.startedAt,
        });
        return row;
      });
    },
    async get(id) {
      const [r] = await db
        .select()
        .from(commanderLoginChallenges)
        .where(eq(commanderLoginChallenges.id, id))
        .limit(1);
      return r ? mapRow(r) : null;
    },
    async update(id, patch) {
      // `.returning({ id })` reports rows AFFECTED (Codex round-8 P1): the pid/pgid
      // backfill uses a 0-row result to detect that a concurrent removal deleted this
      // row (superseded → the caller self-cleans its child). Since the F1 refusal a
      // same-company takeover can no longer delete an in-flight pid-null row; the
      // residual remover is a founder `cancel` / the boot `reapOrphans`.
      const updated = await db
        .update(commanderLoginChallenges)
        .set({ ...patch, updatedAt: new Date(), finishedAt: patch.status && patch.status !== "pending" ? new Date() : undefined })
        .where(eq(commanderLoginChallenges.id, id))
        .returning({ id: commanderLoginChallenges.id });
      return updated.length;
    },
    async remove(id) {
      await db.delete(commanderLoginChallenges).where(eq(commanderLoginChallenges.id, id));
    },
    async listActive() {
      const rows = await db
        .select()
        .from(commanderLoginChallenges)
        .where(eq(commanderLoginChallenges.status, "pending"));
      return rows.map(mapRow);
    },
  };
}

/**
 * Wire the login lifecycle to Drizzle + the real provider runners. Shared by
 * the route (start/status/cancel) and the boot reaper (index.ts).
 */
export function buildCommanderLoginService(db: Db): CommanderLoginService {
  // Deployment topology is fixed for the process lifetime — resolve once. Personal-
  // subscription logins are banned on a shared multi-tenant host; this is the
  // login-runtime mint-path backstop the provider-connections.ts BOOT INVARIANT
  // docstring requires, so a hosted instance cannot even record a PENDING
  // personal_subscription credential (the create route + verify() already gate it).
  const loginTopology = resolveCliAuthTopology({
    deploymentMode: loadConfig().deploymentMode,
    deploymentExposure: loadConfig().deploymentExposure,
  });
  return createCommanderLoginService({
    store: drizzleChallengeStore(db),
    resolveAuthHome: (provider, env, scope) => {
      requireLoginRunner(provider);
      return prepareScopedCliAuthHome({
        env,
        executionTargetId: scope.executionTargetId,
        companyId: scope.companyId,
        userId: scope.userId,
        provider,
      });
    },
    runLogin: (provider, args): LoginRunLike => {
      const run = requireLoginRunner(provider).runLogin(args);
      return {
        ...run,
        urlPromise: run.urlPromise.then((url) => assertProviderLoginUrl(provider, url)),
      };
    },
    credentialPresent: async (provider, authHome) => {
      const file = path.join(authHome, requireLoginRunner(provider).credentialFileName);
      const stat = await fs.stat(file).catch(() => null);
      return Boolean(stat?.isFile());
    },
    onCredentialEvidence: async ({ companyId, provider, userId, executionTargetId }) => {
      // Fail closed on a shared multi-tenant host: never even record a pending
      // personal_subscription credential (mirrors the create route + verify() gate).
      assertSubscriptionAllowed("personal_subscription", loginTopology);
      const now = new Date();
      await db
        .insert(providerCredentials)
        .values({
          companyId,
          provider,
          ownerUserId: userId,
          executionTargetId,
          kind: "personal_subscription",
          state: "pending",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            providerCredentials.companyId,
            providerCredentials.provider,
            providerCredentials.ownerUserId,
            providerCredentials.executionTargetId,
            providerCredentials.kind,
          ],
          set: {
            state: "pending",
            verifiedAt: null,
            revokedAt: null,
            suspendedAt: null,
            updatedAt: now,
          },
        });
    },
    // Persisted-pid kill — ALWAYS identity-verified (Codex P1, round 6 →
    // round 7). Every caller (BOOT reaper, single-flight takeover in `onExisting`,
    // AND `cancel`) kills a pid read from a DB row that may have been REUSED after
    // a crash + restart, so `terminateByPidIfMatches` checks the target's OS start
    // time against the recorded `startedAt` and refuses to kill a reused pid. The
    // only UNCONDITIONAL kills are the LIVE in-memory `run.handle.terminate()`
    // calls in the service (this process's own child — not PID-reuse-prone), which
    // never route through this seam.
    terminate: (pid, pgid, expected) => void terminateByPidIfMatches(pid, pgid, expected),
    newId: () => randomUUID(),
    env: () => process.env,
  });
}
