import { and, eq, desc, gt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  internalAgentConversations,
  internalAgentMessages,
} from "@armyofagents/db";
import { showRefSchema } from "@armyofagents/shared";
import { mergeOutputRefs } from "./output-refs.js";

export interface MessageInput {
  role: string;
  content?: string | null;
  toolCalls?: unknown;
  toolResults?: unknown;
  pageContext?: string | null;
  departmentContext?: string | null;
  tokenCount?: number | null;
  runId?: string | null;
  outputRefs?: unknown;
  reasoning?: string | null;
  clientSubmissionId?: string | null;
  replyToUserMessageId?: string | null;
}

const MESSAGE_THRESHOLD = 20;

/**
 * Staleness window for a durable Commander turn claim (PR #291 round-6, revised
 * round-7 #1). A row whose lease has not been refreshed within this window is
 * presumed abandoned (its process died mid-turn) and becomes reclaimable.
 *
 * It MUST exceed the maximum time a live turn can go without refreshing its
 * lease. The CLI IDLE timeout is 30 min (cli-mode.ts) — a turn can sit idle up
 * to that long between chunks before being killed — so 10 min would let a
 * genuinely-alive-but-quiet turn be reclaimed and DOUBLE-RUN. We set the window
 * comfortably above the idle timeout (35 min) as the crash-recovery backstop,
 * AND the owner heartbeats `turn_claimed_at` during the stream (agent-loop) so
 * an actively-streaming turn of any total duration never ages into the window.
 */
export const COMMANDER_TURN_STALE_MINUTES = 35;

/**
 * How often the owner refreshes its lease during a long turn (agent-loop
 * throttles per-chunk heartbeats to this interval). Must be well under
 * COMMANDER_TURN_STALE_MINUTES so a live turn's lease never ages out.
 */
export const COMMANDER_TURN_HEARTBEAT_MS = 60_000;

export function conversationService(db: Db) {
  return {
    async getOrCreateActive(companyId: string, userId: string) {
      const existing = await db
        .select()
        .from(internalAgentConversations)
        .where(
          and(
            eq(internalAgentConversations.companyId, companyId),
            eq(internalAgentConversations.userId, userId),
            eq(internalAgentConversations.status, "active"),
          ),
        )
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);

      if (existing) return existing;

      return db
        .insert(internalAgentConversations)
        .values({ companyId, userId, status: "active", messageCount: 0 })
        .returning()
        .then((rows: any[]) => rows[0]);
    },

    async appendMessage(conversationId: string, message: MessageInput) {
      // Viewer refs: validate PER REF at the persistence boundary — one malformed
      // lifted ref must not erase the message's valid refs (T2 review). Message
      // itself always saves. mergeOutputRefs unifies the cap with
      // the design's created-first precedence AND dedupes (T7 review).
      let outputRefs: unknown = null;
      if (Array.isArray(message.outputRefs) && message.outputRefs.length > 0) {
        const valid = message.outputRefs.flatMap((r) => {
          const p = showRefSchema.safeParse(r);
          return p.success ? [p.data] : [];
        });
        const merged = mergeOutputRefs([], valid);
        outputRefs = merged.length > 0 ? merged : null;
      }

      const inserted = await db
        .insert(internalAgentMessages)
        .values({
          conversationId,
          role: message.role,
          content: message.content ?? null,
          toolCalls: message.toolCalls ?? null,
          toolResults: message.toolResults ?? null,
          pageContext: message.pageContext ?? null,
          departmentContext: message.departmentContext ?? null,
          tokenCount: message.tokenCount ?? null,
          runId: message.runId ?? null,
          outputRefs,
          reasoning: message.reasoning ?? null,
          clientSubmissionId: message.clientSubmissionId ?? null,
          replyToUserMessageId: message.replyToUserMessageId ?? null,
        })
        // Concurrency backstop for the replay check in agent-loop.chat(): a
        // simultaneous duplicate key resolves to one row via the partial
        // index. Targeted at that index (2026-07-16) so any OTHER unique
        // violation raises instead of being swallowed.
        .onConflictDoNothing({
          target: [internalAgentMessages.conversationId, internalAgentMessages.clientSubmissionId],
          where: sql`client_submission_id IS NOT NULL`,
        })
        .returning()
        .then((rows: any[]) => rows[0]);

      // A lost insert race means the duplicate turn is already recorded; don't
      // double-count the conversation's messages.
      if (!inserted) return inserted;

      await db
        .update(internalAgentConversations)
        .set({
          messageCount: sql`${internalAgentConversations.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(internalAgentConversations.id, conversationId));

      return inserted;
    },

    /** Idempotency lookup: the user message previously persisted for this key. */
    async getMessageByClientSubmissionId(
      conversationId: string,
      clientSubmissionId: string,
    ) {
      return db
        .select()
        .from(internalAgentMessages)
        .where(
          and(
            eq(internalAgentMessages.conversationId, conversationId),
            eq(internalAgentMessages.clientSubmissionId, clientSubmissionId),
          ),
        )
        .then((rows: any[]) => rows[0] ?? null);
    },

    /**
     * The assistant reply explicitly linked to a given user turn (PR #291
     * review). Unlike the timestamp heuristic, this cannot mis-attribute a
     * later, unrelated turn's reply to a user message whose original send died
     * before replying. Returns null for legacy assistant rows (no linkage),
     * which the caller treats as "no reply yet → re-run".
     */
    async getAssistantReplyForUserMessage(
      conversationId: string,
      userMessageId: string,
    ) {
      return db
        .select()
        .from(internalAgentMessages)
        .where(
          and(
            eq(internalAgentMessages.conversationId, conversationId),
            eq(internalAgentMessages.role, "assistant"),
            eq(internalAgentMessages.replyToUserMessageId, userMessageId),
          ),
        )
        .orderBy(internalAgentMessages.createdAt, internalAgentMessages.id)
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);
    },

    /**
     * Durable, cross-instance turn claim (PR #291 round-6, round-7 #1). ONE
     * atomic CAS: flip the user row to 'running' only if it is unclaimed (NULL),
     * previously failed, or a STALE 'running' (lease not refreshed within the
     * window → owner presumably died). Mints a FRESH owner token on each win and
     * returns it — Postgres serializes the conditional UPDATE, so exactly one of
     * N racing processes gets a token back. Returns null when another process/
     * worker owns the turn; the caller must NOT start a second CLI run. The token
     * gates heartbeatTurn/finishTurn so a reclaimed original owner can neither
     * bump the new owner's lease nor overwrite its status.
     */
    async claimTurn(userMessageId: string): Promise<string | null> {
      const result = await db.execute(sql`
        UPDATE internal_agent_messages
        SET turn_status = 'running', turn_claimed_at = now(), turn_claim_token = gen_random_uuid()
        WHERE id = ${userMessageId}
          AND (
            turn_status IS NULL
            OR turn_status = 'failed'
            OR (turn_status = 'running'
                AND turn_claimed_at < now() - ${sql.raw(String(COMMANDER_TURN_STALE_MINUTES))} * interval '1 minute')
          )
        RETURNING turn_claim_token AS "turnClaimToken"
      `);
      const rows = Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] })?.rows ?? []);
      const token = (rows[0] as { turnClaimToken?: string } | undefined)?.turnClaimToken;
      return token ?? null;
    },

    /**
     * Refresh the lease of a turn THIS request owns (PR #291 round-7 #1). Bumps
     * turn_claimed_at only while the token still matches and the turn is running,
     * so an actively-streaming turn never ages into the staleness window and a
     * reclaimed owner's heartbeat is a no-op. Best-effort — the caller swallows.
     */
    async heartbeatTurn(userMessageId: string, token: string): Promise<void> {
      await db
        .update(internalAgentMessages)
        .set({ turnClaimedAt: new Date() })
        .where(
          and(
            eq(internalAgentMessages.id, userMessageId),
            eq(internalAgentMessages.turnClaimToken, token),
            eq(internalAgentMessages.turnStatus, "running"),
          ),
        );
    },

    /**
     * Release a claimed turn (PR #291 round-6, round-7 #1). Only the current
     * owner (matching token) may set the terminal status, so an original owner
     * whose stale claim was reclaimed cannot clobber the new owner. 'done' = a
     * reply persisted (a retry replays it); 'failed' = the turn ended without a
     * reply (config/CLI error, empty turn) so a retry can reclaim + re-run.
     */
    async finishTurn(userMessageId: string, token: string, status: "done" | "failed"): Promise<void> {
      await db
        .update(internalAgentMessages)
        .set({ turnStatus: status })
        .where(
          and(
            eq(internalAgentMessages.id, userMessageId),
            eq(internalAgentMessages.turnClaimToken, token),
          ),
        );
    },

    async getRecentMessages(conversationId: string, limit = 50) {
      return db
        .select()
        .from(internalAgentMessages)
        .where(eq(internalAgentMessages.conversationId, conversationId))
        .orderBy(desc(internalAgentMessages.createdAt), desc(internalAgentMessages.id))
        .limit(limit)
        .then((rows: any[]) => rows.reverse());
    },

    async getMessagesSince(conversationId: string, sinceMessageId: string | null, limit = 50) {
      let markerCreatedAt: Date | null = null;
      if (sinceMessageId) {
        const markerRows = await db
          .select({ createdAt: internalAgentMessages.createdAt })
          .from(internalAgentMessages)
          .where(eq(internalAgentMessages.id, sinceMessageId))
          .then((r: { createdAt: Date }[]) => r);
        markerCreatedAt = markerRows[0]?.createdAt ?? null;
      }
      const base = db
        .select()
        .from(internalAgentMessages)
        .where(
          markerCreatedAt
            ? and(eq(internalAgentMessages.conversationId, conversationId), gt(internalAgentMessages.createdAt, markerCreatedAt))
            : eq(internalAgentMessages.conversationId, conversationId),
        );
      // Chronological; cap at `limit` most-recent then re-sort ascending.
      const rows = await base
        .orderBy(desc(internalAgentMessages.createdAt), desc(internalAgentMessages.id))
        .limit(limit)
        .then((r: any[]) => r.reverse());
      return rows;
    },

    async summarizeIfNeeded(
      conversationId: string,
      summarize: (transcript: string) => Promise<string>,
    ) {
      const countResult = await db
        .select({ count: sql`count(*)` })
        .from(internalAgentMessages)
        .where(eq(internalAgentMessages.conversationId, conversationId))
        .then((rows: any[]) => rows[0]);

      const totalCount = Number(countResult?.count ?? 0);
      if (totalCount <= MESSAGE_THRESHOLD) return;

      const offsetCount = totalCount - MESSAGE_THRESHOLD;
      const oldMessages = await db
        .select()
        .from(internalAgentMessages)
        .where(eq(internalAgentMessages.conversationId, conversationId))
        .orderBy(internalAgentMessages.createdAt)
        .limit(offsetCount);

      if (oldMessages.length === 0) return;

      const transcript = oldMessages
        .map((m: any) => {
          if (m.role === "tool_call" && m.toolCalls) {
            const calls = (m.toolCalls as any[]).map((tc: any) => tc.name).join(", ");
            return `assistant: [Called tools: ${calls}]`;
          }
          if (m.content) return `${m.role}: ${m.content}`;
          return null;
        })
        .filter(Boolean)
        .join("\n");

      if (!transcript.trim()) return;

      const summary = await summarize(transcript);
      if (!summary || !summary.trim()) return;

      const lastOldMessage = oldMessages[oldMessages.length - 1] as any;
      await db
        .update(internalAgentConversations)
        .set({
          summarizedContext: summary,
          summarizedUpToMessageId: lastOldMessage.id,
          updatedAt: new Date(),
        })
        .where(eq(internalAgentConversations.id, conversationId));
    },

    async getById(conversationId: string) {
      const [conv] = await db
        .select()
        .from(internalAgentConversations)
        .where(eq(internalAgentConversations.id, conversationId));
      return conv ?? null;
    },

    async reset(companyId: string, userId: string) {
      await db
        .update(internalAgentConversations)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(internalAgentConversations.companyId, companyId),
            eq(internalAgentConversations.userId, userId),
            eq(internalAgentConversations.status, "active"),
          ),
        );

      return db
        .insert(internalAgentConversations)
        .values({ companyId, userId, status: "active", messageCount: 0 })
        .returning()
        .then((rows: any[]) => rows[0]);
    },
  };
}
