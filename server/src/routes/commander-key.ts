import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { agents, internalAgentConfig } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import { assertRole } from "../middleware/rbac.js";
import { assertCompanyAccess } from "./authz.js";
import { secretService } from "../services/secrets.js";
import { persistCommanderApiKey } from "../services/commander-key.js";
import { logActivity } from "../services/activity-log.js";
import {
  probeProviderApiKey,
  type ProviderApiKeyProbe,
} from "../services/provider-api-key-probe.js";

/**
 * Save a pasted Commander API key (Plan 3 / §6.1). Founder-scoped: an EXPLICIT
 * board-actor check precedes assertRole (agents bypass assertRole — Codex #10).
 * The raw key goes to the encrypted vault; a secret_ref is bound into the
 * Commander agent's adapterConfig.env (see persistCommanderApiKey). The verify
 * route (T1) then probes the resolved config, so the key unblocks re-probe.
 */
export function commanderKeyRoutes(
  db: Db,
  opts: {
    probeKey?: (
      provider: "openai" | "anthropic",
      value: string,
    ) => Promise<ProviderApiKeyProbe>;
  } = {},
): Router {
  const router = Router();
  const probeKey =
    opts.probeKey ??
    (process.env.NODE_ENV === "test"
      ? async () => ({ ok: true as const })
      : probeProviderApiKey);

  router.post("/companies/:companyId/internal-agent/commander-key", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const provider = req.body?.provider;
    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    if (provider !== "anthropic" && provider !== "openai") {
      res.status(400).json({ error: "provider must be 'anthropic' or 'openai'" });
      return;
    }
    if (!value) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    // Load the Commander agent id. The id lookup stays pre-tx so a missing
    // Commander agent 404s without ever opening a transaction. The agent's
    // adapterConfig is deliberately NOT read here — it moves inside the tx under
    // a row lock (see below), so the merge reads the value at the serialization
    // boundary rather than a stale pre-tx snapshot (Codex round-12 P2).
    const [cfg] = await db
      .select({ agentId: internalAgentConfig.agentId })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, companyId))
      .limit(1);
    if (!cfg?.agentId) {
      res.status(404).json({ error: "no Commander agent configured" });
      return;
    }
    // Capture the narrowed (non-null) id here — TS control-flow narrowing from
    // the guard above does not survive into the db.transaction callback closure.
    const agentId = cfg.agentId;

    // Validate the candidate before touching the active encrypted secret. A
    // confirmed-invalid replacement can therefore never destroy a working key.
    const verification = await probeKey(provider, value);
    if (!verification.ok) {
      if (verification.retryAfter) res.set("Retry-After", verification.retryAfter);
      res.status(verification.transient ? 503 : 422).json({
        code: verification.code,
        error: verification.summary,
        remediation: verification.remediation,
        supportId: verification.supportId,
        canSaveUnverified: false,
      });
      return;
    }

    // ONE atomic transaction wraps the whole save: the vault mutation
    // (writeSecret — create OR rotate OR reactivate+rotate), the agent
    // adapterConfig merge, the env-binding sync, AND the audit entry. Either
    // everything commits together or everything rolls back. This closes the
    // Codex round-11 P2: previously the audit fired only AFTER all three
    // mutation steps AND outside any tx, so a rejection in step 2/3 (or in
    // rotate after a reactivation) left the committed vault mutation with NO
    // audit entry (AGENTS.md §5 violation) and an inconsistent half-written
    // state. Running the audit INSIDE the tx makes "every committed mutation is
    // audited" hold by construction — a partial write can never bypass it.
    // The secret ops (create/rotate) open their own db.transaction; on a tx
    // handle those become savepoints (same nested-tx pattern as join-approval).
    const secretId = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const secrets = secretService(txDb);

      // Read the CURRENT adapterConfig INSIDE the tx and LOCK the agent row
      // (SELECT … FOR UPDATE). This closes the Codex round-12 P2 lost-update
      // race the round-11 atomicity fix exposed: previously the adapterConfig
      // snapshot was taken OUTSIDE this serialization boundary, so two concurrent
      // key-saves for DIFFERENT providers (anthropic + openai) both merged onto
      // the SAME pre-save config. Whichever tx committed second REPLACED the
      // whole adapterConfig JSON, and syncEnvBindingsForTarget then DELETED the
      // other provider's binding as "absent from env" — silently dropping the
      // first provider's secret_ref while both requests still returned 200.
      //
      // Reading + locking here serializes concurrent same-agent saves on the
      // agents row: the second request WAITS for the first to commit, then reads
      // the first's committed config (now carrying its env entry) and merges its
      // own provider on top. The UNION of both secret_refs survives, and
      // syncEnvBindingsForTarget receives the full current env so it deletes
      // nothing legitimate.
      //
      // Plain FOR UPDATE (not NO WAIT): a founder key-save is rare, and the
      // correct behaviour is for the second save to briefly BLOCK then merge, not
      // to fail. The agents row is the right lock target — it is exactly what
      // both requests mutate (adapterConfig) and what the env bindings derive from.
      const [agent] = await txDb
        .select({ adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(eq(agents.id, agentId))
        .for("update");
      const adapterConfig = (agent?.adapterConfig as Record<string, unknown> | null) ?? {};

      // Which branch of writeSecret ran, surfaced for the audit log. The closure
      // (not persistCommanderApiKey) is the only place that can tell create vs
      // rotate vs reactivate apart, and the service return type is fixed to
      // { secretId } — so capture it here rather than threading it back through.
      let operation: "created" | "rotated" | "reactivated" = "created";
      const result = await persistCommanderApiKey(
        {
          writeSecret: async (a) => {
            // The secret name is deterministic per provider ("Commander <provider>
            // API key"), and secretService.create 409s on an active duplicate. So
            // a founder who pastes a bad/expired key then retries a corrected one
            // must ROTATE the existing secret's value (new company_secret_versions
            // row, same id) rather than re-create it — otherwise the second submit
            // 409s and the Claude/anthropic onboarding path wedges after one bad
            // key (Codex P1). The id stays stable, so the bound secret_ref
            // (version "latest") resolves the rotated value with no rebind.
            const actorRef = { userId: actor.userId ?? "board", agentId: null };
            const existing = await secrets.getByName(companyId, a.name);
            if (existing) {
              // getByName filters only deletedAt IS NULL, not status. A founder may
              // have DISABLED or ARCHIVED this deterministic Commander secret from
              // Settings (status "disabled"/"archived"; company_secrets has no
              // disabledAt/archivedAt column — status is the sole switch). rotate()
              // only appends a version + bumps latestVersion; it never touches
              // status. So without reactivating, the value would rotate but runtime
              // resolveSecretValue still rejects it with "Secret is not active" and
              // pasting a fresh key could never recover verification (Codex P2).
              // Reactivate via the canonical update() seam FIRST, then rotate, so the
              // final state is active + newest value. Both run on the tx handle, so a
              // later rotate/binding failure rolls the reactivation back too — it can
              // never be left committed-but-unaudited. (A deleted secret has deletedAt
              // set, so getByName excludes it and the create path below runs.)
              if (existing.status !== "active") {
                operation = "reactivated";
                await secrets.update(existing.id, { status: "active" });
              } else {
                operation = "rotated";
              }
              await secrets.rotate(existing.id, { value: a.value }, actorRef);
              return { secretId: existing.id };
            }
            operation = "created";
            const created = (await secrets.create(
              companyId,
              { name: a.name, key: a.key, provider: "local_encrypted", managedMode: "aoa_managed", value: a.value },
              actorRef,
            )) as { id?: string; secretId?: string };
            const secretId = created.secretId ?? created.id;
            if (!secretId) throw new Error("secret create returned no id");
            return { secretId };
          },
          updateAgentAdapterConfig: async (a) => {
            await txDb
              .update(agents)
              .set({ adapterConfig: a.adapterConfig, updatedAt: new Date() })
              .where(eq(agents.id, a.agentId));
          },
          syncEnvBindings: async (a) => {
            await secrets.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: a.targetId }, a.env);
          },
        },
        { companyId, agentId, provider, apiKey: value, adapterConfig },
      );

      // Audit the credential mutation (AGENTS.md §5 — log all mutating actions)
      // INSIDE the tx, so the audit row commits atomically with the mutation and
      // rolls back with it on failure. The raw key is NEVER included; the durable
      // secret reference is entityId (unredacted), matching routes/secrets.ts.
      await logActivity(txDb, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: `commander.key.${operation}`,
        entityType: "secret",
        entityId: result.secretId,
        details: { provider, secretId: result.secretId, operation },
      });

      return result.secretId;
    });

    res.json({
      ok: true,
      secretId,
      verification: "verified",
    });
  });

  return router;
}
