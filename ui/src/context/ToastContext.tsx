import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error" | "loading";

export interface ToastAction {
  label: string;
  href: string;
}

export interface ToastMeta {
  /** Short mono reference shown in the rich row, e.g. "TASK-128". */
  ref?: string;
}

export interface ToastInput {
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  ttlMs?: number;
  action?: ToastAction;
  meta?: ToastMeta;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  ttlMs: number;
  action?: ToastAction;
  meta?: ToastMeta;
  createdAt: number;
}

export type ToastPatch = Partial<Pick<ToastItem, "title" | "body" | "tone" | "action" | "ttlMs" | "meta">>;

interface ToastContextValue {
  toasts: ToastItem[];
  pushToast: (input: ToastInput) => string | null;
  updateToast: (id: string, patch: ToastPatch) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const DEFAULT_TTL_BY_TONE: Record<Exclude<ToastTone, "loading">, number> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: 10000,
};
const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3500;
const DEDUPE_MAX_AGE_MS = 20000;

const ToastContext = createContext<ToastContextValue | null>(null);

function normalizeTtl(value: number | undefined, tone: ToastTone) {
  const fallback = tone === "loading" ? DEFAULT_TTL_BY_TONE.info : DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

function generateToastId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Authoritative, synchronously-updated mirror of `toasts`. Mutators read and
  // write THIS (not the `toasts` state) so a same-tick pushToast()->updateToast()
  // sees the just-created toast. `commit` writes the ref and the state together.
  const toastsRef = useRef<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const dedupeRef = useRef(new Map<string, number>());

  const commit = useCallback((next: ToastItem[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      commit(toastsRef.current.filter((toast) => toast.id !== id));
    },
    [clearTimer, commit],
  );

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
    commit([]);
  }, [commit]);

  const armTimer = useCallback(
    (id: string, ttlMs: number) => {
      clearTimer(id);
      const timeout = window.setTimeout(() => dismissToast(id), ttlMs);
      timersRef.current.set(id, timeout);
    },
    [clearTimer, dismissToast],
  );

  const pushToast = useCallback(
    (input: ToastInput) => {
      const now = Date.now();
      const tone = input.tone ?? "info";
      const sticky = tone === "loading";
      const ttlMs = sticky ? Number.POSITIVE_INFINITY : normalizeTtl(input.ttlMs, tone);

      // Loading toasts are unique per operation — never deduped, always return an id.
      if (!sticky) {
        const dedupeKey =
          input.dedupeKey ??
          input.id ??
          `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`;

        for (const [key, ts] of dedupeRef.current.entries()) {
          if (now - ts > DEDUPE_MAX_AGE_MS) dedupeRef.current.delete(key);
        }
        const lastSeen = dedupeRef.current.get(dedupeKey);
        if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) return null;
        dedupeRef.current.set(dedupeKey, now);
      }

      const id = input.id ?? generateToastId();
      clearTimer(id);

      const nextToast: ToastItem = {
        id,
        title: input.title,
        body: input.body,
        tone,
        ttlMs,
        action: input.action,
        meta: input.meta,
        createdAt: now,
      };
      const withoutCurrent = toastsRef.current.filter((toast) => toast.id !== id);
      commit([nextToast, ...withoutCurrent].slice(0, MAX_TOASTS));

      if (!sticky) armTimer(id, ttlMs);
      return id;
    },
    [armTimer, clearTimer, commit],
  );

  const updateToast = useCallback(
    (id: string, patch: ToastPatch) => {
      const current = toastsRef.current.find((t) => t.id === id);
      if (!current) return;

      const nextTone = patch.tone ?? current.tone;
      const enteringLoading = current.tone !== "loading" && nextTone === "loading";
      const leavingLoading = current.tone === "loading" && nextTone !== "loading";
      const nextTtl = enteringLoading
        ? Number.POSITIVE_INFINITY
        : leavingLoading || patch.ttlMs !== undefined
          ? normalizeTtl(patch.ttlMs, nextTone)
          : current.ttlMs;

      commit(
        toastsRef.current.map((t) =>
          t.id === id ? { ...t, ...patch, tone: nextTone, ttlMs: nextTtl } : t,
        ),
      );

      if (enteringLoading) {
        // Re-entering loading must become sticky again: cancel any pending auto-dismiss.
        clearTimer(id);
      } else if (leavingLoading) {
        // A sticky loading toast resolved: start its dismissal countdown.
        armTimer(id, nextTtl);
      }
    },
    [armTimer, clearTimer, commit],
  );

  useEffect(
    () => () => {
      for (const handle of timersRef.current.values()) {
        window.clearTimeout(handle);
      }
      timersRef.current.clear();
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, pushToast, updateToast, dismissToast, clearToasts }),
    [toasts, pushToast, updateToast, dismissToast, clearToasts],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
