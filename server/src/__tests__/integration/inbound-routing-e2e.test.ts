/**
 * inbound-routing-e2e.test.ts
 * Phase 4.2 — Gated live E2E skeleton for the inbound dirty-data routing pipeline.
 *
 * PURPOSE
 * -------
 * This file establishes the live credentialed test lane for the full routing
 * pipeline. It is ALWAYS SKIPPED in CI and local dev unless:
 *
 *   1. OPENAI_API_KEY is set (real embeddings required for similarity scoring)
 *   2. RUN_INBOUND_E2E=1 is set (opt-in gate — prevents accidental live runs)
 *   3. DATABASE_URL points to a running PostgreSQL with migrations applied
 *
 * The skip guard is the entire point. Removing it would produce false greens
 * (the test would pass by vacuous vitest no-op, not by actually exercising the
 * live path). The guards must ALL be present.
 *
 * LIVE FLOW (documented for when the lane is activated)
 * -----------------------------------------------------
 *   1. Seed: create a company + internalAgentConfig row with desired
 *      inboundRoutingLevel, and optionally a Navigator agent.
 *
 *   2. Produce: call enqueueInboxItem(db, { companyId, rawContent, ... })
 *      to insert a thread_inbox_items row (routingStatus='pending_route').
 *
 *   3. Route: call routeInboxItem(db, { inboxItemId })
 *      — real embeddings via OPENAI_API_KEY → findSimilarThreadsScored
 *      — classifyRouting → resolveRoutingAction → action performed
 *
 *   4. Assert outcome by dial:
 *      - dial=auto_attach, confident match → action='auto_attach',
 *        attachInboxItemToThread called, routingStatus='routed',
 *        discussion entry posted to the matched thread.
 *      - dial=auto_attach, ambiguous (two similar threads) → action='escalate_navigator',
 *        agentWakeupRequests row inserted with candidateThreadIds.
 *      - dial=off → action='human', routingStatus='routed', no attach.
 *      - dial=full_auto, no threads exist → action='auto_create',
 *        promoteInboxItemToNewThread called, new thread created.
 *
 * ACTIVATION
 * ----------
 * To run the live lane locally once you have creds + DB:
 *
 *   OPENAI_API_KEY=sk-... DATABASE_URL=postgres://... RUN_INBOUND_E2E=1 \
 *     pnpm -C packages/server test:run inbound-routing-e2e
 *
 * Or in CI: add a separate workflow job (see thread-v2-e2e.yml pattern) that
 * injects the secrets and sets RUN_INBOUND_E2E=1 in the job env.
 *
 * NOTE: This file intentionally imports NO live services at the top level.
 * All imports are inside the describe body (or `beforeAll`) so that the module
 * graph is not pulled in during normal test runs, avoiding side effects from
 * modules that expect DB connections or API keys at import time.
 */

import { describe, it } from "vitest";

// ── Live gate ─────────────────────────────────────────────────────────────────
//
// All three env vars must be present for the live lane to activate.
// describe.skipIf is the canonical pattern used by thread-v2-real-e2e.integration.test.ts.

const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
const hasLiveE2EFlag = Boolean(process.env.RUN_INBOUND_E2E);
const hasDbUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasOpenAiKey || !hasLiveE2EFlag || !hasDbUrl)(
  "inbound routing E2E — live credentialed lane (gated, advisory)",
  () => {
    // ── Setup ────────────────────────────────────────────────────────────────
    //
    // When the gate opens, activate beforeAll/afterAll here:
    //
    //   import { createDb } from "@armyofagents/db";
    //   import { enqueueInboxItem } from "../../services/inbox-producer.js";
    //   import { routeInboxItem }    from "../../services/inbox-router.js";
    //   import { companyService }    from "../../services/companies.js";
    //
    //   let db: Db;
    //   let companyId: string;
    //
    //   beforeAll(async () => {
    //     db = createDb(process.env.DATABASE_URL!);
    //     const company = await companyService.createCompany(db, {
    //       name: "E2E Routing Test Co",
    //       deploymentMode: "local_trusted",
    //     });
    //     companyId = company.id;
    //
    //     // Set dial to auto_attach for the happy path
    //     await db.insert(internalAgentConfig).values({
    //       companyId,
    //       inboundRoutingLevel: "auto_attach",
    //     });
    //   });
    //
    //   afterAll(async () => {
    //     // Teardown: delete company cascade
    //     await db.delete(companies).where(eq(companies.id, companyId));
    //   });

    // ── Happy path: off-dial stays in Inbox ──────────────────────────────────
    it.skip(
      "off-dial: enqueue → route → action='human', item stays in Inbox pending manual triage",
      async () => {
        // STEP 1: Seed item
        // const { itemId } = await enqueueInboxItem(db, {
        //   companyId,
        //   rawContent: "Hello, I need help with my account",
        //   originMedium: "email",
        //   originSource: "support@example.com",
        //   originRef: `e2e-off-${Date.now()}`,
        // });
        //
        // STEP 2: Override dial to 'off' for this sub-test
        // await db.update(internalAgentConfig)
        //   .set({ inboundRoutingLevel: "off" })
        //   .where(eq(internalAgentConfig.companyId, companyId));
        //
        // STEP 3: Route (real embeddings — will score similarity against threads in DB)
        // const result = await routeInboxItem(db, { inboxItemId: itemId });
        //
        // STEP 4: Assert
        // expect(result.action).toBe("human");
        //
        // const [row] = await db.select()
        //   .from(threadInboxItems)
        //   .where(eq(threadInboxItems.id, itemId))
        //   .limit(1);
        //
        // expect(row.routingStatus).toBe("routed");
        // expect(row.status).toBe("pending");  // still in Inbox — human must act
      },
    );

    // ── Happy path: confident match → auto_attach (content posted) ───────────
    it.skip(
      "auto_attach: confident match → action='auto_attach', content posted to thread",
      async () => {
        // PRECONDITION: a thread must exist in the company with embedding content
        // similar to the inbox item text. Seed one via threadsService.createThread.
        //
        // STEP 1: Seed a target thread with known content
        // const { threadId } = await threadsService.createThread(db, {
        //   companyId, title: "Account access issues", summary: "User locked out"
        // });
        //
        // STEP 2: Enqueue similar item
        // const { itemId } = await enqueueInboxItem(db, {
        //   companyId,
        //   rawContent: "I'm locked out of my account and need access restored",
        //   originMedium: "email",
        //   originSource: "user@example.com",
        //   originRef: `e2e-attach-${Date.now()}`,
        // });
        //
        // STEP 3: Route (real embeddings)
        // const result = await routeInboxItem(db, { inboxItemId: itemId });
        //
        // STEP 4: Assert confident attach
        // expect(result.action).toBe("auto_attach");
        // expect(result.outcome).toBe("attach_confident");
        //
        // // Verify content posted: a discussion entry should appear on the thread
        // const entries = await db.select()
        //   .from(discussionEntries)
        //   .where(eq(discussionEntries.threadId, threadId));
        // expect(entries.length).toBeGreaterThanOrEqual(1);
        //
        // const [row] = await db.select()
        //   .from(threadInboxItems)
        //   .where(eq(threadInboxItems.id, itemId))
        //   .limit(1);
        // expect(row.routingStatus).toBe("routed");
        // expect(row.status).toBe("attached");
      },
    );

    // ── Ambiguous: near-tie → escalate_navigator ──────────────────────────────
    it.skip(
      "ambiguous: near-tie candidates → action='escalate_navigator', wakeup inserted",
      async () => {
        // PRECONDITION: two threads with nearly identical content must exist so
        // findSimilarThreadsScored returns two results with a gap < AMBIGUITY_MARGIN=0.05.
        // In practice seed two threads with very similar titles/summaries.
        //
        // STEP 1: Seed Navigator agent (kind='aoa', name='Navigator')
        // STEP 2: Seed two near-identical threads
        // STEP 3: Enqueue item similar to both
        // STEP 4: Route
        // STEP 5: Assert
        //
        // expect(result.action).toBe("escalate_navigator");
        // const [wakeup] = await db.select()
        //   .from(agentWakeupRequests)
        //   .where(eq(agentWakeupRequests.source, "inbox.routing_ambiguous"))
        //   ...
        // expect(wakeup.payload.candidateThreadIds).toHaveLength(2);
        // expect(wakeup.payload).not.toHaveProperty("threadId"); // Codex #4
      },
    );

    // ── Full_auto + no match → auto_create (promote) ─────────────────────────
    it.skip(
      "full_auto + explicit_no_match: no threads → action='auto_create', new thread created",
      async () => {
        // PRECONDITION: company has no threads (or no similar ones).
        // Use a fresh company or ensure rawContent is deliberately dissimilar.
        //
        // STEP 1: Override dial to full_auto
        // STEP 2: Enqueue item with deliberately novel content
        // STEP 3: Route
        // expect(result.action).toBe("auto_create");
        //
        // A new thread should exist with the item's content as its seed entry.
        // const [row] = await db.select()
        //   .from(threadInboxItems)
        //   .where(eq(threadInboxItems.id, itemId))
        //   .limit(1);
        // expect(row.routingStatus).toBe("routed");
        // expect(row.status).toBe("attached");
      },
    );
  },
);
