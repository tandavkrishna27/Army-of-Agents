// server/src/services/job-shadow-admissibility.ts
//
// MIG-005/006/007 (D1/D5/D5a) — the read-only admissibility probe.
//
// WHY THIS EXISTS. A shadow pass that diffs resolved field values against an
// independently derived projection sounds informative and mostly is not: four of the six
// fields the comparator carries have no second authority at all (the same resolver runs
// on both sides, or nothing on the distributed side resolves them). The two that DO have
// one — the execution principal and the placement target — express disagreement not as a
// different value but as a REFUSAL. So the question a shadow pass can actually answer is:
//
//     would the distributed platform have accepted this operation at all, and if not, why?
//
// That is what this probe answers, using THE SAME authorities `submitJobWithinTenant`
// uses — `repos.jobControl.admission` and the per-kind `*SourceIsAdmitted` checks. A
// second implementation of those rules would drift, and a probe compared against a
// re-implementation proves nothing about the real path.
//
// EFFECT-FREE, ENFORCED (D5a). Everything runs inside `runInTenantReadOnly`, so the
// database refuses any write with 25006 — not because a reviewer believed the callback
// only selects, and not because a test remembered to count the right tables.
//
// NEVER THROWS. These are live user-visible paths: a Commander turn, a crew dispatch, an
// extraction. Every failure direction returns a recorded verdict.

import type { Db, TenantRepositories } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import { runInTenantReadOnly } from "../db/tenant-context.js";
import { SOURCE_REQUESTER_KINDS } from "./job-submission.js";

export type AdmissibilityReason =
  | "admissible"
  | "organization_missing"
  | "company_not_in_organization"
  | "principal_unauthorized"
  | "requester_kind_not_permitted"
  | "source_not_admitted"
  | "probe_error"
  | "probe_timeout";

/**
 * The authorities that actually ran. This is the PER-SINK DENOMINATOR, and it is the
 * reason the field exists rather than being implied by `admissible`.
 *
 * The three sinks do NOT have equal signal. `commander_turn` and `crew_run` each have a
 * real per-source DB authority that can deny. **`one_shot` has none** —
 * `submitJobWithinTenant` assigns it a constant execution principal with no lookup, so
 * nothing about the operation itself can be refused; only the generic admission checks
 * and placement apply. Reporting "0 divergences across three sinks" without saying that
 * would reproduce, one level down, exactly the tautology this ticket removes.
 */
export type AdmissibilityAuthority = "admission" | "requester_kind" | "source";

export interface AdmissibilityVerdict {
  /** `null` means the probe could not determine a verdict — never treat it as a yes. */
  readonly admissible: boolean | null;
  readonly reason: AdmissibilityReason;
  readonly authoritiesChecked: AdmissibilityAuthority[];
}

/** Sources whose admission carries NO per-source authority — see the type doc above. */
export const SOURCES_WITHOUT_SOURCE_AUTHORITY: ReadonlyArray<SubmitJobSource["kind"]> = [
  "one_shot",
];

export interface AdmissibilityProbeInput {
  readonly organizationId: string;
  readonly companyId: string;
  readonly source: SubmitJobSource;
  readonly principal: { readonly kind: string; readonly id: string; readonly role?: string };
}

/**
 * The decision, given repositories. Separated from the transaction wrapper so it can be
 * unit-tested against a fake `jobControl` without a database, and so the wrapper stays
 * thin enough to read.
 */
export async function evaluateAdmissibility(
  repos: Pick<TenantRepositories, "jobControl">,
  input: AdmissibilityProbeInput,
): Promise<AdmissibilityVerdict> {
  const checked: AdmissibilityAuthority[] = ["admission"];
  const admission = await repos.jobControl.admission({
    organizationId: input.organizationId,
    companyId: input.companyId,
    principalKind: input.principal.kind,
    principalId: input.principal.id,
    principalRole: input.principal.role,
  });

  if (!admission.organizationExists) {
    return { admissible: false, reason: "organization_missing", authoritiesChecked: checked };
  }
  if (!admission.companyInOrganization) {
    return {
      admissible: false,
      reason: "company_not_in_organization",
      authoritiesChecked: checked,
    };
  }
  if (!admission.principalAuthorized || !admission.requester) {
    return { admissible: false, reason: "principal_unauthorized", authoritiesChecked: checked };
  }

  checked.push("requester_kind");
  const permitted = SOURCE_REQUESTER_KINDS[input.source.kind];
  if (!permitted || !permitted.includes(admission.requester.kind)) {
    return {
      admissible: false,
      reason: "requester_kind_not_permitted",
      authoritiesChecked: checked,
    };
  }

  const source = input.source;
  // `one_shot` deliberately falls through with NO per-source authority: the real
  // submission path assigns it a constant execution principal. Its absence from
  // `authoritiesChecked` is the honest report, not an oversight.
  let executionPrincipal: { kind: string; id: string } | null | undefined;
  if (source.kind === "task_run") {
    checked.push("source");
    executionPrincipal = await repos.jobControl.taskSourceIsAdmitted({
      companyId: input.companyId,
      runId: source.runId,
      issueId: source.issueId,
      assigneeAgentId: source.assigneeAgentId,
    });
  } else if (source.kind === "commander_turn") {
    checked.push("source");
    executionPrincipal = await repos.jobControl.commanderSourceIsAdmitted({
      companyId: input.companyId,
      runId: source.internalAgentRunId,
      conversationId: source.conversationId,
      userId: admission.requester.id,
    });
  } else if (source.kind === "crew_run") {
    checked.push("source");
    executionPrincipal = await repos.jobControl.internalRunSourceIsAdmitted({
      companyId: input.companyId,
      runId: source.crewRunId,
      requesterKind: admission.requester.kind,
      requesterId: admission.requester.id,
      triggerSource: "crew_dispatch",
    });
  } else if (source.kind === "browser_request") {
    checked.push("source");
    executionPrincipal = await repos.jobControl.internalRunSourceIsAdmitted({
      companyId: input.companyId,
      runId: source.browserRequestId,
      requesterKind: admission.requester.kind,
      requesterId: admission.requester.id,
      triggerSource: "browser_request",
    });
  } else if (source.kind === "service_reconcile") {
    checked.push("source");
    executionPrincipal = await repos.jobControl.serviceSourceIsAdmitted({
      organizationId: input.organizationId,
      companyId: input.companyId,
      serviceId: source.serviceId,
      generation: source.generation,
    });
  }

  if (checked.includes("source") && !executionPrincipal) {
    return { admissible: false, reason: "source_not_admitted", authoritiesChecked: checked };
  }
  return { admissible: true, reason: "admissible", authoritiesChecked: checked };
}

/**
 * Run the probe against the database, read-only, best-effort.
 *
 * A failure is recorded as `{ admissible: null, reason: "probe_error" }` and never
 * propagated: an observability probe must not fail the live operation it observes.
 */
export async function probeDistributedAdmissibility(
  appDb: Db,
  input: AdmissibilityProbeInput,
): Promise<AdmissibilityVerdict> {
  try {
    return await runInTenantReadOnly(appDb, input.organizationId, (repos) =>
      evaluateAdmissibility(repos, input),
    );
  } catch {
    return { admissible: null, reason: "probe_error", authoritiesChecked: [] };
  }
}
