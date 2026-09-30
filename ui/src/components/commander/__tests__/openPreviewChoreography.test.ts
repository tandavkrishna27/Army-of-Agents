/**
 * Phase 6 — openPreview/closePreview choreography unit tests.
 *
 * Tests the pure collapse-state logic that openPreview/closePreview implement
 * in AgentPanelContent, exercising the three cases from the plan:
 *   • center open  → collapse BOTH sessions + cockpit
 *   • right-panel open on ultrawide (isWide=true) → collapse sessions only
 *   • right-panel open on tablet (isWide=false) → collapse BOTH (B6 rule)
 *   • closePreview → restore pre-open sessions + cockpit state
 */

import { describe, it, expect } from "vitest";

// ─── Pure choreography model (mirrors AgentPanelContent logic) ────────────────

interface PanelState {
  viewerCollapsed: boolean;
  sessionsCollapsed: boolean;
  cockpitCollapsed: boolean;
}

interface Snapshot {
  sessions: boolean;
  cockpit: boolean;
}

/**
 * Returns the panel state after openPreview and the snapshot taken before it.
 * Mirrors the logic in AgentPanelContent.openPreview exactly.
 */
function openPreview(
  before: PanelState,
  source: "center" | "right-panel",
  isWide: boolean,
): { after: PanelState; snapshot: Snapshot } {
  const snapshot: Snapshot = {
    sessions: before.sessionsCollapsed,
    cockpit: before.cockpitCollapsed,
  };

  const after: PanelState = {
    viewerCollapsed: false,          // always expand viewer
    sessionsCollapsed: true,         // always collapse sessions
    cockpitCollapsed:
      source === "center" || !isWide // center or narrow → collapse cockpit too
        ? true
        : before.cockpitCollapsed,   // ultrawide right-panel → leave cockpit as-is
  };

  return { after, snapshot };
}

/**
 * Returns the panel state after closePreview — restores from snapshot.
 * Mirrors the logic in AgentPanelContent.closePreview exactly.
 */
function closePreview(
  current: PanelState,
  snapshot: Snapshot | null,
): PanelState {
  if (!snapshot) {
    return { ...current, viewerCollapsed: true };
  }
  return {
    viewerCollapsed: true,
    sessionsCollapsed: snapshot.sessions,
    cockpitCollapsed: snapshot.cockpit,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("openPreview choreography", () => {
  const both_expanded: PanelState = {
    viewerCollapsed: true,
    sessionsCollapsed: false,
    cockpitCollapsed: false,
  };
  const sessions_already_collapsed: PanelState = {
    viewerCollapsed: true,
    sessionsCollapsed: true,
    cockpitCollapsed: false,
  };

  describe('source="center" (chat-header toggle)', () => {
    it("collapses BOTH sessions and cockpit on ultrawide", () => {
      const { after } = openPreview(both_expanded, "center", true /* isWide */);
      expect(after.viewerCollapsed).toBe(false);
      expect(after.sessionsCollapsed).toBe(true);
      expect(after.cockpitCollapsed).toBe(true);
    });

    it("collapses BOTH sessions and cockpit on tablet (isWide=false)", () => {
      const { after } = openPreview(both_expanded, "center", false /* isWide */);
      expect(after.viewerCollapsed).toBe(false);
      expect(after.sessionsCollapsed).toBe(true);
      expect(after.cockpitCollapsed).toBe(true);
    });
  });

  describe('source="right-panel" (chip/cockpit/reply/browser/liveRef)', () => {
    it("on ultrawide: collapses sessions only, keeps cockpit expanded", () => {
      const { after } = openPreview(both_expanded, "right-panel", true /* isWide */);
      expect(after.viewerCollapsed).toBe(false);
      expect(after.sessionsCollapsed).toBe(true);
      expect(after.cockpitCollapsed).toBe(false); // cockpit stays open on ultrawide
    });

    it("on tablet (isWide=false): collapses BOTH sessions and cockpit (B6)", () => {
      const { after } = openPreview(both_expanded, "right-panel", false /* isWide */);
      expect(after.viewerCollapsed).toBe(false);
      expect(after.sessionsCollapsed).toBe(true);
      expect(after.cockpitCollapsed).toBe(true); // B6: tablet collapses both
    });
  });

  describe("snapshot captures pre-open state", () => {
    it("snapshots both panels before any collapse", () => {
      const before: PanelState = { viewerCollapsed: true, sessionsCollapsed: false, cockpitCollapsed: false };
      const { snapshot } = openPreview(before, "center", true);
      expect(snapshot.sessions).toBe(false);
      expect(snapshot.cockpit).toBe(false);
    });

    it("snapshots already-collapsed sessions correctly", () => {
      const { snapshot } = openPreview(sessions_already_collapsed, "right-panel", true);
      expect(snapshot.sessions).toBe(true);
      expect(snapshot.cockpit).toBe(false);
    });
  });
});

describe("closePreview choreography", () => {
  const open_state: PanelState = {
    viewerCollapsed: false,
    sessionsCollapsed: true,
    cockpitCollapsed: true,
  };

  it("collapses viewer and restores BOTH sessions + cockpit to pre-open state", () => {
    const snapshot: Snapshot = { sessions: false, cockpit: false };
    const after = closePreview(open_state, snapshot);
    expect(after.viewerCollapsed).toBe(true);
    expect(after.sessionsCollapsed).toBe(false);
    expect(after.cockpitCollapsed).toBe(false);
  });

  it("does NOT force-expand panels that were already collapsed before open", () => {
    // User had sessions already collapsed before they opened preview
    const snapshot: Snapshot = { sessions: true, cockpit: false };
    const after = closePreview(open_state, snapshot);
    expect(after.sessionsCollapsed).toBe(true); // stays collapsed — not force-expanded
    expect(after.cockpitCollapsed).toBe(false);
  });

  it("collapses viewer even when snapshot is null (no prior open)", () => {
    const after = closePreview(open_state, null);
    expect(after.viewerCollapsed).toBe(true);
    // No restoration when there was no snapshot
    expect(after.sessionsCollapsed).toBe(true);
    expect(after.cockpitCollapsed).toBe(true);
  });

  describe("round-trip: openPreview → closePreview restores original state", () => {
    it('center open on ultrawide → close restores both panels', () => {
      const initial: PanelState = { viewerCollapsed: true, sessionsCollapsed: false, cockpitCollapsed: false };
      const { after: opened, snapshot } = openPreview(initial, "center", true);
      const restored = closePreview(opened, snapshot);
      expect(restored.viewerCollapsed).toBe(true);
      expect(restored.sessionsCollapsed).toBe(initial.sessionsCollapsed);
      expect(restored.cockpitCollapsed).toBe(initial.cockpitCollapsed);
    });

    it('right-panel open on ultrawide → close restores sessions (cockpit was untouched)', () => {
      const initial: PanelState = { viewerCollapsed: true, sessionsCollapsed: false, cockpitCollapsed: false };
      const { after: opened, snapshot } = openPreview(initial, "right-panel", true);
      expect(opened.cockpitCollapsed).toBe(false); // unchanged on ultrawide
      const restored = closePreview(opened, snapshot);
      expect(restored.sessionsCollapsed).toBe(false);
      expect(restored.cockpitCollapsed).toBe(false);
    });

    it('right-panel open on tablet → close restores sessions + cockpit', () => {
      const initial: PanelState = { viewerCollapsed: true, sessionsCollapsed: false, cockpitCollapsed: false };
      const { after: opened, snapshot } = openPreview(initial, "right-panel", false);
      const restored = closePreview(opened, snapshot);
      expect(restored.sessionsCollapsed).toBe(false);
      expect(restored.cockpitCollapsed).toBe(false);
    });
  });
});
