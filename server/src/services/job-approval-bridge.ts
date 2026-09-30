// server/src/services/job-approval-bridge.ts
//
// JOB-011 — Preserve approvals and completion policy (parity/shadow bridge).
//
// A distributed attempt must call the EXISTING product-approval / runtime-decision /
// completion authorities EXACTLY ONCE — never a new engine. This bridge:
//
//   * The SERVER creates the product approval (`approvals`) or runtime decision
//     (`agent_runtime_decisions`) through the SAME existing service, inside the ONE
//     authoritative tenant transaction, with the source revision + nonce + digest +
//     version + TTL + default those services already stamp.
//   * It writes a JOB-005 projection RECEIPT linking the EXISTING aggregate to the
//     distributed attempt (never a second aggregate), guarded by the active fence.
//   * It queues ONLY the E1 result control (`product_approval_result` /
//     `runtime_decision_result`) on the control channel — the worker cannot create,
//     approve, or override; it only ACKs.
//
// THE load-bearing correctness invariant: `approvalService.create` (approvals.ts) has
// NO native dedup. On a replay the receipt identity-unique (org, company,
// projection_kind, source_identity) is the ONLY thing stopping a duplicate approval.
// So the create moment does a receipt FAST-PATH lookup BEFORE driving the authority —
// exactly like JOB-010's `findIdempotentReplay` runs before the non-idempotent
// `issueService.checkout`. Two `openGovernedDecision` calls with the same
// idempotencyKey → one aggregate, one receipt.
//
// `park_run` ENDS the current attempt and releases compute (`requestCancellation`) —
// mirroring the legacy runtime-decision `park_run` timeout, whose
// `fallbackPolicyOutcome` returns `status:'cancelled', cancelsRun:true, parked:true`
// (agent-runtime-decisions.ts:690). Legacy park CANCELS the run; there is NO automatic
// retry, so the bridge does NOT reap or mint attempt N+1. The ticket's "resumes through
// a NEW fence" is satisfied structurally: the parked attempt's fence is driven terminal
// (cancel_requested → the reaper revokes it), so any LATER resumption — when a human
// answers the parked work-question through the continuation flow, out of JOB-011 scope —
// necessarily rides a FRESH fence, and `guardActiveFence` rejects any late control on the
// dead fence. No managed compute is held while parked.
//
// Flag gate: when distributed execution is OFF, every entrypoint refuses fail-closed
// and touches NOTHING, so every current path stays byte-for-byte unchanged.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { jobProjectionReceipts } from "@armyofagents/db";
import type {
  ActiveFenceRequest,
  CancellationOutcome,
  Db,
  GovernedProjectionKind,
  TenantRepositories,
} from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  canonicalizeJsonV1,
  controlCommandV1Schema,
  productApprovalResultV1Schema,
  runtimeDecisionRequestV1Schema,
  runtimeDecisionResultV1Schema,
  type ProductApprovalDecision,
  type ProductApprovalResultV1,
  type RuntimeDecisionResultV1,
} from "@armyofagents/worker-protocol";
import type {
  PermissionTimeoutPolicy,
  WorkQuestionTimeoutPolicy,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";
import { assertAdmissibleMappedOrganization } from "./tenant-admission.js";
import {
  agentRuntimeDecisionService,
  runtimeDecisionSourceUniqueKey,
} from "./agent-runtime-decisions.js";
import { approvalService } from "./approvals.js";
import { publishLiveEvent } from "./live-events.js";
import type { AuthenticatedJobPrincipal } from "./job-submission.js";

/** The actor a bridge caller presents — the authenticated principal plus the Company
 * scope needed to resolve the immutable Company→Organization ownership edge. */
export type BridgeActor = AuthenticatedJobPrincipal & { companyId: string };

// ---------------------------------------------------------------------------
// Per-source governance profile — the pure, matrix-tested encoding of which
// existing authority each source drives, cross-checked against the FROZEN parity
// authority (distributed-execution-legacy-parity.json `product_runtime_approval`
// dimension, Decision #121) by job-source-governance-matrix.test.ts.

export type ProductApprovalAuthority =
  // crew_run — the `crew_dispatch` product approval (approvals table).
  | "crew_dispatch_approval"
  // commander_turn — Commander's own runtime-approval policy (INERT on the worker
  // path: aoa_app holds only SELECT on internal_agent_messages).
  | "commander_runtime_approval"
  // one_shot / service_reconcile — no product review surface (frozen not_applicable).
  | "not_applicable"
  // task_run / browser_request — no product approval (runtime decisions instead).
  | "none";

export type RuntimeDecisionAuthority =
  // task_run — ask_human / work_questions (agent_runtime_decisions work_question).
  | "ask_human_work_question"
  // browser_request — download/egress permission (agent_runtime_decisions permission).
  | "permission_download_egress"
  // service_reconcile — only the budget_stop decision (owned by JOB-012, not JOB-011).
  | "budget_stop"
  // crew_run / one_shot / commander_turn — no runtime decision on this path.
  | "none";

export type CompletionAuthority =
  // task_run / crew_run — the effective completion policy snapshotted on the issue,
  // enforced by assertAgentStatusTransition, terminalized by completeAttempt.
  | "effective_completion_policy"
  | "none";

export type GovernanceDisposition =
  // task_run / crew_run / browser_request — the bridge drives a real authority in-tx.
  | "drive_in_tenant_tx"
  // commander_turn — recorded only; never driven in-tx (shadow, produces no effect).
  | "inert_shadow"
  // one_shot / service_reconcile — JOB-011 mints NOTHING (not_applicable).
  | "not_applicable";

export type GovernedAggregateKind =
  | "agent_runtime_decisions"
  | "approvals"
  | "internal_agent_runtime_approvals"
  | null;

export interface SourceGovernanceProfile {
  kind: SubmitJobSource["kind"];
  productApprovalAuthority: ProductApprovalAuthority;
  runtimeDecisionAuthority: RuntimeDecisionAuthority;
  completionAuthority: CompletionAuthority;
  disposition: GovernanceDisposition;
  /** The aggregate table a governance receipt links (null when nothing is minted). */
  aggregateKind: GovernedAggregateKind;
  /** The JOB-011 projection kind the receipt carries (null when nothing is minted). */
  projectionKind: GovernedProjectionKind | null;
  /** True iff JOB-011 mints a real product/runtime aggregate for this source. */
  mintsAggregate: boolean;
}

/**
 * Classify a source's governance disposition. Pure; consumed by the matrix test to
 * prove the bridge honours the frozen parity contract per source WITHOUT any database
 * or model effect. Only task_run (runtime decision + completion), crew_run (product
 * `crew_dispatch` approval + completion), and browser_request (permission decision)
 * mint an aggregate. commander_turn is INERT (shadow); one_shot + service_reconcile
 * are product_runtime_approval `not_applicable` — the bridge mints nothing.
 */
export function describeSourceGovernance(source: SubmitJobSource): SourceGovernanceProfile {
  switch (source.kind) {
    case "task_run":
      return {
        kind: "task_run",
        productApprovalAuthority: "none",
        runtimeDecisionAuthority: "ask_human_work_question",
        completionAuthority: "effective_completion_policy",
        disposition: "drive_in_tenant_tx",
        aggregateKind: "agent_runtime_decisions",
        projectionKind: "runtime_decision",
        mintsAggregate: true,
      };
    case "crew_run":
      return {
        kind: "crew_run",
        productApprovalAuthority: "crew_dispatch_approval",
        runtimeDecisionAuthority: "none",
        completionAuthority: "effective_completion_policy",
        disposition: "drive_in_tenant_tx",
        aggregateKind: "approvals",
        projectionKind: "product_approval",
        mintsAggregate: true,
      };
    case "browser_request":
      return {
        kind: "browser_request",
        productApprovalAuthority: "none",
        runtimeDecisionAuthority: "permission_download_egress",
        completionAuthority: "none",
        disposition: "drive_in_tenant_tx",
        aggregateKind: "agent_runtime_decisions",
        projectionKind: "runtime_decision",
        mintsAggregate: true,
      };
    case "commander_turn":
      return {
        kind: "commander_turn",
        productApprovalAuthority: "commander_runtime_approval",
        runtimeDecisionAuthority: "none",
        completionAuthority: "none",
        disposition: "inert_shadow",
        aggregateKind: "internal_agent_runtime_approvals",
        projectionKind: null,
        mintsAggregate: false,
      };
    case "one_shot":
      return {
        kind: "one_shot",
        productApprovalAuthority: "not_applicable",
        runtimeDecisionAuthority: "none",
        completionAuthority: "none",
        disposition: "not_applicable",
        aggregateKind: null,
        projectionKind: null,
        mintsAggregate: false,
      };
    case "service_reconcile":
      return {
        kind: "service_reconcile",
        // JOB-011 mints nothing: the product review surface is not_applicable and the
        // budget_stop runtime decision belongs to the budget/cost bridge (JOB-012).
        productApprovalAuthority: "not_applicable",
        runtimeDecisionAuthority: "budget_stop",
        completionAuthority: "none",
        disposition: "not_applicable",
        aggregateKind: null,
        projectionKind: null,
        mintsAggregate: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Entrypoint request/outcome shapes.

/** A runtime-decision open request (task_run work_question / browser permission). */
export interface RuntimeDecisionOpenRequest {
  /**
   * BRW-004 (E8-F002) — NULL for a distributed job decision, in an all-or-nothing pair.
   *
   * ★ THIS IS THE ENTRY POINT, and widening only the service beneath it would have been a
   * silent no-op: a widened parameter still accepts a narrower argument, so `tsc` stays green
   * while the bridge remains string-only and a browser job can never reach the relaxed
   * aggregate at all. The design names "the bridge's request shape" as one of the two null
   * branches for exactly this reason.
   *
   * A `browser_request` job has no `agents` row and no `heartbeat_runs` row; its binding rides
   * the fence-guarded `job_projection_receipts` row this function already writes. The DB CHECK
   * `(agent_id IS NULL) = (run_id IS NULL)` keeps the pair all-or-nothing.
   */
  agentId: string | null;
  runId: string | null;
  adapterType: string;
  kind: "permission" | "work_question";
  nonce: string;
  title: string;
  summary?: string | null;
  promptText?: string | null;
  toolName?: string | null;
  command?: string | null;
  cwd?: string | null;
  path?: string | null;
  networkTarget?: string | null;
  riskClass?: string | null;
  options?: Array<{ optionId: string; label: string; value: unknown; isDefault: boolean }> | null;
  timeoutPolicy: PermissionTimeoutPolicy | WorkQuestionTimeoutPolicy;
  /** Permission `continue_with_default` default (null otherwise). E1-validated. */
  defaultDecision?: "allow_once" | "allow_run" | "deny" | null;
  expiresAt?: Date | null;
}

/** A product-approval open request (crew_dispatch). */
export interface ProductApprovalOpenRequest {
  type: string;
  title: string;
  payload: Record<string, unknown>;
  requestedByUserId: string;
  requiredRole?: string | null;
  /** The governed action the eventual result authorizes (kind + uuid). */
  governedActionRef: { kind: string; id: string };
  approvalVersion: number;
}

export interface OpenGovernedDecisionInput {
  source: SubmitJobSource;
  actor: BridgeActor;
  /** The LIVE distributed attempt to bind the governance to (composite FK + fence). */
  fence: ActiveFenceRequest;
  /** Stable per-decision idempotency key — the receipt source identity for the
   * product path, and a defense-in-depth key alongside the runtime source unique key. */
  idempotencyKey: string;
  runtimeDecision?: RuntimeDecisionOpenRequest;
  productApproval?: ProductApprovalOpenRequest;
}

export interface ResolveGovernedDecisionInput {
  source: SubmitJobSource;
  actor: BridgeActor;
  fence: ActiveFenceRequest;
  idempotencyKey: string;
  runtimeDecision?: {
    decisionId: string;
    nonce: string;
    expectedSourceRevision: number;
    kind: "permission" | "work_question";
    decision?: "allow_once" | "allow_run" | "deny";
    answer?: Record<string, unknown>;
    actorUserId: string;
    answerIdempotencyKey?: string;
  };
  productApproval?: {
    approvalId: string;
    decision: "approved" | "rejected";
    decidedByUserId: string;
    decisionNote?: string | null;
    approvalKind: string;
    approvalVersion: number;
    governedActionRef: { kind: string; id: string };
  };
}

export interface GovernedDecisionOutcome {
  status: "created" | "resolved" | "replayed" | "not_applicable" | "inert";
  aggregateKind: GovernedAggregateKind;
  aggregateId: string | null;
  receiptId: string | null;
  controlCommandId: string | null;
}

/** Thrown when any bridge entrypoint is called while distributed execution is off.
 * Fail-closed: the bridge does nothing, so the legacy path is untouched. */
export class JobApprovalBridgeDisabledError extends Error {
  readonly code = "JOB_APPROVAL_BRIDGE_DISABLED";
  constructor() {
    super("Job approval bridge is disabled while distributed execution is off");
    this.name = "JobApprovalBridgeDisabledError";
  }
}

/** Thrown when a caller supplies the wrong per-source request payload (e.g. a product
 * approval for a runtime-decision source). Fail-closed BEFORE any effect. */
export class JobApprovalBridgeRequestError extends Error {
  readonly code = "JOB_APPROVAL_BRIDGE_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "JobApprovalBridgeRequestError";
  }
}

export interface JobApprovalBridge {
  isEnabled(): boolean;
  openGovernedDecision(input: OpenGovernedDecisionInput): Promise<GovernedDecisionOutcome>;
  resolveGovernedDecision(input: ResolveGovernedDecisionInput): Promise<GovernedDecisionOutcome>;
  parkRun(input: ParkRunInput): Promise<ParkRunOutcome>;
}

export interface ParkRunInput {
  actor: BridgeActor;
  jobId: string;
  reason: string;
  graceful: boolean;
  /** Caller-supplied cancel command id (retry with the SAME id replays). */
  commandId: string;
  now?: Date;
}

export interface ParkRunOutcome {
  status: CancellationOutcome["status"];
  /** True — park always ENDS the current attempt (parity with the legacy park_run
   * timeout `parked:true`). It does NOT auto-retry; no attempt N+1 is minted here. */
  parked: boolean;
}

// ---------------------------------------------------------------------------

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalizeJsonV1(value)).digest("hex");
}

/** The runtime-decision source identity — byte-identical to the service's own
 * `sourceUniqueKey`, so the receipt keys on the SAME identity the aggregate dedupes
 * on (defense in depth on top of the aggregate's native idempotency). */
function runtimeSourceIdentity(companyId: string, runId: string | null, nonce: string): string {
  // ★★★ ONE IMPLEMENTATION, NOT TWO. This used to re-implement the service's key as its own
  // template literal, bound to it by nothing but the comment above saying they must be
  // byte-identical. That is the "second implementation of an identity rule" this programme keeps
  // paying for, and BRW-004 nearly paid again: `runId` became nullable, and two independent
  // template literals would each have had to render null identically — by accident, forever.
  //
  // A divergence here does NOT fail loudly. The receipt fast-path simply never hits, so every
  // replay mints a duplicate aggregate — a silent idempotency failure, not an error.
  //
  // The bridge already imports this module (`agentRuntimeDecisionService`, above), so there was
  // never a dependency reason for the copy. It now DELEGATES, and the wrapper is kept only so
  // the two call sites below read the same as they did.
  return runtimeDecisionSourceUniqueKey({ companyId, runId, nonce });
}

/** The product-approval source identity — keyed on the bridge idempotency key, since
 * `approvals.create` has NO native dedup and the receipt is the sole replay guard. */
function productSourceIdentity(companyId: string, idempotencyKey: string): string {
  return `product:${companyId}:${idempotencyKey}`;
}

/** Build the E1 control command envelope from the fence delivery identity. `commandSeq`
 * is a placeholder (the repo stamps the lease-allocated sequence); any positive int
 * satisfies the frozen schema. */
function buildControlCommandBody(
  fence: ActiveFenceRequest,
  commandId: string,
  commandKind: "product_approval_result" | "runtime_decision_result",
  result: ProductApprovalResultV1 | RuntimeDecisionResultV1,
  issuedAt: Date,
): Record<string, unknown> {
  const base = {
    protocolVersion: 1 as const,
    audience: "control_channel" as const,
    commandId,
    commandSeq: 1,
    idempotencyKey: commandId,
    issuedAt: issuedAt.toISOString(),
    nonce: randomUUID(),
    organizationId: fence.organizationId,
    companyId: fence.companyId,
    workerId: fence.workerId,
    jobId: fence.jobId,
    attempt: fence.attemptNumber,
    leaseId: fence.leaseId,
    fenceToken: fence.fence,
  };
  // Fail-closed: the SERVER-authored control MUST satisfy the frozen E1 schema before
  // it is queued. A malformed result never reaches the durable channel.
  return controlCommandV1Schema.parse({ ...base, commandKind, result }) as unknown as Record<string, unknown>;
}

type RuntimeDecisionRow = {
  id: string;
  nonce: string;
  promptHash: string | null;
  sourceRevision: number;
  expiresAt: Date | string | null;
  timeoutPolicy: string;
  kind: string;
  decision: string | null;
  answerPayload: unknown;
  answeredAt: Date | string | null;
  status: string;
};

function toIso(value: Date | string | null | undefined, fallback: Date): string {
  if (value == null) return fallback.toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Build the E1 runtime_decision_result echoing the answered decision row 1:1 so the
 * control-plane binder (`matchRuntimeDecisionResultToRequestV1`) pairs it to the
 * request the SERVER minted. The deciding principal is typed. */
function buildRuntimeDecisionResult(
  row: RuntimeDecisionRow,
  decidedBy: { principalType: "user" | "agent" | "service" | "system"; principalId: string },
  controlIdempotencyKey: string,
  now: Date,
): RuntimeDecisionResultV1 {
  const common = {
    requestId: row.id,
    nonce: row.nonce,
    requestDigest: row.promptHash ?? sha256Hex({ decision: row.id }),
    schemaVersion: 1,
    sourceRevision: row.sourceRevision,
    expiresAt: toIso(row.expiresAt, now),
    decidedBy,
    decidedAt: toIso(row.answeredAt, now),
    idempotencyKey: controlIdempotencyKey,
  };
  if (row.kind === "permission") {
    return runtimeDecisionResultV1Schema.parse({
      decisionKind: "permission",
      ...common,
      timeoutPolicy: row.timeoutPolicy,
      decision: row.decision ?? "deny",
    });
  }
  const answered = row.status === "answered" || row.status === "relayed";
  return runtimeDecisionResultV1Schema.parse({
    decisionKind: "work_question",
    ...common,
    timeoutPolicy: row.timeoutPolicy,
    outcome: answered ? "answered" : "cancelled",
    answer: answered ? (row.answerPayload as Record<string, unknown>) ?? { selected: null } : null,
  });
}

/** Map an approval status to the E1 product-approval decision. */
function toProductApprovalDecision(status: string): ProductApprovalDecision {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  return "expired";
}

export function jobApprovalBridge(
  appDb: Db,
  options?: { env?: Record<string, string | undefined> },
): JobApprovalBridge {
  const env = options?.env ?? process.env;

  function assertEnabled(): void {
    if (!readDistributedExecutionDeploymentFlag(env)) {
      throw new JobApprovalBridgeDisabledError();
    }
  }

  async function resolveAdmissibleOrganization(companyId: string): Promise<string> {
    const organizationId = await resolveCompanyOrganizationId(appDb, companyId);
    assertAdmissibleMappedOrganization(organizationId);
    return organizationId;
  }

  function principalOf(actor: BridgeActor): {
    principalType: "user" | "agent" | "service" | "system";
    principalId: string;
  } {
    const type =
      actor.kind === "user" || actor.kind === "local_board"
        ? "user"
        : actor.kind === "agent"
          ? "agent"
          : actor.kind === "system"
            ? "system"
            : "service";
    return { principalType: type, principalId: actor.id };
  }

  return {
    isEnabled(): boolean {
      return readDistributedExecutionDeploymentFlag(env);
    },

    async openGovernedDecision(input) {
      assertEnabled();
      const profile = describeSourceGovernance(input.source);
      // one_shot / service_reconcile: product_runtime_approval is not_applicable —
      // the bridge mints NOTHING (0 aggregates, 0 receipts, 0 controls).
      if (profile.disposition === "not_applicable") {
        return { status: "not_applicable", aggregateKind: null, aggregateId: null, receiptId: null, controlCommandId: null };
      }
      // commander_turn: shadow. Recorded conceptually against Commander's own
      // runtime-approval policy but never driven in-tx (aoa_app cannot mutate the
      // Commander conversation), so it produces NO model/provider effect.
      if (profile.disposition === "inert_shadow") {
        return { status: "inert", aggregateKind: profile.aggregateKind, aggregateId: null, receiptId: null, controlCommandId: null };
      }

      const organizationId = await resolveAdmissibleOrganization(input.actor.companyId);
      const companyId = input.actor.companyId;
      const afterCommit: Array<() => void> = [];

      if (profile.projectionKind === "runtime_decision") {
        const req = input.runtimeDecision;
        if (!req) throw new JobApprovalBridgeRequestError("runtime-decision source requires a runtimeDecision request");
        // FAIL BEFORE EFFECT: validate the minted E1 request (invalid/missing/multiple
        // default + forbidden persistent `allow_always` grant) BEFORE any DB write.
        // The `.superRefine` default/options rules are independent of requestId, so a
        // placeholder id exercises them; nothing is written if this throws.
        validateRuntimeDecisionRequest(req);

        const outcome = await runInTenant(appDb, organizationId, async (repos, tx) => {
          const sourceIdentity = runtimeSourceIdentity(companyId, req.runId, req.nonce);
          // RECEIPT FAST-PATH FIRST — replay returns the already-linked aggregate
          // WITHOUT driving the (non-idempotent-on-create) authority a second time.
          const existing = await findGovernedReceipt(tx, organizationId, companyId, "runtime_decision", sourceIdentity);
          if (existing) {
            return { status: "replayed" as const, aggregateId: existing.targetAggregateId, receiptId: existing.id, controlCommandId: null };
          }
          const svc = agentRuntimeDecisionService(tx);
          const { decision } = await svc.createPrompt({
            companyId,
            agentId: req.agentId,
            runId: req.runId,
            adapterType: req.adapterType,
            kind: req.kind,
            nonce: req.nonce,
            title: req.title,
            summary: req.summary ?? null,
            promptText: req.promptText ?? null,
            toolName: req.toolName ?? null,
            command: req.command ?? null,
            cwd: req.cwd ?? null,
            path: req.path ?? null,
            networkTarget: req.networkTarget ?? null,
            riskClass: req.riskClass ?? null,
            options: req.options ? req.options.map((o) => ({ ...o })) : null,
            expiresAt: req.expiresAt ?? null,
            timeoutPolicy: req.timeoutPolicy,
          });
          const canonicalRequest = buildRuntimeDecisionRequestBody(req, decision.id, toIso(decision.expiresAt, new Date()));
          const recorded = await repos.jobControl.recordGovernedProjection({
            ...input.fence,
            projection: {
              projectionKind: "runtime_decision",
              aggregateKind: "agent_runtime_decisions",
              sourceIdentity,
              sourceDigest: sha256Hex(canonicalRequest),
              targetAggregateId: decision.id,
              status: "pending",
            },
          });
          afterCommit.push(() =>
            publishLiveEvent({ companyId, type: "internal_agent.notification", payload: { kind: "governance_runtime_decision_created", decisionId: decision.id } }),
          );
          return { status: "created" as const, aggregateId: decision.id, receiptId: recorded.receiptId, controlCommandId: null };
        });
        for (const publish of afterCommit) { try { publish(); } catch { /* best-effort live poke */ } }
        return { ...outcome, aggregateKind: "agent_runtime_decisions" };
      }

      // product_approval (crew_dispatch).
      const req = input.productApproval;
      if (!req) throw new JobApprovalBridgeRequestError("product-approval source requires a productApproval request");
      const outcome = await runInTenant(appDb, organizationId, async (repos, tx) => {
        // TOCTOU GUARD FIRST — lock the lease+attempt FOR UPDATE (guardActiveFence, no
        // write) BEFORE the receipt fast-path. `approvals.create` has no native dedup, so
        // the receipt read is the SOLE replay guard; without this lock two concurrent
        // same-fence/same-idempotencyKey creates both pass the fast-path (0 rows) and both
        // create an approval → a live orphaned 2nd approval a founder could approve
        // (duplicate crew_dispatch). Serializing on the lease lock makes the 2nd caller
        // block until the 1st commits its receipt, then observe it and replay. (The
        // runtime path is already safe — createPrompt is DB-idempotent on sourceUniqueKey.)
        await repos.jobControl.lockActiveFence(input.fence);
        const sourceIdentity = productSourceIdentity(companyId, input.idempotencyKey);
        // RECEIPT FAST-PATH — the ONLY guard against a duplicate approval on replay
        // (approvals.create has no native dedup). Return the already-linked approval
        // WITHOUT a second create.
        const existing = await findGovernedReceipt(tx, organizationId, companyId, "product_approval", sourceIdentity);
        if (existing) {
          return { status: "replayed" as const, aggregateId: existing.targetAggregateId, receiptId: existing.id, controlCommandId: null };
        }
        const created = await approvalService(tx).create(companyId, {
          type: req.type,
          title: req.title,
          status: "pending",
          payload: req.payload,
          requestedByUserId: req.requestedByUserId,
          requiredRole: req.requiredRole ?? null,
        } as Parameters<ReturnType<typeof approvalService>["create"]>[1]);
        if (!created) throw new JobApprovalBridgeRequestError("approval create returned no row");
        const recorded = await repos.jobControl.recordGovernedProjection({
          ...input.fence,
          projection: {
            projectionKind: "product_approval",
            aggregateKind: "approvals",
            sourceIdentity,
            sourceDigest: sha256Hex({
              type: req.type,
              governedActionRef: req.governedActionRef,
              approvalVersion: req.approvalVersion,
              idempotencyKey: input.idempotencyKey,
            }),
            targetAggregateId: created.id,
            status: "pending",
          },
        });
        afterCommit.push(() =>
          publishLiveEvent({ companyId, type: "internal_agent.notification", payload: { kind: "governance_product_approval_created", approvalId: created.id } }),
        );
        return { status: "created" as const, aggregateId: created.id, receiptId: recorded.receiptId, controlCommandId: null };
      });
      for (const publish of afterCommit) { try { publish(); } catch { /* best-effort live poke */ } }
      return { ...outcome, aggregateKind: "approvals" };
    },

    async resolveGovernedDecision(input) {
      assertEnabled();
      const profile = describeSourceGovernance(input.source);
      if (profile.disposition === "not_applicable") {
        return { status: "not_applicable", aggregateKind: null, aggregateId: null, receiptId: null, controlCommandId: null };
      }
      if (profile.disposition === "inert_shadow") {
        return { status: "inert", aggregateKind: profile.aggregateKind, aggregateId: null, receiptId: null, controlCommandId: null };
      }

      const organizationId = await resolveAdmissibleOrganization(input.actor.companyId);
      const companyId = input.actor.companyId;
      const now = new Date();
      const decidedBy = principalOf(input.actor);
      const afterCommit: Array<() => void> = [];

      if (profile.projectionKind === "runtime_decision") {
        const req = input.runtimeDecision;
        if (!req) throw new JobApprovalBridgeRequestError("runtime-decision source requires a runtimeDecision resolution");
        const outcome = await runInTenant(appDb, organizationId, async (repos, tx) => {
          const svc = agentRuntimeDecisionService(tx);
          // Drive the EXISTING resolve authority (claim-first, idempotent-replay safe).
          const row = (await svc.answerPrompt({
            companyId,
            decisionId: req.decisionId,
            actorUserId: req.actorUserId,
            expectedSourceRevision: req.expectedSourceRevision,
            nonce: req.nonce,
            kind: req.kind,
            decision: req.decision,
            answer: req.answer,
            idempotencyKey: req.answerIdempotencyKey,
          })) as unknown as RuntimeDecisionRow;
          // Flip the receipt pending->applied on the SAME source identity the create
          // moment wrote (runtime:{company}:{run}:{nonce}); we reconstruct it from the
          // linked receipt rather than re-deriving the run id here.
          const marked = await markGovernedReceiptAppliedByAggregate(
            repos, tx, input.fence, "runtime_decision", row.id,
          );
          // DETERMINISTIC command id = the resolved decision aggregate id (a stable UUID;
          // one decision → one result control). On an idempotent answer-replay (same
          // answerIdempotencyKey), answerPrompt returns the already-answered row without
          // throwing and markGovernedProjectionApplied is a no-op — a FRESH randomUUID()
          // here would defeat queueGovernedControlCommand's (org, lease, command id) dedup
          // and queue a SECOND runtime_decision_result. Deriving it from row.id makes the
          // replay dedup to the same command. (The product resolve path is safe by a
          // different mechanism — approve() throws on a non-pending status and rolls back.)
          const commandId = row.id;
          const result = buildRuntimeDecisionResult(row, decidedBy, commandId, now);
          const commandBody = buildControlCommandBody(input.fence, commandId, "runtime_decision_result", result, now);
          const queued = await repos.jobControl.queueGovernedControlCommand({
            ...input.fence,
            control: { commandId, commandKind: "runtime_decision_result", commandBody, now },
          });
          afterCommit.push(() =>
            publishLiveEvent({ companyId, type: "internal_agent.notification", payload: { kind: "governance_runtime_decision_resolved", decisionId: row.id } }),
          );
          return {
            status: "resolved" as const,
            aggregateId: row.id,
            receiptId: marked.receiptId,
            controlCommandId: queued.command?.commandId ?? commandId,
          };
        });
        for (const publish of afterCommit) { try { publish(); } catch { /* best-effort */ } }
        return { ...outcome, aggregateKind: "agent_runtime_decisions" };
      }

      // product_approval (crew_dispatch).
      const req = input.productApproval;
      if (!req) throw new JobApprovalBridgeRequestError("product-approval source requires a productApproval resolution");
      const outcome = await runInTenant(appDb, organizationId, async (repos, tx) => {
        const svc = approvalService(tx);
        // Drive the EXISTING flip authority (claim-first). approve() also runs the
        // crew_dispatch preflight + dispatch side-effect; the bridge adds no second one.
        const updated =
          req.decision === "approved"
            ? await svc.approve(req.approvalId, companyId, req.decidedByUserId, req.decisionNote ?? null)
            : await svc.reject(req.approvalId, companyId, req.decidedByUserId, req.decisionNote ?? null);
        const approvalRow = (updated as { id?: string; status?: string } | null) ?? null;
        const approvalStatus = approvalRow?.status ?? req.decision;
        const marked = await markGovernedReceiptAppliedByAggregate(
          repos, tx, input.fence, "product_approval", req.approvalId,
        );
        const commandId = randomUUID();
        const result = productApprovalResultV1Schema.parse({
          approvalId: req.approvalId,
          approvalKind: req.approvalKind,
          approvalVersion: req.approvalVersion,
          decision: toProductApprovalDecision(approvalStatus),
          decidedBy,
          decidedAt: now.toISOString(),
          idempotencyKey: commandId,
          governedActionRef: req.governedActionRef,
        });
        const commandBody = buildControlCommandBody(input.fence, commandId, "product_approval_result", result, now);
        const queued = await repos.jobControl.queueGovernedControlCommand({
          ...input.fence,
          control: { commandId, commandKind: "product_approval_result", commandBody, now },
        });
        afterCommit.push(() =>
          publishLiveEvent({ companyId, type: "internal_agent.notification", payload: { kind: "governance_product_approval_resolved", approvalId: req.approvalId } }),
        );
        return {
          status: "resolved" as const,
          aggregateId: req.approvalId,
          receiptId: marked.receiptId,
          controlCommandId: queued.command?.commandId ?? commandId,
        };
      });
      for (const publish of afterCommit) { try { publish(); } catch { /* best-effort */ } }
      return { ...outcome, aggregateKind: "approvals" };
    },

    async parkRun(input) {
      assertEnabled();
      const organizationId = await resolveAdmissibleOrganization(input.actor.companyId);
      const companyId = input.actor.companyId;
      const now = input.now ?? new Date();
      return runInTenant(appDb, organizationId, async (repos) => {
        // Park ENDS the current attempt and releases compute — nothing more. This is
        // exact parity with the legacy runtime-decision park_run timeout, whose
        // `fallbackPolicyOutcome` returns `status:'cancelled', cancelsRun:true,
        // parked:true` (agent-runtime-decisions.ts:690): park CANCELS the run and does
        // NOT auto-retry. With a fenced worker `requestCancellation` marks
        // cancel_requested + queues ONE cancel control; with no fenced worker it
        // finalizes the attempt+job directly and releases the capacity slot. No managed
        // compute is held while parked.
        //
        // We deliberately do NOT reap or mint attempt N+1. requestCancellation marks the
        // job `cancel_requested`, which routes the reaper down the cancel branch
        // (finalizeJob('cancelled')) — it can NEVER resume THIS job, so reaping here
        // could only surface OTHER jobs' retry counts. Any legitimate resumption (a human
        // answering the parked work-question via the future continuation flow, out of
        // JOB-011 scope) rides a FRESH fence; `guardActiveFence` rejects any late control
        // on this now-dead fence.
        const cancelled = await repos.jobControl.requestCancellation({
          organizationId,
          companyId,
          jobId: input.jobId,
          reason: input.reason,
          graceful: input.graceful,
          commandId: input.commandId,
          now,
        });
        return { status: cancelled.status, parked: true };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers that read/flip the governance receipt directly (the repo owns
// writes; the bridge owns the fast-path read + the aggregate→receipt reconciliation).

async function findGovernedReceipt(
  tx: Db,
  organizationId: string,
  companyId: string,
  projectionKind: GovernedProjectionKind,
  sourceIdentity: string,
): Promise<{ id: string; targetAggregateId: string; status: string } | null> {
  const [row] = await tx
    .select({
      id: jobProjectionReceipts.id,
      targetAggregateId: jobProjectionReceipts.targetAggregateId,
      status: jobProjectionReceipts.status,
    })
    .from(jobProjectionReceipts)
    .where(and(
      eq(jobProjectionReceipts.organizationId, organizationId),
      eq(jobProjectionReceipts.companyId, companyId),
      eq(jobProjectionReceipts.projectionKind, projectionKind),
      eq(jobProjectionReceipts.sourceIdentity, sourceIdentity),
    ))
    .limit(1);
  return row ?? null;
}

/** Flip the receipt that links `aggregateId` to `applied`, using the guarded repo
 * mutator on the receipt's own source identity (looked up from the aggregate link). */
async function markGovernedReceiptAppliedByAggregate(
  repos: Pick<TenantRepositories, "jobControl">,
  tx: Db,
  fence: ActiveFenceRequest,
  projectionKind: GovernedProjectionKind,
  aggregateId: string,
): Promise<{ receiptId: string | null }> {
  const [row] = await tx
    .select({ id: jobProjectionReceipts.id, sourceIdentity: jobProjectionReceipts.sourceIdentity })
    .from(jobProjectionReceipts)
    .where(and(
      eq(jobProjectionReceipts.organizationId, fence.organizationId),
      eq(jobProjectionReceipts.companyId, fence.companyId),
      eq(jobProjectionReceipts.projectionKind, projectionKind),
      eq(jobProjectionReceipts.targetAggregateId, aggregateId),
    ))
    .limit(1);
  if (!row) return { receiptId: null };
  await repos.jobControl.markGovernedProjectionApplied({
    ...fence,
    projectionKind,
    sourceIdentity: row.sourceIdentity,
  });
  return { receiptId: row.id };
}

/** Build the E1 runtime-decision REQUEST body the SERVER minted (used for the receipt
 * digest and, at validation time, to exercise the fail-closed default/options rules). */
function buildRuntimeDecisionRequestBody(
  req: RuntimeDecisionOpenRequest,
  requestId: string,
  expiresAtIso: string,
): Record<string, unknown> {
  const common = {
    requestId,
    nonce: req.nonce,
    requestDigest: sha256Hex({ title: req.title, summary: req.summary ?? null, promptText: req.promptText ?? null, command: req.command ?? null }),
    schemaVersion: 1,
    sourceRevision: 0,
    expiresAt: expiresAtIso,
    title: req.title,
    summary: req.summary ?? null,
  };
  if (req.kind === "permission") {
    return {
      decisionKind: "permission",
      ...common,
      timeoutPolicy: req.timeoutPolicy,
      defaultDecision: req.defaultDecision ?? null,
      toolName: req.toolName ?? null,
      command: req.command ?? null,
      cwd: req.cwd ?? null,
      path: req.path ?? null,
      networkTarget: req.networkTarget ?? null,
      riskClass: req.riskClass ?? null,
    };
  }
  return {
    decisionKind: "work_question",
    ...common,
    timeoutPolicy: req.timeoutPolicy,
    promptText: req.promptText ?? "",
    options: (req.options ?? []).map((o) => ({ optionId: o.optionId, label: o.label, value: o.value, isDefault: o.isDefault })),
  };
}

/** FAIL BEFORE EFFECT: parse the minted request through the frozen E1 schema whose
 * `.superRefine` rejects invalid/missing/multiple `continue_with_default` defaults and
 * (via PERMISSION_DEFAULT_DECISIONS omitting `allow_always`) a forbidden persistent
 * timeout grant. A placeholder requestId exercises the default/options rules without a
 * DB round-trip; on failure NOTHING is written. */
function validateRuntimeDecisionRequest(req: RuntimeDecisionOpenRequest): void {
  const expiresAt = (req.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000)).toISOString();
  const body = buildRuntimeDecisionRequestBody(req, randomUUID(), expiresAt);
  runtimeDecisionRequestV1Schema.parse(body);
}
