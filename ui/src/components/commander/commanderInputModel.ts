import { buildSkillDirective } from "./skillPickerUtils";

/**
 * Model + DOM helpers for the Commander rich (contenteditable) input.
 *
 * The input is an *uncontrolled* contenteditable: the DOM owns the live text
 * while the user types, and React never rewrites `innerHTML` per keystroke
 * (that would fight the caret). These helpers are the bridge between the DOM
 * and the plain-text directive we send to Commander:
 *
 *   - `createSkillToken` builds the atomic, non-editable colored span shown
 *     in place of a skill (e.g. a blue "brainstorming").
 *   - `serializeRoot` walks the contenteditable and expands every skill token
 *     back into its full `use_skill` directive, so the backend still receives
 *     `Use the "brainstorming" skill (skill:.../brainstorming).`
 *   - `isRootEmpty` decides whether to show the placeholder / disable Send.
 *
 * Token kinds are data-attribute driven so future kinds (@mention, file) slot
 * in without touching the walker.
 */

/** `data-token` value identifying a skill chip. */
export const SKILL_TOKEN_KIND = "skill";
export const MENTION_TOKEN_KIND = "mention";

/**
 * Tailwind classes for a skill token. Color comes from the `--token-skill`
 * CSS var (defined per-theme in index.css) so light/dark both read well.
 * `select-none` + `contenteditable=false` (set in createSkillToken) make it
 * behave as one atomic, caret-skipping unit.
 */
export const SKILL_TOKEN_CLASS =
  "inline rounded px-1 py-0.5 mx-px font-medium text-[color:var(--token-skill)] " +
  "bg-[color:var(--token-skill-bg)] select-none";

export interface SkillTokenData {
  name: string;
  key: string;
  /** Optional skill description, stashed on the token for the hover card. */
  description?: string | null;
}

export interface MentionTokenData {
  id: string;
  name: string;
}

export const MENTION_TOKEN_CLASS =
  "inline rounded px-1 py-0.5 mx-px font-medium text-[color:var(--token-mention)] " +
  "bg-[color:var(--token-mention-bg)] select-none";

export function createMentionToken(doc: Document, mention: MentionTokenData): HTMLSpanElement {
  const span = doc.createElement("span");
  span.dataset.token = MENTION_TOKEN_KIND;
  span.dataset.id = mention.id;
  span.dataset.name = mention.name;
  span.setAttribute("contenteditable", "false");
  span.className = MENTION_TOKEN_CLASS;
  span.textContent = `@${mention.name}`;
  return span;
}

export function isMentionToken(node: Node | null | undefined): node is HTMLElement {
  return !!node && node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).dataset?.token === MENTION_TOKEN_KIND;
}

/**
 * Build the atomic skill token span inserted into the contenteditable.
 * Shows only the human name; the exact key + name ride along in data-attrs so
 * `serializeRoot` can rebuild the full directive on send, and the description
 * (when present) powers the hover card.
 */
export function createSkillToken(
  doc: Document,
  skill: SkillTokenData,
): HTMLSpanElement {
  const span = doc.createElement("span");
  span.dataset.token = SKILL_TOKEN_KIND;
  span.dataset.key = skill.key;
  span.dataset.name = skill.name;
  if (skill.description) span.dataset.desc = skill.description;
  span.setAttribute("contenteditable", "false");
  span.className = SKILL_TOKEN_CLASS;
  span.textContent = skill.name;
  return span;
}

/** True when an element is a skill token span. */
export function isSkillToken(node: Node | null | undefined): node is HTMLElement {
  return (
    !!node &&
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).dataset?.token === SKILL_TOKEN_KIND
  );
}

/** Serialize a single DOM node, expanding skill tokens to directives. */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  if (el.dataset?.token === SKILL_TOKEN_KIND) {
    const name = el.dataset.name ?? el.textContent ?? "";
    const key = el.dataset.key ?? "";
    return buildSkillDirective({ name, key });
  }
  if (el.dataset?.token === MENTION_TOKEN_KIND) {
    return `@${el.dataset.name ?? el.textContent?.replace(/^@/, "") ?? ""}`;
  }
  if (el.tagName === "BR") return "\n";

  // Generic wrapper (e.g. a stray <div>/<span> a browser inserted): recurse.
  let out = "";
  el.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

/**
 * Walk a contenteditable root and produce the plain-text directive to send.
 * Skill tokens expand to their full `use_skill` directive; everything else is
 * literal text. NBSP ( ) padding we insert around tokens is normalized
 * back to a regular space so the backend sees clean prose.
 */
export function serializeRoot(root: HTMLElement): string {
  let out = "";
  root.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out.replace(/ /g, " ");
}

/**
 * Empty when there is no token and no non-whitespace text. A lone <br>
 * (which browsers leave behind after clearing) counts as empty.
 */
export function isRootEmpty(root: HTMLElement): boolean {
  if (root.querySelector(`[data-token="${SKILL_TOKEN_KIND}"], [data-token="${MENTION_TOKEN_KIND}"]`)) return false;
  return serializeRoot(root).trim().length === 0;
}
