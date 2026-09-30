import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef } from "react";
import { useBlocker, type BlockerFunction } from "@/lib/router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface UnsavedChangesContextValue {
  /** Register/refresh this caller's dirty state under a stable id. */
  setDirty: (id: string, dirty: boolean) => void;
  /** Drop this caller entirely (on unmount). */
  clear: (id: string) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function useUnsavedChangesContext(): UnsavedChangesContextValue {
  const ctx = useContext(UnsavedChangesContext);
  if (!ctx) throw new Error("useUnsavedChanges must be used within <UnsavedChangesProvider>");
  return ctx;
}

/**
 * Global "unsaved changes" navigation guard. Owns exactly ONE useBlocker and the
 * centralized "Discard unsaved changes?" dialog. Page components register their
 * dirty state via useUnsavedChanges(isDirty); while any registrant is dirty, a
 * cross-path navigation (sidebar <Link>, browser Back/Forward, in-app navigate)
 * is intercepted and confirmed. Tab-close/refresh is NOT covered here (useBlocker
 * can't) — pages that need it keep their own useBeforeUnload.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  // Map of registrant-id → dirty. A ref (not state) is the source of truth so the
  // blocker function — which React Router re-invokes on EVERY navigation attempt,
  // including the retry triggered by blocker.proceed() — always reads the live
  // value. Clearing the ref synchronously in onConfirm BEFORE proceed() is what
  // lets the proceeded navigation through; a state-closure here would re-block on
  // proceed because the state update hasn't flushed yet.
  const registrantsRef = useRef<Map<string, boolean>>(new Map());

  const setDirty = useCallback((id: string, dirty: boolean) => {
    registrantsRef.current.set(id, dirty);
  }, []);

  const clear = useCallback((id: string) => {
    registrantsRef.current.delete(id);
  }, []);

  // Block only cross-path navigations while at least one registrant is dirty.
  // Stable fn (no deps) — it reads the ref each call, so it never goes stale.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
      // Allow only a genuine no-op (identical location). A change to the path,
      // query, OR hash is a real navigation that can discard form state, so any
      // of them while dirty must be confirmed — comparing pathname alone would
      // let a same-path `?query`/`#hash` nav slip past and silently lose edits.
      if (
        currentLocation.pathname === nextLocation.pathname &&
        currentLocation.search === nextLocation.search &&
        currentLocation.hash === nextLocation.hash
      ) {
        return false;
      }
      for (const dirty of registrantsRef.current.values()) {
        if (dirty) return true;
      }
      return false;
    }, []),
  );

  const value = useMemo<UnsavedChangesContextValue>(() => ({ setDirty, clear }), [setDirty, clear]);

  const blocked = blocker.state === "blocked";

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && blocked) blocker.reset();
        }}
        title="Discard unsaved changes?"
        description="You have unsaved edits. Leaving this page will discard them."
        confirmLabel="Discard & leave"
        destructive
        onConfirm={() => {
          // Drop all dirty marks FIRST so the blocker fn re-evaluates to false on
          // the proceeded navigation, then continue.
          registrantsRef.current.clear();
          if (blocker.state === "blocked") blocker.proceed();
        }}
      />
    </UnsavedChangesContext.Provider>
  );
}
