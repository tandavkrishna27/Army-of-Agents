import { useState } from "react";
import { ExternalLink, Terminal, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { filesystemApi } from "@/api/filesystem";

const PREF_KEY = "aoa:workspace:preferred-editor";
type Editor = "vscode" | "cursor" | "zed";

interface Props {
  cwd: string;
  compact?: boolean;
}

function uriFor(editor: Editor, cwd: string): string {
  const encoded = encodeURIComponent(cwd);
  if (editor === "vscode") return `vscode://file/${encoded}`;
  if (editor === "cursor") return `cursor://file/${encoded}`;
  return `zed://${encoded}`;
}

function readPreferred(): Editor {
  if (typeof window === "undefined") return "vscode";
  const stored = localStorage.getItem(PREF_KEY);
  return stored === "cursor" || stored === "zed" ? stored : "vscode";
}

export function OpenInIdeButton({ cwd, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [preferred, setPreferred] = useState<Editor>(readPreferred);

  const openInEditor = (editor: Editor) => {
    window.location.href = uriFor(editor, cwd);
    localStorage.setItem(PREF_KEY, editor);
    setPreferred(editor);
    setOpen(false);
  };

  const revealInFinder = async () => {
    try {
      await filesystemApi.reveal(cwd);
    } catch {
      // non-fatal; OS reveal failures shouldn't block the UI
    }
    setOpen(false);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(cwd);
    } catch {
      // clipboard unavailable in some contexts
    }
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon-xs" : "sm"}
          className={compact ? "border-border/70 bg-background/60 hover:bg-muted/70" : "gap-1.5"}
          data-testid="open-in-ide-trigger"
          aria-label={compact ? "Open workspace in editor" : undefined}
          title={compact ? "Open workspace in editor" : undefined}
        >
          <ExternalLink className="h-4 w-4" />
          {!compact && "Open in IDE"}
        </Button>
      </DropdownMenuTrigger>
      {open && (
        <DropdownMenuContent align="end" data-testid="open-in-ide-menu">
          <DropdownMenuItem
            onClick={() => openInEditor("vscode")}
            data-testid="open-in-ide-vscode"
          >
            VS Code{preferred === "vscode" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openInEditor("cursor")}
            data-testid="open-in-ide-cursor"
          >
            Cursor{preferred === "cursor" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openInEditor("zed")}
            data-testid="open-in-ide-zed"
          >
            Zed{preferred === "zed" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={revealInFinder} data-testid="open-in-ide-reveal">
            <FolderOpen className="h-4 w-4 mr-2" />
            Reveal in Finder
          </DropdownMenuItem>
          <DropdownMenuItem onClick={copyPath} data-testid="open-in-ide-copy">
            <Terminal className="h-4 w-4 mr-2" />
            Copy path
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
