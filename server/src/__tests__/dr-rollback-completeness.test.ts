/**
 * REL-003 (E11) Lane C (pure) — rollback completeness.
 *
 * PURE unit for `evaluateRollbackCompleteness`
 * (server/src/services/disaster-recovery/rollback-completeness.ts). Runs on every
 * platform. The DE-20 clause "marker deletion alone is never accepted as rollback"
 * is the headline (I10). Fail-first: a positive control (stub the verifier to
 * `accepted`) proves the refusal cases fire; the guards C-G1..C-G3 are each
 * mutation-tested by DELETION (design §7). The DB-level proof that a marker delete
 * leaves the 0188 schema intact is the embedded-PG Lane C (I11).
 */
import { describe, it, expect } from "vitest";
import {
  evaluateRollbackCompleteness,
  type RollbackAction,
  type RollbackState,
} from "../services/disaster-recovery/rollback-completeness.js";

const SCHEMA_INTACT: RollbackState = { organizationsTablePresent: true };
const SCHEMA_DROPPED: RollbackState = { organizationsTablePresent: false };

describe("evaluateRollbackCompleteness", () => {
  it("I10: a marker-deletion-only action set is REFUSED (marker deletion is not rollback)", () => {
    const result = evaluateRollbackCompleteness(["marker_deleted"], SCHEMA_INTACT);
    expect(result.verdict).toBe("refused");
    expect(result.reason).toBe("marker_deletion_is_not_rollback");
    // The evidence: the tenant schema is untouched by the marker delete.
    expect(result.tenantSchemaIntact).toBe(true);
  });

  it("C-G2: an accepted rollback needs a real revert — a dial flip alone is refused", () => {
    const result = evaluateRollbackCompleteness(["dial_reverted_to_legacy"], SCHEMA_INTACT);
    expect(result.verdict).toBe("refused");
    expect(result.reason).toBe("incomplete_rollback_no_revert");
  });

  it("C-G3: an empty action set is fail-closed refused (absence is refusal)", () => {
    const result = evaluateRollbackCompleteness([], SCHEMA_INTACT);
    expect(result.verdict).toBe("refused");
    expect(result.reason).toBe("empty_action_set");
  });

  it("accepts a snapshot restore + dial flip (the truest green — a real revert)", () => {
    const actions: RollbackAction[] = ["snapshot_restored", "dial_reverted_to_legacy"];
    const result = evaluateRollbackCompleteness(actions, SCHEMA_DROPPED);
    expect(result.verdict).toBe("accepted");
    expect(result.reason).toBeNull();
  });

  it("accepts a single-org revert0188 (the escape-hatch rollback path)", () => {
    const result = evaluateRollbackCompleteness(["revert0188_single_org", "dial_reverted_to_legacy"], SCHEMA_DROPPED);
    expect(result.verdict).toBe("accepted");
    expect(result.reason).toBeNull();
  });

  it("still refuses marker-deletion even when accompanied by a dial flip (no real revert)", () => {
    // marker_deleted + dial flip is not marker-ONLY, so it is not the C-G1 reason;
    // but it still lacks a real revert → C-G2 refusal.
    const result = evaluateRollbackCompleteness(["marker_deleted", "dial_reverted_to_legacy"], SCHEMA_INTACT);
    expect(result.verdict).toBe("refused");
    expect(result.reason).toBe("incomplete_rollback_no_revert");
  });
});
