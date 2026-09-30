/**
 * T2.7 — section-level diff/merge algebra for AGENT instruction bundles.
 *
 * Pure functions, no I/O. The route + write behaviour is covered by
 * `marketplace-agent-diff-merge-routes.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  AGENT_SECTION_KEY_SEPARATOR,
  LEGACY_BOOTSTRAP_PROMPT_TEMPLATE_FILE,
  LEGACY_PROMPT_TEMPLATE_FILE,
  agentSectionKey,
  applyAgentMergeDecisions,
  bundlesAreByteIdentical,
  computeAgentSectionDiff,
} from "../services/marketplace-agent-merge.js";

const MINE = `You are Scout.

## Tone
Always answer in Norwegian.

## Tools
find_similar_memory_hnsw
`;

const THEIRS = `You are Scout.

## Tone
Be concise and direct.

## Tools
find_similar_memory_hnsw
query_threads

## Escalation
Hand back to Adjutant when blocked.
`;

describe("computeAgentSectionDiff", () => {
  it("namespaces every section by its file so identical headings in two files stay independent", () => {
    const diff = computeAgentSectionDiff(
      { "AGENTS.md": "## Tone\nA\n", "REVIEW.md": "## Tone\nB\n" },
      { "AGENTS.md": "## Tone\nA2\n", "REVIEW.md": "## Tone\nB\n" },
    );

    const keys = diff.map((s) => s.header);
    expect(keys).toContain(`AGENTS.md${AGENT_SECTION_KEY_SEPARATOR}Tone`);
    expect(keys).toContain(`REVIEW.md${AGENT_SECTION_KEY_SEPARATOR}Tone`);
    // The discriminator: without the file prefix these two would share one
    // decision key, so a founder keeping AGENTS.md's Tone would silently also
    // keep REVIEW.md's.
    expect(new Set(keys).size).toBe(keys.length);

    const agentsTone = diff.find((s) => s.file === "AGENTS.md" && s.section === "Tone");
    const reviewTone = diff.find((s) => s.file === "REVIEW.md" && s.section === "Tone");
    expect(agentsTone?.state).toBe("changed");
    expect(reviewTone?.state).toBe("unchanged");
  });

  it("classifies a divergent single-file bundle section by section", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const bySection = Object.fromEntries(diff.map((s) => [s.section, s.state]));

    expect(bySection.__preamble__).toBe("unchanged");
    expect(bySection.Tone).toBe("changed");
    expect(bySection.Tools).toBe("changed");
    expect(bySection.Escalation).toBe("added");
  });

  it("marks a whole upstream-only file as `added`, never `changed`", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": "x\n" }, { "AGENTS.md": "x\n", "STYLE.md": "## A\nnew\n" });
    const styleSections = diff.filter((s) => s.file === "STYLE.md");
    expect(styleSections.length).toBeGreaterThan(0);
    expect(styleSections.every((s) => s.state === "added")).toBe(true);
  });

  it("does NOT create an upstream-only file the founder declined wholesale", () => {
    // F1. `allTheirs` is false (every decision is "mine") and the `allMine`
    // shortcut needs a local side, so control used to fall through to
    // `applyMergeDecisions`, which drops every added/"mine" section and returns
    // `"\n"` — materialising a one-newline phantom the agent then reads and
    // every later diff shows as the founder's own content. Directly reachable
    // from the `Keep all mine` bulk control.
    const mine = { "AGENTS.md": "## A\nalpha\n" };
    const theirs = { "AGENTS.md": "## A\nalpha\n", "NEW.md": "## New\nbrand new upstream file\n" };
    const diff = computeAgentSectionDiff(mine, theirs);
    const merged = applyAgentMergeDecisions(
      diff,
      Object.fromEntries(diff.map((s) => [s.header, "mine" as const])),
      { mine, upstream: theirs },
    );

    expect(merged.files).not.toHaveProperty("NEW.md");
    // It was never on disk, so it is not a deletion either.
    expect(merged.deletedFiles).not.toContain("NEW.md");
    expect(merged.files["AGENTS.md"]).toBe(mine["AGENTS.md"]);
    // Declining an upstream file is still a divergence from upstream.
    expect(merged.pureUpstream).toBe(false);
  });

  it("still creates an upstream-only file when only SOME of it is declined", () => {
    // The discriminator for F1's fix: skipping the file wholesale must not
    // swallow a partial acceptance.
    const mine = { "AGENTS.md": "## A\nalpha\n" };
    const theirs = { "AGENTS.md": "## A\nalpha\n", "NEW.md": "## Keep\nyes\n\n## Drop\nno\n" };
    const diff = computeAgentSectionDiff(mine, theirs);
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "theirs" as const]));
    decisions[agentSectionKey("NEW.md", "Drop")] = "mine";
    const merged = applyAgentMergeDecisions(diff, decisions, { mine, upstream: theirs });

    expect(merged.files["NEW.md"]).toContain("## Keep");
    expect(merged.files["NEW.md"]).not.toContain("## Drop");
  });

  it("marks a whole local-only file as `removed`", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": "x\n", "NOTES.md": "## Mine\nkeep\n" }, { "AGENTS.md": "x\n" });
    const notes = diff.filter((s) => s.file === "NOTES.md");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((s) => s.state === "removed")).toBe(true);
  });

  it("represents the two adapterConfig prompt fields as virtual files", () => {
    const diff = computeAgentSectionDiff(
      {
        "AGENTS.md": "x\n",
        [LEGACY_PROMPT_TEMPLATE_FILE]: "legacy prompt",
        [LEGACY_BOOTSTRAP_PROMPT_TEMPLATE_FILE]: "legacy bootstrap",
      },
      { "AGENTS.md": "x\n" },
    );

    const virtual = diff.filter((s) => s.virtual);
    expect(virtual.map((s) => s.file).sort()).toEqual(
      [LEGACY_BOOTSTRAP_PROMPT_TEMPLATE_FILE, LEGACY_PROMPT_TEMPLATE_FILE].sort(),
    );
    // Upstream never carries them, so they surface as `removed` — whose default
    // decision is "mine". A catalog update deletes both; the founder has to say
    // so explicitly here.
    expect(virtual.every((s) => s.state === "removed")).toBe(true);
  });
});

describe("applyAgentMergeDecisions", () => {
  it("keeps the founder's section BYTE-IDENTICAL while taking upstream elsewhere", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const merged = applyAgentMergeDecisions(
      diff,
      {
        [agentSectionKey("AGENTS.md", "Tone")]: "mine",
        [agentSectionKey("AGENTS.md", "Tools")]: "theirs",
        [agentSectionKey("AGENTS.md", "Escalation")]: "theirs",
      },
      { mine: { "AGENTS.md": MINE }, upstream: { "AGENTS.md": THEIRS } },
    );

    const out = merged.files["AGENTS.md"]!;
    // Assert CONTENT, not a status string: the founder's whole section — header
    // line included — has to survive byte-for-byte inside the merged document.
    const mineToneSection = diff.find((s) => s.section === "Tone")!.mine;
    expect(mineToneSection).toContain("Always answer in Norwegian.");
    expect(out).toContain(mineToneSection.trim());
    expect(out).not.toContain("Be concise and direct.");
    // …and the sections they gave away really did move to upstream.
    expect(out).toContain("query_threads");
    expect(out).toContain("Hand back to Adjutant when blocked.");
    expect(merged.pureUpstream).toBe(false);
    expect(merged.deletedFiles).toEqual([]);
  });

  it("keeping EVERY section returns the founder's file byte-for-byte", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "mine" as const]));
    const merged = applyAgentMergeDecisions(diff, decisions, { mine: { "AGENTS.md": MINE }, upstream: { "AGENTS.md": THEIRS } });

    // Not "contains the founder's text" — IS the founder's file. Reassembly
    // would have re-joined the sections and normalised their blank lines.
    expect(merged.files["AGENTS.md"]).toBe(MINE);
    expect(merged.pureUpstream).toBe(false);
  });

  it("writes upstream VERBATIM when every section is accepted, and reports pureUpstream", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "theirs" as const]));
    const merged = applyAgentMergeDecisions(diff, decisions, { mine: { "AGENTS.md": MINE }, upstream: { "AGENTS.md": THEIRS } });

    // The discriminator for the whole customization-flag design. Reassembling
    // sections with the section joiner produces *equivalent* text with
    // *different* bytes; if this were reassembled, `pureUpstream` could never be
    // honest and the NULL-provenance backlog could never drain.
    expect(merged.files["AGENTS.md"]).toBe(THEIRS);
    expect(merged.pureUpstream).toBe(true);
  });

  it("is not pureUpstream when a single section is kept, even if all others are accepted", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "theirs" as const]));
    decisions[agentSectionKey("AGENTS.md", "Tone")] = "mine";
    const merged = applyAgentMergeDecisions(diff, decisions, { mine: { "AGENTS.md": MINE }, upstream: { "AGENTS.md": THEIRS } });

    expect(merged.pureUpstream).toBe(false);
    expect(merged.files["AGENTS.md"]).toContain("Always answer in Norwegian.");
  });

  it("defaults to keeping everything of the founder's and taking new upstream material", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": MINE }, { "AGENTS.md": THEIRS });
    const merged = applyAgentMergeDecisions(diff, {}, { mine: { "AGENTS.md": MINE }, upstream: { "AGENTS.md": THEIRS } });

    const out = merged.files["AGENTS.md"]!;
    expect(out).toContain("Always answer in Norwegian.");
    expect(out).toContain("Hand back to Adjutant when blocked."); // added → theirs
    expect(merged.pureUpstream).toBe(false);
  });

  it("deletes a local-only file the founder gave away, and still calls that pure upstream", () => {
    const mine = { "AGENTS.md": "x\n", "NOTES.md": "## Mine\nscratch\n" };
    const theirs = { "AGENTS.md": "x\n" };
    const diff = computeAgentSectionDiff(mine, theirs);
    const decisions = Object.fromEntries(diff.map((s) => [s.header, "theirs" as const]));
    const merged = applyAgentMergeDecisions(diff, decisions, { mine, upstream: theirs });

    expect(merged.deletedFiles).toEqual(["NOTES.md"]);
    expect(Object.keys(merged.files)).toEqual(["AGENTS.md"]);
    expect(merged.pureUpstream).toBe(true);
  });

  it("keeping a local-only file blocks pureUpstream", () => {
    const mine = { "AGENTS.md": "x\n", "NOTES.md": "## Mine\nscratch\n" };
    const theirs = { "AGENTS.md": "x\n" };
    const diff = computeAgentSectionDiff(mine, theirs);
    const merged = applyAgentMergeDecisions(diff, {}, { mine, upstream: theirs });

    expect(merged.deletedFiles).toEqual([]);
    expect(merged.files["NOTES.md"]).toContain("scratch");
    expect(merged.pureUpstream).toBe(false);
  });

  it("a bundle already identical to upstream merges to pure upstream with NO decisions at all", () => {
    // The `instructions_customized IS NULL` backlog shape: nothing was ever
    // edited, the column just predates migration 0182.
    const diff = computeAgentSectionDiff({ "AGENTS.md": THEIRS }, { "AGENTS.md": THEIRS });
    expect(diff.every((s) => s.state === "unchanged")).toBe(true);

    const merged = applyAgentMergeDecisions(diff, {}, {
      mine: { "AGENTS.md": THEIRS },
      upstream: { "AGENTS.md": THEIRS },
    });
    // Default for `unchanged` is "mine", but mine === theirs, so the bytes are
    // upstream's either way. `pureUpstream` must be computed from that fact, not
    // from the decision labels — otherwise the backlog never drains.
    expect(merged.files["AGENTS.md"]).toBe(THEIRS);
    expect(merged.pureUpstream).toBe(true);
  });

  it("dropping the legacy promptTemplate is required for pure upstream", () => {
    const mine = { "AGENTS.md": "x\n", [LEGACY_PROMPT_TEMPLATE_FILE]: "old prompt" };
    const theirs = { "AGENTS.md": "x\n" };
    const diff = computeAgentSectionDiff(mine, theirs);

    const kept = applyAgentMergeDecisions(diff, {}, { mine, upstream: theirs });
    expect(kept.files[LEGACY_PROMPT_TEMPLATE_FILE]).toBe("old prompt");
    expect(kept.pureUpstream).toBe(false);

    const dropped = applyAgentMergeDecisions(
      diff,
      Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
      { mine, upstream: theirs },
    );
    expect(dropped.deletedFiles).toContain(LEGACY_PROMPT_TEMPLATE_FILE);
    expect(dropped.pureUpstream).toBe(true);
  });
});

describe("bundlesAreByteIdentical", () => {
  // F2. `computeSectionDiff` classifies `unchanged` on `.trim()`, but the
  // merge's wholesale-upstream relaxation requires BYTE equality. Deriving
  // "identical" from section states therefore reported "no local changes" about
  // a bundle that would then merge to `instructions_customized = true` — a
  // permanent freeze-out announced as a success.
  const TRAILING_WS = "## A\nalpha\n\n";
  const CLEAN = "## A\nalpha\n";

  it("is false for a trailing-whitespace-only divergence that every section calls `unchanged`", () => {
    const diff = computeAgentSectionDiff({ "AGENTS.md": TRAILING_WS }, { "AGENTS.md": CLEAN });
    expect(diff.every((s) => s.state === "unchanged")).toBe(true);
    expect(bundlesAreByteIdentical({ "AGENTS.md": TRAILING_WS }, { "AGENTS.md": CLEAN })).toBe(false);
  });

  it("is true only for an exact match", () => {
    expect(bundlesAreByteIdentical({ "AGENTS.md": CLEAN }, { "AGENTS.md": CLEAN })).toBe(true);
    expect(bundlesAreByteIdentical({ a: "x" }, { a: "x", b: "y" })).toBe(false);
    expect(bundlesAreByteIdentical({ a: "x", b: "y" }, { a: "x" })).toBe(false);
  });

  it("a trim-equal bundle CAN still be resolved to pure upstream", () => {
    // The recovery path the missing bulk bar used to make unreachable.
    const mine = { "AGENTS.md": TRAILING_WS };
    const upstream = { "AGENTS.md": CLEAN };
    const diff = computeAgentSectionDiff(mine, upstream);

    const defaults = applyAgentMergeDecisions(diff, {}, { mine, upstream });
    expect(defaults.pureUpstream).toBe(false);

    const allTheirs = applyAgentMergeDecisions(
      diff,
      Object.fromEntries(diff.map((s) => [s.header, "theirs" as const])),
      { mine, upstream },
    );
    expect(allTheirs.files["AGENTS.md"]).toBe(CLEAN);
    expect(allTheirs.pureUpstream).toBe(true);
  });
});
