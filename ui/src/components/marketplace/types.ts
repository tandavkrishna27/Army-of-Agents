/**
 * Shared types for marketplace UI components.
 */

export interface SectionDiff {
  header: string;
  state: "unchanged" | "changed" | "added" | "removed";
  mine: string;
  theirs: string;
  /**
   * Agent updates only (T2.7). An agent's instructions are a *bundle*, so a
   * reviewable section is `<file>::<## heading>` and `header` carries the
   * composite decision key. `file`/`section` are the two halves, split
   * server-side so the UI never has to parse the key.
   *
   * Skill updates leave all three undefined: `header` is the raw heading and
   * there is only one document.
   */
  file?: string;
  section?: string;
  /** True for `adapterConfig`-backed pseudo-files that have no bytes on disk. */
  virtual?: boolean;
}
