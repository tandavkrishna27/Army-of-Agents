import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  COMMANDER_INPUT_REF_DRAG_MIME,
  parseCommanderInputRefDragPayload,
  type CommanderInputRef,
} from "@armyofagents/shared";
import { cn } from "../../lib/utils";
import { matchSlashToken } from "./skillPickerUtils";
import {
  createSkillToken,
  createMentionToken,
  isRootEmpty,
  isMentionToken,
  isSkillToken,
  serializeRoot,
  type SkillTokenData,
  type MentionTokenData,
} from "./commanderInputModel";

export interface CommanderInputHandle {
  /** Move keyboard focus into the editor. */
  focus: () => void;
  /** Empty the editor (used after send). */
  clear: () => void;
  /** Current expanded directive text (skill tokens → full `use_skill` lines), trimmed. */
  getText: () => string;
  /**
   * Insert a skill token at the caret. `viaSlash` replaces the in-progress
   * `/query` token; otherwise the token is inserted inline (with a leading
   * space when needed).
   */
  insertSkill: (skill: SkillTokenData, viaSlash: boolean) => void;
  /** Insert plain prompt text at the caret, preserving the rich editor model. */
  insertText: (text: string) => void;
}

export interface SlashState {
  active: boolean;
  query: string;
}

interface CommanderInputProps {
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Send the message. Receives the expanded directive text (already trimmed, non-empty). */
  onSubmit: (text: string) => void;
  /** Fires when the empty/non-empty state flips (drives the Send button + placeholder). */
  onEmptyChange: (empty: boolean) => void;
  /** Fires when the slash-command context at the caret changes. */
  onSlashChange: (slash: SlashState) => void;
  /**
   * Parent gets first crack at keydown (picker ↑/↓/Enter/Esc nav). If the
   * parent calls `preventDefault`, the editor skips its own Enter/Backspace
   * handling for that event.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Mirrors the old textarea onBlur (parent closes the picker on focus leaving the bar). */
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
  /** Accepts identity-preserving refs dropped from Commander Cockpit cards. */
  onReferenceDrop?: (payload: { ref: CommanderInputRef; prompt?: string }) => void;
  /** Sends files from clipboard paste or OS drag/drop to the parent uploader. */
  onFilesSelected?: (files: File[]) => void;
  mentionOptions?: MentionTokenData[];
  onTextChange?: (text: string) => void;
}

const EMPTY_SLASH: SlashState = { active: false, query: "" };

/**
 * Commander's rich message input. A single contenteditable that renders skill
 * selections as atomic colored tokens (just the name) while still sending the
 * full `use_skill` directive. See commanderInputModel.ts for the DOM↔text
 * bridge. Keyboard nav for the skill picker stays parent-owned (via onKeyDown).
 */
export const CommanderInput = forwardRef<CommanderInputHandle, CommanderInputProps>(
  function CommanderInput(
    { disabled, placeholder, className, onSubmit, onEmptyChange, onSlashChange, onKeyDown, onBlur, onReferenceDrop, onFilesSelected, mentionOptions = [], onTextChange },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);

    // Placeholder visibility is React-driven (not an imperative classList
    // toggle) so it survives re-renders — React owns the element's className and
    // would otherwise clobber an imperatively-added class on the next render.
    const [isEmpty, setIsEmpty] = useState(true);
    const [dragActive, setDragActive] = useState(false);
    const [mentionState, setMentionState] = useState({ active: false, query: "" });
    const [mentionIndex, setMentionIndex] = useState(0);

    // Hover card for skill tokens (shows name + description + key on hover).
    const [hoverCard, setHoverCard] = useState<{
      name: string;
      key: string;
      desc: string;
      left: number;
      top: number;
    } | null>(null);

    // Keep latest props in refs so the imperative handle + DOM handlers stay
    // stable (never go stale, never thrash the ref identity).
    const onSubmitRef = useRef(onSubmit);
    const onEmptyChangeRef = useRef(onEmptyChange);
    const onSlashChangeRef = useRef(onSlashChange);
    const disabledRef = useRef(!!disabled);
    onSubmitRef.current = onSubmit;
    onEmptyChangeRef.current = onEmptyChange;
    onSlashChangeRef.current = onSlashChange;
    useEffect(() => {
      disabledRef.current = !!disabled;
    }, [disabled]);

    // Dedup so we don't spam the parent with identical empty/slash updates.
    const lastEmptyRef = useRef(true);
    const lastSlashRef = useRef<SlashState>(EMPTY_SLASH);

    const emitEmpty = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      const empty = isRootEmpty(root);
      setIsEmpty(empty);
      if (empty !== lastEmptyRef.current) {
        lastEmptyRef.current = empty;
        onEmptyChangeRef.current(empty);
      }
    }, []);

    const emitSlash = useCallback((slash: SlashState) => {
      if (
        slash.active === lastSlashRef.current.active &&
        slash.query === lastSlashRef.current.query
      ) {
        return;
      }
      lastSlashRef.current = slash;
      onSlashChangeRef.current(slash);
    }, []);

    // Read the slash-command context (if any) from the collapsed caret.
    const readSlash = useCallback((): SlashState => {
      const root = rootRef.current;
      if (!root) return EMPTY_SLASH;
      const sel = root.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return EMPTY_SLASH;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return EMPTY_SLASH;
      const text = (node.textContent ?? "").slice(0, range.startOffset);
      const m = matchSlashToken(text);
      return { active: m.active, query: m.query };
    }, []);

    const readMention = useCallback(() => {
      const root = rootRef.current;
      if (!root) return { active: false, query: "" };
      const sel = root.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return { active: false, query: "" };
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return { active: false, query: "" };
      const text = (node.textContent ?? "").slice(0, range.startOffset);
      const match = /(^|\s)@([\w-]*)$/.exec(text);
      return match ? { active: true, query: match[2] } : { active: false, query: "" };
    }, []);

    const insertTextAtCaret = useCallback((text: string) => {
      const root = rootRef.current;
      if (!root) return;
      const sel = root.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tn = root.ownerDocument.createTextNode(text);
      range.insertNode(tn);
      range.setStartAfter(tn);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }, []);

    const insertPlainText = useCallback(
      (text: string) => {
        const root = rootRef.current;
        if (!root || !text) return;
        const doc = root.ownerDocument;
        root.focus();
        const sel = doc.getSelection();
        if (!sel) return;

        let range: Range;
        if (sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer)) {
          range = sel.getRangeAt(0);
        } else {
          range = doc.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
        }
        range.deleteContents();

        if (needsLeadingSpace(range)) {
          const lead = doc.createTextNode(" ");
          range.insertNode(lead);
          range.setStartAfter(lead);
          range.collapse(true);
        }

        const tn = doc.createTextNode(text);
        range.insertNode(tn);
        range.setStartAfter(tn);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);

        emitEmpty();
        emitSlash(readSlash());
      },
      [emitEmpty, emitSlash, readSlash],
    );

    const clear = useCallback(() => {
      const root = rootRef.current;
      if (!root) return;
      root.innerHTML = "";
      emitEmpty();
      emitSlash(EMPTY_SLASH);
      onTextChange?.("");
    }, [emitEmpty, emitSlash, onTextChange]);

    const getText = useCallback(
      () => (rootRef.current ? serializeRoot(rootRef.current).trim() : ""),
      [],
    );

    const submit = useCallback(() => {
      const root = rootRef.current;
      if (!root || disabledRef.current) return;
      const text = serializeRoot(root).trim();
      if (!text) return;
      onSubmitRef.current(text);
    }, [clear]);

    const insertSkill = useCallback(
      (skill: SkillTokenData, viaSlash: boolean) => {
        const root = rootRef.current;
        if (!root) return;
        const doc = root.ownerDocument;
        root.focus();
        const sel = doc.getSelection();
        if (!sel) return;

        // Resolve a range inside the editor, falling back to the end.
        let range: Range;
        if (sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer)) {
          range = sel.getRangeAt(0);
        } else {
          range = doc.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
        }
        range.deleteContents();

        if (viaSlash) {
          // Replace the `/query` token in the current text node.
          const node = range.startContainer;
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? "";
            const m = matchSlashToken(text.slice(0, range.startOffset));
            if (m.active) {
              const del = doc.createRange();
              del.setStart(node, m.start);
              del.setEnd(node, range.startOffset);
              del.deleteContents();
              range = del;
            }
          }
        } else if (needsLeadingSpace(range)) {
          const lead = doc.createTextNode(" ");
          range.insertNode(lead);
          range.setStartAfter(lead);
          range.collapse(true);
        }

        const token = createSkillToken(doc, skill);
        range.insertNode(token);
        // Trailing NBSP keeps a stable caret target after the atomic token.
        const trail = doc.createTextNode(" ");
        range.setStartAfter(token);
        range.collapse(true);
        range.insertNode(trail);

        const after = doc.createRange();
        after.setStartAfter(trail);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        emitEmpty();
        emitSlash(EMPTY_SLASH);
      },
      [emitEmpty, emitSlash],
    );

    const insertMention = useCallback((mention: MentionTokenData) => {
      const root = rootRef.current;
      if (!root) return;
      const doc = root.ownerDocument;
      const sel = doc.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      let range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const match = /(^|\s)@[\w-]*$/.exec(text.slice(0, range.startOffset));
        if (match) {
          const replacement = doc.createRange();
          replacement.setStart(node, range.startOffset - match[0].length + (match[1] ? 1 : 0));
          replacement.setEnd(node, range.startOffset);
          replacement.deleteContents();
          range = replacement;
        }
      }
      range.deleteContents();
      if (needsLeadingSpace(range)) {
        const lead = doc.createTextNode(" ");
        range.insertNode(lead);
        range.setStartAfter(lead);
      }
      const token = createMentionToken(doc, mention);
      range.insertNode(token);
      const trail = doc.createTextNode("\u00a0");
      range.setStartAfter(token);
      range.insertNode(trail);
      const after = doc.createRange();
      after.setStartAfter(trail);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      setMentionState({ active: false, query: "" });
      setMentionIndex(0);
      emitEmpty();
    }, [emitEmpty]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => rootRef.current?.focus(),
        clear,
        getText,
        insertSkill,
        insertText: insertPlainText,
      }),
      [clear, getText, insertSkill, insertPlainText],
    );

    // Initialise placeholder state on mount.
    useEffect(() => {
      emitEmpty();
    }, [emitEmpty]);

    const handleInput = useCallback(() => {
      emitEmpty();
      emitSlash(readSlash());
      const next = readMention();
      setMentionState(next);
      if (!next.active) setMentionIndex(0);
      onTextChange?.(rootRef.current ? serializeRoot(rootRef.current) : "");
    }, [emitEmpty, emitSlash, onTextChange, readMention, readSlash]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;

        const filteredMentions = mentionOptions
          .filter((option) => option.name.toLowerCase().includes(mentionState.query.toLowerCase()))
          .slice(0, 8);
        if (mentionState.active && filteredMentions.length > 0) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setMentionIndex((current) => (current + (e.key === "ArrowDown" ? 1 : -1) + filteredMentions.length) % filteredMentions.length);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setMentionState({ active: false, query: "" });
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insertMention(filteredMentions[mentionIndex] ?? filteredMentions[0]);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
          return;
        }
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          insertTextAtCaret("\n");
          emitEmpty();
          return;
        }
        if (e.key === "Backspace") {
          const root = rootRef.current;
          if (!root) return;
          const sel = root.ownerDocument.getSelection();
          if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
          const range = sel.getRangeAt(0);
          const node = range.startContainer;
          let token: HTMLElement | null = null;
          if (node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
            if (isSkillToken(node.previousSibling) || isMentionToken(node.previousSibling)) token = node.previousSibling;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const before = node.childNodes[range.startOffset - 1];
            if (isSkillToken(before) || isMentionToken(before)) token = before;
          }
          if (token) {
            e.preventDefault();
            token.remove();
            emitEmpty();
            emitSlash(readSlash());
          }
        }
      },
      [onKeyDown, submit, insertTextAtCaret, emitEmpty, emitSlash, readSlash, insertMention, mentionIndex, mentionOptions, mentionState],
    );

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length > 0 && onFilesSelected) {
          onFilesSelected(files);
          return;
        }
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (text) insertTextAtCaret(text);
        emitEmpty();
        emitSlash(readSlash());
      },
      [insertTextAtCaret, emitEmpty, emitSlash, readSlash, onFilesSelected],
    );

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      if (disabledRef.current) return;
      const types = Array.from(e.dataTransfer.types);
      const hasReference = Boolean(onReferenceDrop) && types.includes(COMMANDER_INPUT_REF_DRAG_MIME);
      const hasFiles = Boolean(onFilesSelected) && types.includes("Files");
      if (!hasReference && !hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    }, [onFilesSelected, onReferenceDrop]);

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragActive(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      if (disabledRef.current) return;
      if (onReferenceDrop) {
        const payload = parseCommanderInputRefDragPayload(
          e.dataTransfer.getData(COMMANDER_INPUT_REF_DRAG_MIME),
        );
        if (payload) {
          e.preventDefault();
          setDragActive(false);
          onReferenceDrop(payload);
          return;
        }
      }
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0 || !onFilesSelected) return;
      e.preventDefault();
      setDragActive(false);
      onFilesSelected(files);
    }, [onFilesSelected, onReferenceDrop]);

    // Caret moves (click / arrows) can change slash context without an input event.
    const handleSelectionShift = useCallback(() => {
      emitSlash(readSlash());
    }, [emitSlash, readSlash]);

    // Show the hover card when the pointer is over a skill token.
    const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const token = (e.target as HTMLElement)?.closest?.(
        '[data-token="skill"]',
      ) as HTMLElement | null;
      if (!token || !root?.contains(token)) return;
      const r = token.getBoundingClientRect();
      setHoverCard({
        name: token.dataset.name ?? token.textContent ?? "",
        key: token.dataset.key ?? "",
        desc: token.dataset.desc ?? "",
        left: r.left,
        top: r.top,
      });
    }, []);

    const handleMouseOut = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const fromToken = (e.target as HTMLElement)?.closest?.('[data-token="skill"]');
      const toToken = (e.relatedTarget as HTMLElement | null)?.closest?.(
        '[data-token="skill"]',
      );
      if (fromToken && fromToken !== toToken) setHoverCard(null);
    }, []);

    return (
      <>
        {mentionState.active && mentionOptions.length > 0 && (
          <div className="absolute bottom-full left-0 z-40 mb-1 min-w-48 max-w-xs rounded-md border border-border bg-popover p-1 shadow-lg" role="listbox" aria-label="Mention suggestions">
            {mentionOptions
              .filter((option) => option.name.toLowerCase().includes(mentionState.query.toLowerCase()))
              .slice(0, 8)
              .map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  className={cn("flex w-full items-center rounded px-2 py-1.5 text-left text-xs", index === mentionIndex && "bg-accent")}
                  onMouseDown={(event) => { event.preventDefault(); insertMention(option); }}
                >
                  @{option.name}
                </button>
              ))}
          </div>
        )}
        <div
          ref={rootRef}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder ?? "Message Commander"}
          data-placeholder={placeholder ?? ""}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleSelectionShift}
          onMouseUp={handleSelectionShift}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onBlur={onBlur}
          className={cn(
            "commander-input w-full bg-transparent px-3 py-2 text-sm leading-5",
            "min-h-[36px] max-h-[140px]",
            isEmpty && "is-empty",
            dragActive && "bg-brand/5 ring-2 ring-brand-focus-ring",
            disabled && "opacity-50 cursor-not-allowed",
            className,
          )}
        />
        {hoverCard && (
          <div
            // Fixed to the token's viewport rect, floating just above it. Pointer
            // events off so it never steals the hover from the token underneath.
            className="fixed z-50 max-w-xs rounded-lg border border-border bg-popover p-2.5 shadow-lg pointer-events-none"
            style={{
              left: hoverCard.left,
              top: hoverCard.top - 8,
              transform: "translateY(-100%)",
            }}
            role="tooltip"
          >
            <div className="text-sm font-medium text-foreground">{hoverCard.name}</div>
            {hoverCard.desc && (
              <div className="mt-0.5 text-xs text-muted-foreground">{hoverCard.desc}</div>
            )}
            {hoverCard.key && (
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/60 break-all">
                {hoverCard.key}
              </div>
            )}
          </div>
        )}
      </>
    );
  },
);

/**
 * Whether inserting at this collapsed range needs a leading space so a token
 * doesn't butt up against preceding non-space text or another token.
 */
function needsLeadingSpace(range: Range): boolean {
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    if (range.startOffset > 0) {
      const ch = (node.textContent ?? "")[range.startOffset - 1];
      return !!ch && !/\s/.test(ch);
    }
    return precededByContent(node.previousSibling);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return precededByContent(node.childNodes[range.startOffset - 1] ?? null);
  }
  return false;
}

function precededByContent(prev: Node | null): boolean {
  if (!prev) return false;
  if (isSkillToken(prev)) return true;
  if (prev.nodeType === Node.TEXT_NODE) {
    const text = prev.textContent ?? "";
    return text.length > 0 && !/\s$/.test(text);
  }
  return false;
}
