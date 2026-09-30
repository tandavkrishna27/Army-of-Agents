import type { Db } from "@armyofagents/db";
import { extractionService } from "../../extraction.js";

/**
 * Sub-agent #1 extraction consumer.
 *
 * Routes discussion-entry extraction through the reliable direct-provider path
 * (extractionService -> resolveAvailableProvider, Decision A1), NOT the
 * CLI-adapter agent runner. The agent/CLI path (Decision #100) cannot reliably
 * submit results in practice: codex/opencode have no MCP bridge wiring yet
 * (runner.ts:134 injects --mcp-config for claude_local only), and the claude CLI
 * subprocess does not complete the submit_extracted_items handshake in local /
 * Windows dev. In both cases the run finishes but the entry is left stuck
 * 'processing' (silent loss). extractionService is provider-flexible and
 * terminalizes the entry itself (completed / failed / skipped).
 *
 * Decision #100 amended 2026-05-25: extraction default = direct-provider; the
 * agent/CLI extraction path is opt-in until hardened (bridge wiring for
 * codex/opencode + the claude headless submit hang). See docs/architecture/
 * decisions.md #100.
 *
 * The 4-arg signature `(db, companyId, entryId, agentId)` is preserved because
 * the dispatcher (aoa-agents/dispatcher.ts) calls it positionally. `agentId` is
 * unused now — the direct-provider path needs no agent row — so it is prefixed
 * `_` to mark it intentionally unused.
 *
 * Never rethrows: extractFromDiscussionEntry self-terminalizes on error
 * (asserted by extraction-refactor.test.ts "transitions to failed status on
 * error"), so addEntry / the dispatcher tick remain unaffected.
 */
export async function runExtractionConsumer(
  db: Db,
  companyId: string,
  entryId: string,
  _agentId: string,
): Promise<void> {
  await extractionService(db).extractFromDiscussionEntry(companyId, entryId);
}
