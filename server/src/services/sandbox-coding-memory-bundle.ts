/**
 * sandbox-coding-memory-bundle.ts — CLI-002/D2.
 *
 * The actor-gated, PRE-STAGED memory bundle a sandboxed coding run arrives with.
 * It reuses the SAME lineage as `buildCrewContextBundle`
 * (`actorForAgentRun → memoryAccessConditions → canActorSee`, fail-closed to zero
 * memory) — NOT `context-packaging.ts assembleContext`, which has no RBAC gate and
 * would leak across Decisions #118/#119.
 *
 * Why pre-staged (not a live in-VM pull): DAT-007's brokered run-JWT tool surface
 * has its core deferred, so CLI-002 delivers the memory-derived context as a bundle
 * assembled on the HOST (where the DB + the RBAC gate live) and staged into the
 * sandbox as a `## Context` block. The sandbox itself never receives DB/memory-table
 * access — the no-DB boundary is static (U5 drops DB creds; the worker reads no
 * `DATABASE_URL`). The live brokered in-VM pull is a documented deferral to DAT-007.
 *
 * Fail-closed contract: if no actor resolves (no agentId, or the resolver throws),
 * the bundle is ZERO memory — a run whose entitlement cannot be proven sees no
 * durable memory, exactly as `buildCrewContextBundle`'s memory path does.
 */

import { and, desc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems } from "@armyofagents/db";
import {
  filterMemoryForActor,
  type AccessibleMemoryRow,
  type MemoryActor,
} from "./memory-access.js";
import { actorForAgentRun, memoryAccessConditions } from "./memory-access-sql.js";

/** Memory rows pulled per run (parity with the crew bundle's MEMORY_LIMIT). */
const DEFAULT_MEMORY_LIMIT = 5;
/** Cap a single item's rendered content so one huge row can't dominate. */
const CONTENT_CAP = 400;

export interface ActorGatedMemoryBundle {
  /** Rendered "- <title>: <content>" lines for the `## Context` Memory section. */
  readonly lines: string[];
  /** Count of SERVED items (post RBAC gate + post-fetch safety net). */
  readonly itemCount: number;
  /** True iff an actor resolved. False ⇒ fail-closed to zero memory. */
  readonly actorResolved: boolean;
  /** The resolved actor kind (audit/version-record), or null when unresolved. */
  readonly actorKind: string | null;
}

export interface BuildActorGatedMemoryArgs {
  readonly companyId: string;
  /** The agent receiving the context — drives per-agent RBAC (fail-closed on absence). */
  readonly agentId: string;
  /** Optional scope narrowing (department/project/goal) mirrored from the task/thread. */
  readonly filters?: { departmentId?: string; projectId?: string; goalId?: string };
  readonly limit?: number;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function renderLine(row: { title?: string | null; content?: string | null }): string {
  const title = typeof row.title === "string" && row.title.length > 0 ? row.title : "Memory";
  const content = typeof row.content === "string" ? row.content : "";
  return `- ${title}: ${truncate(content.trim(), CONTENT_CAP)}`;
}

/**
 * Assemble the actor-gated memory bundle. RBAC is enforced TWICE — the SQL gate
 * (`memoryAccessConditions`) narrows the fetch, and `filterMemoryForActor`
 * (the `canActorSee` reference) is the post-fetch safety net over it — so a row the
 * actor may not see is never rendered, exactly matching the crew path (#118/#119).
 */
export async function buildActorGatedMemoryBundle(
  db: Db,
  args: BuildActorGatedMemoryArgs,
): Promise<ActorGatedMemoryBundle> {
  const empty: ActorGatedMemoryBundle = { lines: [], itemCount: 0, actorResolved: false, actorKind: null };

  // Resolve the crew agent's actor. No agentId, or a resolver failure, FAILS CLOSED
  // to zero memory (a run whose entitlement cannot be proven sees no durable memory).
  if (!args.agentId) return empty;
  let actor: MemoryActor | null;
  try {
    actor = await actorForAgentRun(db, args.companyId, args.agentId);
  } catch {
    return empty;
  }
  if (!actor) return empty;

  const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_MEMORY_LIMIT;
  const accessConditions: SQL[] = memoryAccessConditions(db, actor);

  // Gated fetch matching the crew lineage's WHERE verbatim (memory.ts:625-629):
  // company + RBAC access conditions + status='approved' (the FOUNDER APPROVAL gate —
  // Rule #6 / Decision #15: pending/rejected memory must NEVER be staged into the
  // coding sandbox) + the A-M5 expiry guard (never serve expired active_context; the DB
  // clock via now() so worker/host skew can't leak rows). Optional scope narrowing is
  // `= scope OR IS NULL` per the crew searchMultiPath, so a null-scoped ambient/company
  // row is never dropped. Deterministic ORDER BY (priority, updatedAt) makes the served
  // subset — and the D5 context digest — reproducible under the LIMIT.
  const whereParts: SQL[] = [
    eq(memoryItems.companyId, args.companyId),
    ...accessConditions,
    eq(memoryItems.status, "approved"),
    or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
  ];
  const scope = args.filters;
  if (scope?.departmentId) {
    whereParts.push(or(isNull(memoryItems.departmentId), eq(memoryItems.departmentId, scope.departmentId))!);
  }
  if (scope?.projectId) {
    whereParts.push(or(isNull(memoryItems.projectId), eq(memoryItems.projectId, scope.projectId))!);
  }
  if (scope?.goalId) {
    whereParts.push(or(isNull(memoryItems.goalId), eq(memoryItems.goalId, scope.goalId))!);
  }
  const rows = (await db
    .select({
      id: memoryItems.id,
      title: memoryItems.title,
      content: memoryItems.content,
      status: memoryItems.status,
      expiresAt: memoryItems.expiresAt,
      layer: memoryItems.layer,
      visibility: memoryItems.visibility,
      departmentId: memoryItems.departmentId,
      projectId: memoryItems.projectId,
      goalId: memoryItems.goalId,
      taskId: memoryItems.taskId,
      ownerType: memoryItems.ownerType,
      ownerId: memoryItems.ownerId,
      agentId: memoryItems.agentId,
      invalidatedAt: memoryItems.invalidatedAt,
    })
    .from(memoryItems)
    .where(and(...whereParts))
    .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
    .limit(limit)) as Array<
    AccessibleMemoryRow & { id: string; title: string | null; content: string | null }
  >;

  // Post-fetch safety net (the SQL gate's reference) — never render a row the
  // actor can't see, even if the gate were bypassed.
  const served = filterMemoryForActor(rows, actor);
  return {
    lines: served.map(renderLine),
    itemCount: served.length,
    actorResolved: true,
    actorKind: actor.kind,
  };
}
