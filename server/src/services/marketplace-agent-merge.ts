/**
 * @fileoverview Section-level diff/merge algebra for AGENT instruction bundles (T2.7).
 *
 * Pure functions over `Record<filePath, content>` maps — no I/O, no DB, no fs.
 * The I/O half lives in `marketplace-install/agent-update-merge.ts`.
 *
 * ── What a "section" is for an agent ────────────────────────────────────────
 *
 * A section is **`<file>::<h2 heading>`** — the skill differ's `## ` section,
 * namespaced by the file it came from. Two levels, because an agent's
 * instructions are a *bundle*, not one document:
 *
 * - `agent.v1` templates declare `instructions` as `inline` (one file),
 *   `file` (one file — what all 9 published `aoa-curated` crew agents use), or
 *   `bundle` (an entry file plus N siblings). A file-only granularity would
 *   force an all-or-nothing choice on a 400-line AGENTS.md; a hunk granularity
 *   has no stable identity across a rewrite, so a founder could not reason
 *   about which of their edits a decision covers. A heading is the unit the
 *   author already wrote, it survives edits on both sides, and it is the unit
 *   the skill merge UI has shipped with.
 * - The file prefix is what keeps two files that both have a `## Tone` heading
 *   from collapsing into one decision. It also gives whole-file adds and
 *   removes an honest representation (see {@link computeAgentSectionDiff}).
 *
 * Section keys are the wire contract for `POST /updates/:id/merge`'s
 * `decisions` map, so they must be stable for a given (mine, theirs) pair.
 * Duplicate headings inside one file are disambiguated by the skill differ's
 * existing `deduplicateHeaders` (` [2]`, ` [3]`, …).
 *
 * ── promptTemplate / bootstrapPromptTemplate ────────────────────────────────
 *
 * These two live in `agents.adapterConfig`, not on disk, and a catalog update
 * **deletes** them (`materializeManagedBundle(..., { clearLegacyPromptTemplate:
 * true })` → `applyBundleConfig` unsets both). They are founder-editable in the
 * shipped Config tab and are read at runtime, so silently dropping them in a
 * merge is exactly the harm D22 exists to prevent — but silently *keeping*
 * them would be wrong too, because then no merge could ever honestly report
 * that the agent now holds pure catalog content.
 *
 * So they are represented as **virtual files** — `promptTemplate.legacy.md` and
 * `bootstrapPromptTemplate.legacy.md`. `promptTemplate.legacy.md` is not a name
 * invented here: `agent-instructions.ts` already surfaces `promptTemplate`
 * under exactly that path as a `virtual: true, deprecated: true` bundle entry,
 * and its `readFile`/`writeFile` already round-trip it. Upstream never carries
 * either, so they appear as `removed` sections whose default decision is
 * "mine" — the founder keeps them unless they say otherwise, and choosing
 * "accept upstream" is the explicit, visible way to let the catalog delete
 * them.
 */
import { computeSectionDiff, splitSections, deduplicateHeaders, applyMergeDecisions } from "./marketplace-merge.js";
import type { SectionDiff } from "./marketplace-merge.js";

/** Separator between the file path and the section heading in a decision key. */
export const AGENT_SECTION_KEY_SEPARATOR = "::";

/** Virtual bundle path for `adapterConfig.promptTemplate`. */
export const LEGACY_PROMPT_TEMPLATE_FILE = "promptTemplate.legacy.md";
/** Virtual bundle path for `adapterConfig.bootstrapPromptTemplate`. */
export const LEGACY_BOOTSTRAP_PROMPT_TEMPLATE_FILE = "bootstrapPromptTemplate.legacy.md";

/**
 * Virtual file path → the `adapterConfig` key it stands for.
 *
 * Kept in sync with the pair `applyBundleConfig` deletes when
 * `clearLegacyPromptTemplate` is set. If that destruction set grows, this map
 * grows with it — otherwise a merge would start silently discarding a field.
 */
export const LEGACY_PROMPT_VIRTUAL_FILES: Readonly<Record<string, "promptTemplate" | "bootstrapPromptTemplate">> = {
  [LEGACY_PROMPT_TEMPLATE_FILE]: "promptTemplate",
  [LEGACY_BOOTSTRAP_PROMPT_TEMPLATE_FILE]: "bootstrapPromptTemplate",
};

/**
 * Is this path a legacy-prompt pseudo-file *by name*?
 *
 * Name alone is not sufficient at the I/O boundary: a founder may have a REAL
 * file called `promptTemplate.legacy.md` sitting in their bundle root, and
 * routing that to `adapterConfig` would delete it from disk. Callers that write
 * pass the per-agent `virtualPaths` set computed by
 * `readAgentInstructionSnapshot`, where disk wins. This predicate is the
 * default for callers that have no such set (the pure-function tests).
 */
export function isLegacyPromptVirtualFile(filePath: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_PROMPT_VIRTUAL_FILES, filePath);
}

/** One reviewable section of an agent instruction bundle. */
export interface AgentSectionDiff extends SectionDiff {
  /** Decision key: `${file}${AGENT_SECTION_KEY_SEPARATOR}${section}`. */
  header: string;
  /** Bundle-relative file path (or a legacy virtual path). */
  file: string;
  /** The heading within that file, or `__preamble__` for content above the first `## `. */
  section: string;
  /** True for `adapterConfig`-backed pseudo-files, which have no bytes on disk. */
  virtual: boolean;
}

export function agentSectionKey(file: string, section: string): string {
  return `${file}${AGENT_SECTION_KEY_SEPARATOR}${section}`;
}

/** The decision that applies when the founder expressed none for a section. */
export function defaultDecisionFor(state: SectionDiff["state"]): "mine" | "theirs" {
  // Mirrors `applyMergeDecisions`: new upstream material is taken, everything
  // the founder already has is kept. Safe-by-default in the direction that
  // cannot lose their work.
  return state === "added" ? "theirs" : "mine";
}

function toAgentSections(file: string, sections: SectionDiff[], virtual: boolean): AgentSectionDiff[] {
  return sections.map((section) => ({
    ...section,
    header: agentSectionKey(file, section.header),
    file,
    section: section.header,
    virtual,
  }));
}

/**
 * Section-level diff across a whole instruction bundle.
 *
 * Files are walked in a stable order: every file present locally, in sorted
 * order, then upstream-only files in sorted order. Within a file the skill
 * differ's ordering rules apply unchanged (mine order for retained/removed
 * sections, added sections interleaved at their upstream anchor).
 *
 * **Whole-file adds and removes are forced, not inferred.** Running
 * `computeSectionDiff("", upstream)` would label a brand-new file's preamble
 * `changed` (empty → content) rather than `added`, which reads to a founder as
 * "something of mine was modified". A file that exists on only one side is
 * therefore mapped straight to `added` / `removed` sections.
 */
export function computeAgentSectionDiff(
  mine: Record<string, string>,
  theirs: Record<string, string>,
  virtualPaths?: ReadonlySet<string>,
): AgentSectionDiff[] {
  const isVirtual = (file: string) =>
    virtualPaths ? virtualPaths.has(file) : isLegacyPromptVirtualFile(file);
  const mineFiles = Object.keys(mine).sort((a, b) => a.localeCompare(b));
  const upstreamOnlyFiles = Object.keys(theirs)
    .filter((file) => !(file in mine))
    .sort((a, b) => a.localeCompare(b));

  const out: AgentSectionDiff[] = [];

  for (const file of mineFiles) {
    const virtual = isVirtual(file);
    if (!(file in theirs)) {
      const sections = deduplicateHeaders(splitSections(mine[file]!)).map<SectionDiff>((s) => ({
        header: s.header,
        state: "removed",
        mine: s.content,
        theirs: "",
      }));
      out.push(...toAgentSections(file, sections, virtual));
      continue;
    }
    out.push(...toAgentSections(file, computeSectionDiff(mine[file]!, theirs[file]!), virtual));
  }

  for (const file of upstreamOnlyFiles) {
    const sections = deduplicateHeaders(splitSections(theirs[file]!)).map<SectionDiff>((s) => ({
      header: s.header,
      state: "added",
      mine: "",
      theirs: s.content,
    }));
    out.push(...toAgentSections(file, sections, isVirtual(file)));
  }

  return out;
}

/**
 * Is the local bundle byte-identical to upstream?
 *
 * **Deliberately NOT derived from section states.** `computeSectionDiff`
 * classifies a section `unchanged` on `.trim()` equality, so a bundle that
 * differs from upstream only by trailing whitespace produces an all-`unchanged`
 * diff — while the wholesale-upstream relaxation in
 * {@link applyAgentMergeDecisions} requires BYTE equality. Reading "identical"
 * off the states therefore told the founder "no local changes found" about a
 * bundle that would then merge to `instructions_customized = true`.
 */
export function bundlesAreByteIdentical(
  mine: Record<string, string>,
  upstream: Record<string, string>,
): boolean {
  const mineKeys = Object.keys(mine);
  const upstreamKeys = Object.keys(upstream);
  if (mineKeys.length !== upstreamKeys.length) return false;
  return mineKeys.every((file) => file in upstream && mine[file] === upstream[file]);
}

export interface AgentMergeResult {
  /** Bundle-relative path → merged content, for every file that survives. */
  files: Record<string, string>;
  /** Files that existed locally and do not survive the merge. */
  deletedFiles: string[];
  /**
   * True when the merged bundle is **byte-identical to upstream**: same file
   * set, same bytes. See {@link applyAgentMergeDecisions} for why this is
   * computed from the resulting bytes rather than from the founder's clicks.
   */
  pureUpstream: boolean;
}

/**
 * Turn per-section decisions into the file set to write.
 *
 * ── Why the wholesale cases are copied verbatim instead of reassembled ──────
 *
 * `applyMergeDecisions` REASSEMBLES a document: it joins the surviving sections
 * with `\n\n` and trims. That is fine for a mixed merge — the founder is
 * knowingly splicing two documents — but it is NOT byte-preserving, and both
 * ends of the range need to be.
 *
 * - **All-upstream.** If a merge in which the founder accepted *everything*
 *   still produced non-upstream bytes, {@link AgentMergeResult.pureUpstream}
 *   could never honestly be true, and the `instructions_customized = NULL`
 *   backlog (T2.6) — every crew agent installed before migration `0182`, most
 *   of which were never edited at all — could never drain. So a file whose
 *   every section resolves to upstream is written from `upstream` verbatim.
 * - **All-mine.** A founder who keeps everything must get their file back
 *   unchanged, down to the byte: reassembly would rewrite their blank lines.
 *   This is what makes "keep mine" mean *keep*, and it is what the legacy
 *   `promptTemplate` virtual file depends on (it is one unstructured blob, so
 *   reassembly would append a trailing newline to the founder's config value).
 *
 * A section whose state is `unchanged` **and whose two sides are byte-equal**
 * counts as satisfying "all upstream" whatever the founder clicked, because
 * taking either side writes the same bytes. Trim-equal-but-not-byte-equal
 * sections deliberately do NOT get that relaxation: they fall to reassembly,
 * where "mine" keeps the founder's whitespace.
 *
 * `pureUpstream` is then a pure BYTE test over the result — never "did they
 * click accept on everything". The caller may only re-enter an agent into the
 * auto-update path when it holds exactly what a fresh install would have
 * produced.
 *
 * Both sides are passed in as whole-file maps rather than reconstructed from
 * the sections. Rejoining looks exact and is not: `splitSections` always emits
 * a `__preamble__` section, and for a document that opens on a heading that
 * section holds ZERO lines while its content string is `""` — indistinguishable
 * from a section holding one blank line. Rejoining therefore prepends a newline
 * to every heading-first file, which is precisely the byte the "keep mine"
 * guarantee is about.
 */
export function applyAgentMergeDecisions(
  diff: AgentSectionDiff[],
  decisions: Record<string, "mine" | "theirs">,
  sides: { mine: Record<string, string>; upstream: Record<string, string> },
): AgentMergeResult {
  const { mine, upstream } = sides;
  const byFile = new Map<string, AgentSectionDiff[]>();
  for (const section of diff) {
    const bucket = byFile.get(section.file);
    if (bucket) bucket.push(section);
    else byFile.set(section.file, [section]);
  }

  const files: Record<string, string> = {};
  const deletedFiles: string[] = [];
  let pureUpstream = true;

  for (const [file, sections] of byFile) {
    const effective = sections.map(
      (section) => decisions[section.header] ?? defaultDecisionFor(section.state),
    );
    const allTheirs = sections.every(
      (section, i) =>
        effective[i] === "theirs"
        || (section.state === "unchanged" && section.mine === section.theirs),
    );
    const allMine = effective.every((decision) => decision === "mine");

    // A file the founder does not have and declined WHOLESALE is simply not
    // created. Without this branch it falls to `applyMergeDecisions`, which
    // drops every `added`/"mine" section, joins nothing, and returns `"\n"` —
    // so declining a new upstream file materialised a one-newline phantom on
    // disk that then showed as the founder's own content in every later diff.
    // Directly reachable from the `Keep all mine` bulk control.
    //
    // It belongs in NEITHER map: there is nothing on disk to delete. `continue`
    // leaves it missing from `files`, so `survivingUpstreamParity` fails it and
    // `pureUpstream` still comes out false — the same verdict, no artifact.
    if (allMine && !(file in mine)) continue;

    let content: string | null;
    if (allTheirs) {
      // Local-only file, wholly given away → it goes. Dropping a file upstream
      // does not have IS an upstream state, so this does not disqualify the
      // bundle from being pure upstream.
      content = file in upstream ? upstream[file]! : null;
    } else if (allMine && file in mine) {
      content = mine[file]!;
    } else {
      // Mixed decisions use the shared fence-aware, dominant-EOL-preserving
      // reassembly path. Wholesale decisions still bypass it above so their
      // original file bytes remain exact.
      content = applyMergeDecisions(sections, decisions);
    }

    if (content === null) deletedFiles.push(file);
    else files[file] = content;

    const matchesUpstream =
      content === null ? !(file in upstream) : file in upstream && upstream[file] === content;
    if (!matchesUpstream) pureUpstream = false;
  }

  // Reachable, and load-bearing: the declined-upstream-only branch above
  // `continue`s without touching `pureUpstream`, so this is what registers that
  // an upstream file the founder refused is missing from the result.
  const survivingUpstreamParity = Object.keys(upstream).every((file) => file in files);

  return { files, deletedFiles, pureUpstream: pureUpstream && survivingUpstreamParity };
}
