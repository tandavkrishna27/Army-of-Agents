import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";

interface Props {
  companyId: string;
  className?: string;
}

export function PendingReviewPill({ companyId, className }: Props) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";

  const { data: queue } = useQuery({
    queryKey: queryKeys.memory.pending(companyId),
    queryFn: () => memoryApi.listPending(companyId),
    enabled: Boolean(companyId),
  });

  const pendingCount = queue?.totalCount ?? 0;
  if (pendingCount === 0) return null;

  return (
    <button
      type="button"
      aria-label={`Review ${pendingCount} pending memory items`}
      onClick={() => navigate(`/${prefix}/memory/explore?folder=__pending`)}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
        "border-border-strong text-muted-foreground hover:bg-white/[0.04]",
        "transition-colors",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: "var(--data-amber)" }}
      />
      <span>{pendingCount} pending</span>
      <span className="text-very-dim">·</span>
      <span className="font-medium text-foreground">Review</span>
    </button>
  );
}
