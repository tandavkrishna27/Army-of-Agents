import { Brain } from "lucide-react";

export function MemoryEmptyViewer() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center text-xs text-muted-foreground space-y-2">
        <Brain className="h-10 w-10 mx-auto opacity-20" />
        <div>Pick a memory item or upload a file to start</div>
      </div>
    </div>
  );
}
