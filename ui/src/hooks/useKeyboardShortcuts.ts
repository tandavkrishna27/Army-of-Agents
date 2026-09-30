import { useEffect } from "react";
import { isKeyboardShortcutTextInputTarget } from "@/lib/keyboard-shortcuts-config";

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onSwitchCompany?: (index: number) => void;
  /** Open the keyboard shortcut cheatsheet. Bound to global.cheatsheet ("?"). */
  onShowCheatsheet?: () => void;
}

/**
 * Handles keyboard shortcuts for global navigation.
 *
 * Currently bound IDs from KEYBOARD_SHORTCUTS:
 *   - global.new_task       → onNewIssue
 *   - global.toggle_sidebar → onToggleSidebar
 *   - global.switch_company → onSwitchCompany
 *   - global.cheatsheet     → onShowCheatsheet
 */
export function useKeyboardShortcuts({ onNewIssue, onToggleSidebar, onSwitchCompany, onShowCheatsheet }: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't fire shortcuts when typing in inputs
      if (isKeyboardShortcutTextInputTarget(e.target)) {
        return;
      }

      // Cmd+1..9 → Switch company
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        onSwitchCompany?.(parseInt(e.key, 10) - 1);
        return;
      }

      // ? → Show keyboard cheatsheet (e.key === "?" regardless of Shift state on US layout)
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onShowCheatsheet?.();
        return;
      }

      // C → New Issue
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onNewIssue, onToggleSidebar, onSwitchCompany, onShowCheatsheet]);
}
