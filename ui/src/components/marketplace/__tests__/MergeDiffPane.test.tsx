/**
 * T2.7 — the review pane has to be usable for an AGENT bundle, where a section
 * is `<file>::<heading>` rather than a bare heading.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MergeDiffPane } from "../MergeDiffPane";
import type { SectionDiff } from "../types";

const AGENT_SECTIONS: SectionDiff[] = [
  {
    header: "AGENTS.md::Output",
    file: "AGENTS.md",
    section: "Output",
    state: "changed",
    mine: "## Output\nALWAYS in Norwegian.\n",
    theirs: "## Output\nPost one entry.\n",
  },
  {
    header: "TOOLS.md::Output",
    file: "TOOLS.md",
    section: "Output",
    state: "changed",
    mine: "## Output\nmine tools\n",
    theirs: "## Output\ntheirs tools\n",
  },
  {
    header: "promptTemplate.legacy.md::__preamble__",
    file: "promptTemplate.legacy.md",
    section: "__preamble__",
    virtual: true,
    state: "removed",
    mine: "legacy prompt",
    theirs: "",
  },
];

describe("MergeDiffPane — agent bundles", () => {
  it("shows which file each section came from, so two same-named headings are distinguishable", () => {
    render(<MergeDiffPane sections={AGENT_SECTIONS} onChange={vi.fn()} />);
    expect(screen.getByText("AGENTS.md ›")).toBeInTheDocument();
    expect(screen.getByText("TOOLS.md ›")).toBeInTheDocument();
    // The two "Output" headings render as separate rows rather than collapsing.
    expect(screen.getAllByText("Output")).toHaveLength(2);
  });

  it("labels an adapterConfig-backed pseudo-file as config, not as a real file", () => {
    render(<MergeDiffPane sections={AGENT_SECTIONS} onChange={vi.fn()} />);
    expect(screen.getByText("promptTemplate.legacy.md (config) ›")).toBeInTheDocument();
  });

  it("emits per-section decisions keyed by the composite header", () => {
    const onChange = vi.fn();
    render(<MergeDiffPane sections={AGENT_SECTIONS} onChange={onChange} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept upstream" })[1]!);

    const last = onChange.mock.calls.at(-1)![0] as Record<string, string>;
    expect(last["TOOLS.md::Output"]).toBe("theirs");
    // The discriminator: the same heading in the other file must NOT have moved.
    expect(last["AGENTS.md::Output"]).toBe("mine");
  });

  it("`Accept all upstream` sets every section at once — the NULL-backlog drain lever", () => {
    const onChange = vi.fn();
    render(<MergeDiffPane sections={AGENT_SECTIONS} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all upstream" }));

    const last = onChange.mock.calls.at(-1)![0] as Record<string, string>;
    expect(Object.values(last).every((v) => v === "theirs")).toBe(true);
    expect(Object.keys(last)).toHaveLength(AGENT_SECTIONS.length);
  });
});

describe("MergeDiffPane — all-unchanged reviews (F2)", () => {
  // `computeSectionDiff` calls a section `unchanged` on TRIM equality, so a
  // trailing-whitespace-only divergence renders an all-`unchanged` review —
  // and unchanged sections render no per-section buttons. Gating the bulk bar
  // on "has a changed section" therefore left the founder with no control at
  // all that could resolve the update to upstream, and no way out of
  // `instructions_customized = true`.
  const ALL_UNCHANGED: SectionDiff[] = [
    {
      header: "AGENTS.md::__preamble__",
      file: "AGENTS.md",
      section: "__preamble__",
      state: "unchanged",
      mine: "You are Scout.\n\n",
      theirs: "You are Scout.\n",
    },
  ];

  it("still offers the bulk controls when every section is unchanged", () => {
    render(<MergeDiffPane sections={ALL_UNCHANGED} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept all upstream" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept upstream" })).not.toBeInTheDocument();
  });

  it("resolves an all-unchanged review to upstream", () => {
    const onChange = vi.fn();
    render(<MergeDiffPane sections={ALL_UNCHANGED} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept all upstream" }));
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ "AGENTS.md::__preamble__": "theirs" });
  });
});

describe("MergeDiffPane — skill updates (no file metadata)", () => {
  it("still renders a bare heading and the introduction alias", () => {
    const skillSections: SectionDiff[] = [
      { header: "__preamble__", state: "changed", mine: "a", theirs: "b" },
      { header: "Usage", state: "changed", mine: "c", theirs: "d" },
    ];
    render(<MergeDiffPane sections={skillSections} onChange={vi.fn()} />);
    expect(screen.getByText("(Introduction)")).toBeInTheDocument();
    expect(screen.getByText("Usage")).toBeInTheDocument();
  });
});
