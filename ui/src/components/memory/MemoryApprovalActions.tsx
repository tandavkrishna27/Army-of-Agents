// ui/src/components/memory/MemoryApprovalActions.tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";

interface MemoryApprovalActionsProps {
  companyId: string;
  itemId: string;
}

export function MemoryApprovalActions({ companyId, itemId }: MemoryApprovalActionsProps) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: queryKeys.memory.detail(companyId, itemId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
  }

  const approve = useMutation({
    mutationFn: () => memoryApi.approve(companyId, itemId),
    onSuccess: () => {
      pushToast({ title: "Approved", tone: "success" });
      invalidateAll();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Approve failed",
        tone: "error",
      }),
  });

  const reject = useMutation({
    mutationFn: () => memoryApi.reject(companyId, itemId),
    onSuccess: () => {
      pushToast({ title: "Rejected", tone: "success" });
      invalidateAll();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Reject failed",
        tone: "error",
      }),
  });

  const busy = approve.isPending || reject.isPending;

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={() => approve.mutate()}
        disabled={busy}
        className="h-7 gap-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
      >
        {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => reject.mutate()}
        disabled={busy}
        className="h-7 gap-1 text-xs"
      >
        {reject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        Reject
      </Button>
    </div>
  );
}
