import { useEffect, useId } from "react";
import { useUnsavedChangesContext } from "@/context/UnsavedChangesProvider";

/**
 * Register this component's unsaved-changes state with the global guard.
 * While `isDirty` is true, cross-page navigation (sidebar <Link>, browser
 * Back/Forward, in-app navigate) is intercepted by the central
 * "Discard unsaved changes?" dialog.
 *
 * Tab-close / refresh is NOT covered here (useBlocker can't) — pages that
 * need it keep their own useBeforeUnload.
 */
export function useUnsavedChanges(isDirty: boolean): void {
  const id = useId();
  const { setDirty, clear } = useUnsavedChangesContext();

  useEffect(() => {
    setDirty(id, isDirty);
  }, [id, isDirty, setDirty]);

  // On unmount, drop this registrant so a stale dirty flag can't block forever.
  useEffect(() => {
    return () => clear(id);
  }, [id, clear]);
}
