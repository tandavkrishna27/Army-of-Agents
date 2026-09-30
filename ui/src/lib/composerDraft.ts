import { useCallback, useEffect, useState } from "react";

/** The on-disk format is deliberately versioned so a UI rollout can invalidate old drafts safely. */
export const COMPOSER_DRAFT_VERSION = 1;
export const COMPOSER_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = "aoa:composer-draft:v1:";

export type ComposerSurface = "commander" | "discussion" | "task" | (string & {});

export interface ComposerDraftKey {
  companyId: string;
  userId: string;
  surface: ComposerSurface;
  /** The conversation, discussion, task, or other host entity being composed in. */
  entityId: string;
  /** Null distinguishes a root message from a reply draft. */
  replyTargetId?: string | null;
}

export interface ComposerDraftToken {
  type: "mention" | "command" | (string & {});
  id: string;
  label?: string;
  value?: string;
}

/**
 * A persisted attachment is only an uploaded-file reference. File/Blob objects,
 * data URLs, and other byte-bearing values must never be placed in this shape.
 */
export interface ComposerDraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  artifactId?: string;
  contentPath?: string;
}

export interface ComposerDraftValue {
  text: string;
  tokens: ComposerDraftToken[];
  attachments: ComposerDraftAttachment[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraftValue = {
  text: "",
  tokens: [],
  attachments: [],
};

interface StoredComposerDraft {
  version: number;
  savedAt: number;
  expiresAt: number;
  draft: ComposerDraftValue;
}

export interface ComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ComposerDraftOptions {
  /** Injected in tests or hosts that provide a scoped storage implementation. */
  storage?: ComposerDraftStorage | null;
  now?: () => number;
  ttlMs?: number;
}

export type ComposerDraftUpdater =
  | Partial<ComposerDraftValue>
  | ComposerDraftValue
  | ((previous: ComposerDraftValue) => ComposerDraftValue);

function defaultStorage(): ComposerDraftStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    // Access can throw in private browsing, sandboxed iframes, or when storage is disabled.
    const probe = "__aoa_composer_draft_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Build a collision-resistant key without leaking raw IDs into a storage inspector. */
export function composerDraftStorageKey(key: ComposerDraftKey): string {
  const reply = key.replyTargetId ?? "root";
  return `${STORAGE_PREFIX}${[
    key.companyId,
    key.userId,
    key.surface,
    key.entityId,
    reply,
  ].map(safeSegment).join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeDraft(value: unknown): ComposerDraftValue | null {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.tokens) || !Array.isArray(value.attachments)) {
    return null;
  }
  const tokens = value.tokens.flatMap((token): ComposerDraftToken[] => {
    if (!isRecord(token) || typeof token.type !== "string" || typeof token.id !== "string") return [];
    return [{
      type: token.type,
      id: token.id,
      ...(typeof token.label === "string" ? { label: token.label } : {}),
      ...(typeof token.value === "string" ? { value: token.value } : {}),
    }];
  });
  const attachments = value.attachments.flatMap((attachment): ComposerDraftAttachment[] => {
    if (!isRecord(attachment) || typeof attachment.id !== "string" || typeof attachment.name !== "string" || typeof attachment.mimeType !== "string") return [];
    return [{
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(typeof attachment.artifactId === "string" ? { artifactId: attachment.artifactId } : {}),
      ...(typeof attachment.contentPath === "string" ? { contentPath: attachment.contentPath } : {}),
    }];
  });
  return { text: value.text, tokens, attachments };
}

export function isComposerDraftEmpty(draft: ComposerDraftValue): boolean {
  return draft.text.length === 0 && draft.tokens.length === 0 && draft.attachments.length === 0;
}

/** Serialize only the safe, byte-free draft contract. Invalid values fail closed. */
export function serializeComposerDraft(draft: ComposerDraftValue, now = Date.now(), ttlMs = COMPOSER_DRAFT_TTL_MS): string {
  const sanitized = sanitizeDraft(draft);
  if (!sanitized) throw new Error("Invalid composer draft");
  const savedAt = Number.isFinite(now) ? now : Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : COMPOSER_DRAFT_TTL_MS;
  return JSON.stringify({
    version: COMPOSER_DRAFT_VERSION,
    savedAt,
    expiresAt: savedAt + ttl,
    draft: sanitized,
  } satisfies StoredComposerDraft);
}

export function deserializeComposerDraft(raw: string | null, now = Date.now()): ComposerDraftValue | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== COMPOSER_DRAFT_VERSION || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) return null;
    return sanitizeDraft(parsed.draft);
  } catch {
    return null;
  }
}

function cloneDraft(draft: ComposerDraftValue): ComposerDraftValue {
  return {
    text: draft.text,
    tokens: [...draft.tokens],
    attachments: [...draft.attachments],
  };
}

function readDraft(
  storage: ComposerDraftStorage | null,
  storageKey: string | null,
  now: () => number,
  fallback: ComposerDraftValue = EMPTY_COMPOSER_DRAFT,
): ComposerDraftValue {
  if (!storage || !storageKey) return cloneDraft(fallback);
  try {
    const raw = storage.getItem(storageKey);
    const restored = deserializeComposerDraft(raw, now());
    if (restored) return restored;
    if (raw !== null) storage.removeItem(storageKey);
  } catch {
    // Storage failures are non-fatal: the composer remains usable in memory.
  }
  return cloneDraft(fallback);
}

export interface UseComposerDraftResult {
  draft: ComposerDraftValue;
  setDraft: (next: ComposerDraftUpdater) => void;
  clearDraft: () => void;
  storageKey: string | null;
  storageAvailable: boolean;
}

/**
 * Persist and recover a composer draft across panes/reloads. The key includes
 * every scope that can change message meaning, while attachment bytes remain
 * outside the persisted contract. Storage is best-effort by design.
 */
export function useComposerDraft(
  key: ComposerDraftKey | null,
  initial: Partial<ComposerDraftValue> = {},
  options: ComposerDraftOptions = {},
): UseComposerDraftResult {
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = key ? composerDraftStorageKey(key) : null;
  const initialDraft = { ...EMPTY_COMPOSER_DRAFT, ...initial, tokens: initial.tokens ?? [], attachments: initial.attachments ?? [] };
  const [draft, setDraftState] = useState<ComposerDraftValue>(() =>
    storageKey ? readDraft(storage, storageKey, now, initialDraft) : initialDraft,
  );
  // Hydrate SYNCHRONOUSLY on a key change (render-time state adjustment —
  // React's "derive state from props" pattern). The hook must never commit a
  // render pairing the NEW storageKey with the PREVIOUS entity's draft:
  // consumers key effects on storageKey (WorkspaceTimeline mirrors draft.text
  // into local state; InternalAgentPanel marks the key hydrated on first
  // sight), so a one-render stale pair copies the old entity's text into the
  // new one and drops the new entity's real saved draft (PR #291 review).
  const [hydratedKey, setHydratedKey] = useState(storageKey);
  if (hydratedKey !== storageKey) {
    setHydratedKey(storageKey);
    setDraftState(storageKey ? readDraft(storage, storageKey, now, initialDraft) : initialDraft);
  }

  useEffect(() => {
    // With synchronous hydration above, a committed render always carries the
    // draft that belongs to storageKey — safe to persist directly.
    if (!storage || !storageKey) return;
    try {
      if (isComposerDraftEmpty(draft)) {
        storage.removeItem(storageKey);
      } else {
        storage.setItem(storageKey, serializeComposerDraft(draft, now(), options.ttlMs));
      }
    } catch {
      // Quota/security errors must never disable typing or submission.
    }
  }, [draft, now, options.ttlMs, storage, storageKey]);

  const setDraft = useCallback((next: ComposerDraftUpdater) => {
    setDraftState((previous) => {
      if (typeof next === "function") return next(previous);
      return {
        ...previous,
        ...next,
        tokens: next.tokens ?? previous.tokens,
        attachments: next.attachments ?? previous.attachments,
      };
    });
  }, []);

  const clearDraft = useCallback(() => {
    setDraftState({ ...EMPTY_COMPOSER_DRAFT, tokens: [], attachments: [] });
    if (storage && storageKey) {
      try { storage.removeItem(storageKey); } catch { /* best effort */ }
    }
  }, [storage, storageKey]);

  return { draft, setDraft, clearDraft, storageKey, storageAvailable: storage !== null };
}
