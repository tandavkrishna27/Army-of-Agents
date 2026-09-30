// server/src/services/execution-secret-brokers.ts
//
// DAT-008 slice 3 — the REAL value store behind the DAT-004 broker.
//
// `failClosedSecretBrokers` is the default, and its own comment says it stands
// "until DAT-005 wires the real chokepoints". DAT-005 wired the proxy but not the
// stores, so every resolve still throws. This binds the two arms DAT-008 needs and
// deliberately leaves the third fail-closed.
//
//   provider_key   -> the Company's `provider:<id>` secret, resolved by NAME
//   company_secret -> the agent's own secret, resolved by ID at its pinned version
//   connector_oauth -> STILL FAIL-CLOSED (see below)
//
// `connector_oauth` belongs to the `fence_proxy` credential class, whose value is
// rendered into request headers inside the egress proxy and must never reach a
// sandbox or a worker. Wiring it here would make it reachable from the
// sandbox-local redemption route, which is exactly the coercion DAT-004's own review
// had to fix once. It stays throwing until its own path is built.
//
// The broker runs AFTER `resolveExecutionSecret` has authorized the resolve behind an
// active fence, so this module performs no authorization of its own — by design. It
// is a value lookup, and treating it as a second gate would split the authority.

import type { Db } from "@armyofagents/db";
import { heartbeatRuns } from "@armyofagents/db";
import { and, desc, eq } from "drizzle-orm";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { secretService, type SecretConsumerContext } from "./secrets.js";
import type { SecretBrokerSet } from "./secret-broker.js";

/** Parse the stored selector back into what `resolveSecretValue` takes. Anything that
 * is not a positive integer resolves as `latest`, which is also the canonical default
 * for an unpinned ref — a malformed selector must not become version 0 or NaN. */
export function parseSecretVersion(refVersion: string | null): number | "latest" {
  if (refVersion === null || refVersion === "latest") return "latest";
  const parsed = Number(refVersion);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : "latest";
}

/**
 * The consumer context for an execution-secret resolve.
 *
 * `consumerType: "system"` mirrors `resolveCompanyProviderKeys`' own narrowing and is
 * load-bearing rather than cosmetic: `shouldEnforceSecretBinding` would otherwise
 * demand a `company_secret_bindings` row, and `provider-key.ts` deliberately writes
 * none for a company-level default. Without the narrowing every provider-key resolve
 * would fail on a binding that by design never exists.
 */
function consumerContextFor(handleId: string): SecretConsumerContext {
  return {
    consumerType: "system",
    consumerId: handleId,
    configPath: null,
    actorType: "system",
  };
}

/**
 * DAT-007 / CLI-008 — the PURE-of-DB mint-at-resolve decision for a `run_jwt` handle.
 * Split from the wiring (which supplies the heartbeat_runs read + the JWT signer) so the
 * fail-closed logic + the run-id binding are unit-testable without a database.
 *
 * ★ THE R2 CRUX. classifyRunCurrency (DAT-007) FAILS OPEN on `!runFound` and on
 * `execution_owner !== 'distributed'`, so the minted `run_id` MUST resolve to the
 * distributed heartbeat_runs row the currency gate probes. The handle carries NO run id
 * (mint-at-resolve); `loadDistributedRun` re-derives it from the job's handoff marker
 * (distributed_job_id + execution_owner='distributed'), and this mints the JWT with THAT
 * run id. A missing distributed run, an owner that disagrees with the run's agent, or an
 * absent signing key all fail CLOSED (throw → coarse `malformed` at the wire) — a run_jwt
 * is never minted for a run the gate would not bind to.
 */
export interface RunJwtMintDeps {
  /** The distributed run backing this job, or null (fail-closed). */
  loadDistributedRun(input: { companyId: string; jobId: string }):
    Promise<{ runId: string; agentId: string } | null>;
  /** Mint the agent JWT; null when no signing key is configured (fail-closed). */
  mintAgentJwt(input: { agentId: string; companyId: string; runId: string }): string | null;
}

export async function resolveRunJwtValue(
  deps: RunJwtMintDeps,
  input: { companyId: string; refId: string; ownerPrincipalId: string | null },
): Promise<string> {
  const run = await deps.loadDistributedRun({ companyId: input.companyId, jobId: input.refId });
  // No distributed run → the currency gate would have nothing to bind to; never mint a
  // bearer whose run_id resolves to no distributed row (DAT-007 admits on !runFound).
  if (!run) throw new Error("run_jwt: no distributed run for job");
  // owner==executor: the handle's denormalized owner MUST match the re-derived run's
  // agent. A disagreement means two independent derivations diverged — fail closed,
  // never mint a bearer that authenticates as a different agent than the run's.
  if (input.ownerPrincipalId !== null && run.agentId !== input.ownerPrincipalId) {
    throw new Error("run_jwt: run agent does not match handle owner");
  }
  // adapter_type is always claude_local — codex mints no run_jwt handle (CLI-008 §8).
  const jwt = deps.mintAgentJwt({ agentId: run.agentId, companyId: input.companyId, runId: run.runId });
  if (!jwt) throw new Error("run_jwt: agent JWT signing key not configured");
  return jwt;
}

export function createExecutionSecretBrokers(db: Db): SecretBrokerSet {
  const secrets = secretService(db);
  return {
    async resolveConnectorOAuth() {
      // Intentionally unreachable from the sandbox-local path — see the header.
      throw new Error("connector_oauth broker not wired (fence_proxy class, DAT-008 non-goal)");
    },
    async resolveProviderOrCompanySecret(input) {
      const context = consumerContextFor(input.handleId);
      if (input.refKind === "provider_key") {
        // A `provider:<id>` NAME, not an id — the same name `resolveProviderKeyTarget`
        // reports and the mint stored.
        return secrets.resolveByName(input.companyId, input.refId, context);
      }
      return secrets.resolveSecretValue(
        input.companyId,
        input.refId,
        parseSecretVersion(input.refVersion),
        context,
      );
    },
    async resolveRunJwt(input) {
      // Mint-at-resolve. `refId` is the distributed jobId; re-derive the run from the
      // job's handoff marker so the minted run_id is the heartbeat_runs row DAT-007 probes.
      // Mirrors createDistributedRunCurrencyResolver's direct heartbeat_runs read (company
      // scoped in the WHERE; a foreign job can never select another company's run).
      return resolveRunJwtValue(
        {
          async loadDistributedRun({ companyId, jobId }) {
            const [row] = await db
              .select({ runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
              .from(heartbeatRuns)
              .where(and(
                eq(heartbeatRuns.distributedJobId, jobId),
                eq(heartbeatRuns.companyId, companyId),
                eq(heartbeatRuns.executionOwner, "distributed"),
              ))
              .orderBy(desc(heartbeatRuns.createdAt))
              .limit(1);
            return row ?? null;
          },
          mintAgentJwt: ({ agentId, companyId, runId }) =>
            createLocalAgentJwt(agentId, companyId, "claude_local", runId),
        },
        { companyId: input.companyId, refId: input.refId, ownerPrincipalId: input.ownerPrincipalId },
      );
    },
  };
}
