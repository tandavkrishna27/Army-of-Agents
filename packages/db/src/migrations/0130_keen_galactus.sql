-- Task 2.1 (Crew Work-as-Tasks): one-pending-per-thread scope-proposal guard.
-- One-way gate: at most one scope_proposal entry with proposalStatus='pending'
-- per thread. writeScopeProposal catches the violation and converts it to
-- { existing: true } (idempotent). IF NOT EXISTS follows the C14 idempotency
-- rule (see packages/db/src/__tests__/migration-idempotency.test.ts).
CREATE UNIQUE INDEX IF NOT EXISTS "discussion_entries_one_pending_scope_proposal_idx" ON "discussion_entries" USING btree ("discussion_id") WHERE input_type = 'scope_proposal' AND proposal_status = 'pending';