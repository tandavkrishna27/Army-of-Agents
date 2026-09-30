import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  markdown: string;
}

export function PreviewAsLlmDialog({ open, onOpenChange, markdown }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Preview as LLM</DialogTitle>
          <DialogDescription>
            This is what each team member's system prompt will include. The
            agent's per-role instructions are appended below.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="overflow-y-auto rounded border bg-muted/40 p-4 font-mono text-xs">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              # Team coordination
            </div>
            <pre className="whitespace-pre-wrap">{markdown}</pre>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
