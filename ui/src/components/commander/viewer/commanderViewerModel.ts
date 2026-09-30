// Pure state logic for the Commander viewer panel.
// No React imports — unit-tested directly (pattern: commanderInputModel.ts).
import { toSafeBrowserUrl } from "@armyofagents/shared";
import type {
  CommanderInputRef,
  CommanderOutputRef,
  ShowRef,
  ShowRefProvenance,
  ViewerControlLevel,
} from "@armyofagents/shared";

export interface ViewerTab {
  /** Stable tab identity: `artifact:<id>:<versionId|latest>` | `reply:<messageId>` | `browser:<url>` | `task:<issueId>` */
  id: string;
  kind:
    | "artifact"
    | "reply"
    | "browser"
    | "task"
    | "discussion"
    | "approval"
    | "inbox"
    | "note"
    | "asset"
    | "output"
    | "memory_item";
  title: string;
  /** artifact id, message id for replies, url for browser tabs, or issue id for task tabs */
  refId: string;
  versionId?: string | null;
  /** reply tabs only — markdown body */
  replyContent?: string;
  /** browser tabs only — the url loaded in the sandboxed iframe */
  url?: string;
  inputRef?: CommanderInputRef;
  /** v2 presentation hints carried from the ref so the body can resolve a viewer. */
  viewerKind?: string;
  mimeType?: string;
}

export interface ConversationViewerState {
  tabs: ViewerTab[];
  /** active tab id, or the literal "home" */
  activeId: string;
  expanded: boolean;
}

export function emptyViewerState(): ConversationViewerState {
  return { tabs: [], activeId: "home", expanded: false };
}

export function chipLabel(ref: ShowRef): string {
  return ref.title ?? `${ref.kind} ${ref.id.slice(0, 8)}`;
}

function artifactTabId(ref: ShowRef): string {
  return `artifact:${ref.id}:${ref.versionId ?? "latest"}`;
}

export function openRefTab(
  state: ConversationViewerState,
  ref: ShowRef,
): ConversationViewerState {
  switch (ref.kind) {
    case "artifact": {
      const id = artifactTabId(ref);
      const existing = state.tabs.find((t) => t.id === id);
      if (existing) return { ...state, activeId: id, expanded: true };
      const tab: ViewerTab = {
        id,
        kind: "artifact",
        title: chipLabel(ref),
        refId: ref.id,
        versionId: ref.versionId ?? null,
      };
      return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
    }
    case "task":
      return openTaskTab(state, ref.id, chipLabel(ref));
    case "discussion":
    case "approval": {
      const id = `${ref.kind}:${ref.id}`;
      if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
      const tab: ViewerTab = { id, kind: ref.kind, title: chipLabel(ref), refId: ref.id };
      return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
    }
    case "url":
      return openBrowserTab(state, ref.id); // openBrowserTab already scheme-gates via toSafeBrowserUrl
    case "asset":
    case "output":
    case "memory_item": {
      // These kinds only exist on v2 refs (v1 is artifact-only), so `ref` narrows
      // to ShowRefV2 here and the presentation hints are safe to read.
      const id = `${ref.kind}:${ref.id}`;
      if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
      const tab: ViewerTab = {
        id,
        kind: ref.kind,
        title: chipLabel(ref),
        refId: ref.id,
        viewerKind: ref.viewerKind ?? undefined,
        mimeType: ref.mimeType ?? undefined,
      };
      return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
    }
    default:
      // Unknown/unsupported kind — never mis-render as artifact.
      return state;
  }
}

export function openReplyTab(
  state: ConversationViewerState,
  messageId: string,
  content: string,
): ConversationViewerState {
  const id = `reply:${messageId}`;
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
  const tab: ViewerTab = { id, kind: "reply", title: "Commander reply", refId: messageId, replyContent: content };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function openTaskTab(
  state: ConversationViewerState,
  issueId: string,
  title: string,
): ConversationViewerState {
  const id = `task:${issueId}`;
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
  const tab: ViewerTab = { id, kind: "task", title, refId: issueId };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function openInputRefTab(
  state: ConversationViewerState,
  ref: CommanderInputRef,
): ConversationViewerState {
  if (ref.kind === "task") {
    return openTaskTab(state, ref.id, ref.label);
  }
  if (ref.kind === "artifact") {
    return openRefTab(state, {
      v: 1,
      kind: "artifact",
      id: ref.id,
      title: ref.label,
      action: "referenced",
    } as CommanderOutputRef);
  }
  if (
    ref.kind !== "discussion" &&
    ref.kind !== "approval" &&
    ref.kind !== "inbox" &&
    ref.kind !== "note"
  ) {
    return state;
  }

  const id = `${ref.kind}:${ref.id}`;
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
  const tab: ViewerTab = {
    id,
    kind: ref.kind,
    title: ref.label,
    refId: ref.id,
    inputRef: ref,
  };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function openBrowserTab(
  state: ConversationViewerState,
  rawUrl: string,
): ConversationViewerState {
  // Scheme-gate before the url ever reaches a tab model / iframe src.
  // BrowserViewer also gates at render — this is defense-in-depth.
  const url = toSafeBrowserUrl(rawUrl) || "about:blank";
  const id = `browser:${url}`;
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
  let title = url;
  try {
    title = new URL(url).hostname || url;
  } catch {
    // Unparseable url — keep the raw string as the title.
  }
  const tab: ViewerTab = { id, kind: "browser", title, refId: url, url };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function closeTab(state: ConversationViewerState, tabId: string): ConversationViewerState {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  let activeId = state.activeId;
  if (activeId === tabId) {
    const neighbor = tabs[idx] ?? tabs[idx - 1];
    activeId = neighbor ? neighbor.id : "home";
  }
  return { ...state, tabs, activeId };
}

export function setActive(state: ConversationViewerState, tabId: string): ConversationViewerState {
  return { ...state, activeId: tabId, expanded: true };
}

export function setExpanded(state: ConversationViewerState, expanded: boolean): ConversationViewerState {
  return { ...state, expanded };
}

/**
 * Auto-open rule (design §2 #2 + #6): created refs, desktop only, gated by the
 * effective viewerControl level. `manual` never auto-opens; `own_output`/`full`
 * open created refs on desktop. The `level` default keeps legacy 2-arg callers
 * (and mobile-badge paths) behaving as before the level gate landed.
 */
export function shouldAutoOpen(
  ref: ShowRef,
  isMobile: boolean,
  level: ViewerControlLevel = "own_output",
): boolean {
  return level !== "manual" && ref.action === "created" && !isMobile;
}

/**
 * One-tab-per-turn arbitration: pick the first ref in a batch that is eligible
 * to auto-open a viewer tab under the given level, or null if none qualify.
 * The panel uses this to cap live-ref bursts at a single opened tab per turn.
 */
export function pickAutoOpenRef(
  refs: ShowRef[],
  level: ViewerControlLevel,
  isMobile: boolean,
): ShowRef | null {
  return refs.find((r) => shouldAutoOpen(r, isMobile, level)) ?? null;
}

// Twin of the server `refKey` in output-refs.ts — dedup identity is the ARTIFACT
// identity `(kind,id,versionId)`, NOT `v`, so a legacy v1 replay + a fresh v2 ref
// for the same artifact coalesce into ONE card instead of a double-card (B5).
const refKey = (r: ShowRef) => `${r.kind}|${r.id}|${r.versionId ?? ""}`;

const firstStr = (a?: string | null, b?: string | null): string | null =>
  a != null && a !== "" ? a : b != null && b !== "" ? b : null;
const firstNum = (a?: number | null, b?: number | null): number | null =>
  a != null ? a : b != null ? b : null;

// Provenance precedence (order-independent): v2 provenance beats v1 (none);
// when both are v2 the newer `emittedAt` wins and a real provenance beats null.
function pickProvenance(a: ShowRef, b: ShowRef): ShowRefProvenance | null {
  const pa = a.v === 2 ? a.provenance ?? null : null;
  const pb = b.v === 2 ? b.provenance ?? null : null;
  if (pa && pb) return pb.emittedAt >= pa.emittedAt ? pb : pa;
  return pa ?? pb ?? null;
}

// FIELD-WISE merge — twin of server mergeRefPair. The strongest action AND the
// richest provenance both survive; never winner-take-all on one whole object.
function mergeRefPair(a: ShowRef, b: ShowRef): ShowRef {
  const action: "created" | "referenced" =
    a.action === "created" || b.action === "created" ? "created" : "referenced";
  const versionId = firstStr(a.versionId, b.versionId);
  const versionNumber = firstNum(a.versionNumber, b.versionNumber);
  const title = firstStr(a.title, b.title);
  const mimeType = firstStr(a.mimeType, b.mimeType);
  if (a.v !== 2 && b.v !== 2) {
    return {
      v: 1,
      kind: "artifact",
      id: a.id,
      versionId,
      versionNumber,
      title,
      action,
      toolCallId: null,
      mimeType,
    };
  }
  return {
    v: 2,
    kind: a.kind,
    id: a.id,
    versionId,
    versionNumber,
    title,
    mimeType,
    viewerKind: firstStr(
      a.v === 2 ? a.viewerKind : null,
      b.v === 2 ? b.viewerKind : null,
    ),
    action,
    toolCallId: firstStr(a.v === 2 ? a.toolCallId : null, b.v === 2 ? b.toolCallId : null),
    provenance: pickProvenance(a, b),
  };
}

/**
 * Merge two lists of refs, deduplicating by `kind|id|versionId`. On collision
 * the refs are merged FIELD-WISE (created action + richest v2 provenance both
 * survive) — the per-collision result is identical to the server
 * `mergeOutputRefs` twin. NOTE: this twin intentionally OMITS the server's
 * 20-ref cap: the UI aggregates refs across messages for the Home "Recent"
 * view (`collectConversationRefs`), which is deliberately unbounded. A single
 * message emitting >20 distinct refs flashes all chips live, then settles to
 * the server's 20 (created-first) after persist/reload — cosmetic, not a
 * card-content mismatch.
 */
export function mergeRefs(
  existing: ShowRef[],
  incoming: ShowRef[],
): ShowRef[] {
  const map = new Map<string, ShowRef>();
  for (const r of [...existing, ...incoming]) {
    const k = refKey(r);
    const prev = map.get(k);
    map.set(k, prev ? mergeRefPair(prev, r) : r);
  }
  return [...map.values()];
}

/** Home-tab "Recent from this conversation": dedupe across loaded messages, created wins. */
export function collectConversationRefs(
  messages: ReadonlyArray<{ outputRefs?: ShowRef[] | null }>,
): ShowRef[] {
  return mergeRefs(
    [],
    messages.flatMap((m) => m.outputRefs ?? []),
  );
}
