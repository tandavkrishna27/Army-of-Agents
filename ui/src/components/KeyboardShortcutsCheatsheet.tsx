import { X } from "lucide-react";
import { KEYBOARD_SHORTCUTS, type KeyboardShortcut } from "@/lib/keyboard-shortcuts-config";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";

const SECTION_ORDER: KeyboardShortcut["section"][] = ["Inbox", "Task detail", "Global"];

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl p-6"
      >
        <div className="flex items-center justify-between pb-4">
          <DialogTitle className="text-lg font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogClose className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="size-4" aria-hidden="true" />
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">
          Reference of keyboard shortcuts available in AoA.
        </DialogDescription>
        <div className="space-y-6">
          {SECTION_ORDER.map((sectionTitle) => {
            const items = KEYBOARD_SHORTCUTS.filter((s) => s.section === sectionTitle);
            if (items.length === 0) return null;
            return (
              <div key={sectionTitle}>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{sectionTitle}</h3>
                <ul className="space-y-1.5">
                  {items.map((s) => (
                    <li key={s.id} className="flex items-center justify-between text-sm">
                      <span>{s.description}</span>
                      <span className="flex gap-1">
                        {s.keys.map((k, i) => (
                          <KeyCap key={i}>{k}</KeyCap>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
