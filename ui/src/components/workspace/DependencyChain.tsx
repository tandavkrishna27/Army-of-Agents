import { useQuery } from "@tanstack/react-query";
import { dependenciesApi, type DependencyItem } from "../../api/dependencies";
import { queryKeys } from "../../lib/queryKeys";
import { StatusIcon } from "../StatusIcon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

interface DependencyChainProps {
  issueId: string;
  companyId: string;
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string) => void;
}

export function DependencyChain({
  issueId,
  companyId,
  selectedIssueId,
  onSelectIssue,
}: DependencyChainProps) {
  const { data: deps, isLoading } = useQuery({
    queryKey: queryKeys.issues.dependencies(issueId),
    queryFn: () => dependenciesApi.list(companyId, issueId),
    enabled: !!issueId && !!companyId,
  });

  const upstream = deps?.upstream ?? [];
  const downstream = deps?.downstream ?? [];

  // Build chain: upstream deps → current task → downstream deps
  const chain: { id: string; title: string; status: string; identifier: string | null; isCurrent: boolean }[] = [
    ...upstream.map((d) => ({
      id: d.dependencyIssueId ?? d.id,
      title: d.title,
      status: d.status,
      identifier: d.identifier ?? null,
      isCurrent: false,
    })),
    {
      id: issueId,
      title: "Current",
      status: "",
      identifier: null,
      isCurrent: true,
    },
    ...downstream.map((d) => ({
      id: d.dependentIssueId ?? d.id,
      title: d.title,
      status: d.status,
      identifier: d.identifier ?? null,
      isCurrent: false,
    })),
  ];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-2" data-testid="dependency-chain-skeleton">
        <Skeleton className="h-8 w-24" />
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <Skeleton className="h-8 w-24" />
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  if (upstream.length === 0 && downstream.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto px-4 py-2 border-b border-border shrink-0"
      data-testid="dependency-chain"
    >
      {chain.map((node, idx) => (
        <div key={node.id} className="flex items-center gap-1 shrink-0">
          {idx > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
          <button
            type="button"
            onClick={() => onSelectIssue(node.id)}
            data-testid={`dep-node-${node.id}`}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              node.isCurrent || node.id === selectedIssueId
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card hover:bg-accent/50 text-muted-foreground",
            )}
          >
            {!node.isCurrent && <StatusIcon status={node.status} className="h-3 w-3" />}
            <span className="truncate max-w-[120px]">
              {node.identifier ?? node.title}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
