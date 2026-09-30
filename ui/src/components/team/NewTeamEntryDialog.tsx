import { useState, useEffect } from "react";
import { Sparkles, Upload } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BuildFromScratchForm } from "./BuildFromScratchForm";
import { ImportUploadDialog } from "./ImportUploadDialog";

type EntryMode = "build" | "import" | null;

interface Props {
  open: boolean;
  initialMode: EntryMode;
  onOpenChange: (open: boolean) => void;
}

export function NewTeamEntryDialog({ open, initialMode, onOpenChange }: Props) {
  const [mode, setMode] = useState<EntryMode>(initialMode);

  // Sync internal mode with initialMode when the dialog reopens
  useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

  if (mode === "build") {
    return <BuildFromScratchForm open={open} onOpenChange={onOpenChange} />;
  }
  if (mode === "import") {
    return <ImportUploadDialog open={open} onOpenChange={onOpenChange} />;
  }

  // Default: 3-option chooser
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a new team</DialogTitle>
          <DialogDescription>
            Pick how you want to start. You can always change later.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="grid grid-cols-2 gap-3">
            <OptionCard
              icon={<Sparkles className="h-5 w-5 text-indigo-500" />}
              title="Build from scratch"
              description="Pick existing agents from your company, or create new ones inline. Coordination is auto-scaffolded."
              cta="Start →"
              onClick={() => setMode("build")}
              highlighted
            />
            <OptionCard
              icon={<Upload className="h-5 w-5 text-slate-600" />}
              title="Import from file"
              description="Upload a .team.yaml package. Resolves dependencies on install."
              cta="Upload →"
              onClick={() => setMode("import")}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

interface OptionCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  onClick?: () => void;
  highlighted?: boolean;
}

function OptionCard({ icon, title, description, cta, onClick, highlighted }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col rounded-lg border p-4 text-left transition-all hover:border-slate-400",
        highlighted
          ? "border-2 border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20"
          : "border-border",
      )}
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-accent">
        {icon}
      </div>
      <h4 className="text-sm font-bold">{title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div
        className={cn(
          "mt-3 text-xs font-bold",
          highlighted ? "text-indigo-600" : "text-slate-600 dark:text-slate-400",
        )}
      >
        {cta}
      </div>
    </button>
  );
}
