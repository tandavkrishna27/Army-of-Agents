import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { universeAttentionCheckpoints, type Db } from "@armyofagents/db";
import {
  universeAttentionCheckpointInputSchema,
  type UniverseAttentionCheckpoint,
  type UniverseAttentionCheckpointInput,
} from "@armyofagents/shared";
import { insertActivityLog, publishActivityLogged, type PersistedActivity } from "./activity-log.js";
import { unprocessable } from "../errors.js";

type TokenPayload = { companyId: string; userId: string; asOf: string };

export class UniverseAttentionCheckpointConflictError extends Error {
  constructor(readonly latest: UniverseAttentionCheckpoint) {
    super("Universe attention checkpoint changed in another session");
    this.name = "UniverseAttentionCheckpointConflictError";
  }
}

function signingSecret() {
  const secret = process.env.BETTER_AUTH_SECRET?.trim() || process.env.AOA_AGENT_JWT_SECRET?.trim();
  if (!secret) throw new Error("A server signing secret is required for Universe attention checkpoints");
  return secret;
}

function encode(payload: TokenPayload, secret: string) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decode(token: string, secret: string): TokenPayload {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw unprocessable("Invalid attention snapshot token");
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { throw unprocessable("Invalid attention snapshot token"); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unprocessable("Invalid attention snapshot token");
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (!parsed.companyId || !parsed.userId || Number.isNaN(new Date(parsed.asOf).getTime())) throw new Error();
    return parsed;
  } catch { throw unprocessable("Invalid attention snapshot token"); }
}

const snapshot = (row?: { revision: number; lastAcknowledgedAt: Date | null }): UniverseAttentionCheckpoint => ({
  revision: row?.revision ?? 0,
  lastAcknowledgedAt: row?.lastAcknowledgedAt?.toISOString() ?? null,
});

export function universeAttentionCheckpointService(db: Db, options: { secret?: string; now?: () => Date } = {}) {
  const secret = options.secret ?? signingSecret();
  const now = options.now ?? (() => new Date());
  const selectOwner = async (executor: Pick<Db, "select">, companyId: string, userId: string, lock = false) => {
    let query = executor.select({
      id: universeAttentionCheckpoints.id,
      revision: universeAttentionCheckpoints.revision,
      lastAcknowledgedAt: universeAttentionCheckpoints.lastAcknowledgedAt,
    }).from(universeAttentionCheckpoints).where(and(
      eq(universeAttentionCheckpoints.companyId, companyId),
      eq(universeAttentionCheckpoints.userId, userId),
    ));
    if (lock && "for" in query) query = query.for("update") as typeof query;
    return (await query)[0];
  };

  return {
    issueToken(companyId: string, userId: string, asOf: string) {
      return encode({ companyId, userId, asOf }, secret);
    },
    async get(companyId: string, userId: string) {
      return snapshot(await selectOwner(db, companyId, userId));
    },
    async acknowledge(companyId: string, userId: string, raw: UniverseAttentionCheckpointInput) {
      const input = universeAttentionCheckpointInputSchema.parse(raw);
      const token = decode(input.through, secret);
      if (token.companyId !== companyId || token.userId !== userId) throw unprocessable("Attention snapshot does not belong to this user");
      const through = new Date(token.asOf);
      if (through.getTime() > now().getTime() + 60_000) throw unprocessable("Attention snapshot is from the future");
      let activity: PersistedActivity | undefined;
      const result = await db.transaction(async tx => {
        await tx.insert(universeAttentionCheckpoints).values({ companyId, userId }).onConflictDoNothing({
          target: [universeAttentionCheckpoints.companyId, universeAttentionCheckpoints.userId],
        });
        const row = await selectOwner(tx as unknown as Db, companyId, userId, true);
        if (!row) throw new Error("Universe attention checkpoint was not created");
        if (row.revision !== input.baseRevision) throw new UniverseAttentionCheckpointConflictError(snapshot(row));
        if (row.lastAcknowledgedAt && through <= row.lastAcknowledgedAt) throw unprocessable("Attention snapshot is not newer than the acknowledged checkpoint");
        const [saved] = await tx.update(universeAttentionCheckpoints).set({
          revision: row.revision + 1,
          lastAcknowledgedAt: through,
          updatedAt: now(),
        }).where(and(
          eq(universeAttentionCheckpoints.id, row.id),
          eq(universeAttentionCheckpoints.revision, row.revision),
        )).returning({
          revision: universeAttentionCheckpoints.revision,
          lastAcknowledgedAt: universeAttentionCheckpoints.lastAcknowledgedAt,
        });
        if (!saved) throw new UniverseAttentionCheckpointConflictError(snapshot(await selectOwner(tx as unknown as Db, companyId, userId, true)));
        activity = await insertActivityLog(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "universe.attention.acknowledged",
          entityType: "universe_attention_checkpoint",
          entityId: row.id,
          details: { through: token.asOf },
        });
        return snapshot(saved);
      });
      if (activity) publishActivityLogged(activity);
      return result;
    },
  };
}
