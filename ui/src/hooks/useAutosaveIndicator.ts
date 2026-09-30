import { useCallback, useState } from "react";

type AutosaveState = "idle" | "saving" | "saved" | "error";

export function useAutosaveIndicator() {
  const [state, setState] = useState<AutosaveState>("idle");

  const markDirty = useCallback(() => setState("saving"), []);
  const reset = useCallback(() => setState("idle"), []);
  const runSave = useCallback(async (saveFn: () => Promise<void>) => {
    setState("saving");
    try {
      await saveFn();
      setState("saved");
      setTimeout(() => setState((s) => s === "saved" ? "idle" : s), 2000);
    } catch {
      setState("error");
    }
  }, []);

  return { state, markDirty, reset, runSave };
}
