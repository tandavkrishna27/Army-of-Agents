export interface KeyboardShortcut {
  /** Key sequence to trigger. Examples: "?", "g i", "Cmd+1". */
  keys: string[];
  /** User-visible label in cheatsheet. */
  description: string;
  /** Group in cheatsheet. */
  section: "Inbox" | "Task detail" | "Global";
  /** Identifier for the handler binding. */
  id: string;
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  // Inbox
  { id: "inbox.next", keys: ["j"], description: "Next item", section: "Inbox" },
  { id: "inbox.prev", keys: ["k"], description: "Previous item", section: "Inbox" },
  { id: "inbox.toggle_nesting", keys: ["t"], description: "Toggle parent-child nesting", section: "Inbox" },
  { id: "inbox.archive", keys: ["a"], description: "Archive", section: "Inbox" },
  { id: "inbox.archive_undo", keys: ["y"], description: "Archive (z to undo)", section: "Inbox" },
  { id: "inbox.undo", keys: ["z"], description: "Undo last archive", section: "Inbox" },
  { id: "inbox.read", keys: ["r"], description: "Mark as read", section: "Inbox" },
  { id: "inbox.unread", keys: ["U"], description: "Mark as unread", section: "Inbox" },
  { id: "inbox.open", keys: ["Enter"], description: "Open task", section: "Inbox" },
  // Task detail
  { id: "task.go_inbox", keys: ["g", "i"], description: "Go to Inbox", section: "Task detail" },
  { id: "task.focus_composer", keys: ["g", "c"], description: "Focus comment composer", section: "Task detail" },
  // Global
  { id: "global.search", keys: ["/"], description: "Search", section: "Global" },
  { id: "global.new_task", keys: ["c"], description: "New task", section: "Global" },
  { id: "global.toggle_sidebar", keys: ["["], description: "Toggle sidebar", section: "Global" },
  { id: "global.switch_company", keys: ["⌘", "1-9"], description: "Switch company", section: "Global" },
  { id: "global.cheatsheet", keys: ["?"], description: "Show keyboard shortcuts", section: "Global" },
];

export function isKeyboardShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}
