import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer hover:bg-accent/50 no-underline text-inherit"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            className="p-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            node.status === "active"
              ? "bg-green-400"
              : node.status === "paused"
                ? "bg-yellow-400"
                : node.status === "pending_approval"
                  ? "bg-amber-400"
                : node.status === "error"
                  ? "bg-red-400"
                  : "bg-neutral-400"
          )}
        />
        <span className="font-medium flex-1">{node.name}</span>
        <span className="text-xs text-muted-foreground">{node.role}</span>
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree nodes={node.children} depth={depth + 1} hrefFn={hrefFn} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view team." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Team<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your org chart — humans and agents and how they report.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div className="border border-border py-1">
          <OrgTree nodes={data} hrefFn={(id) => `/agents/${id}`} />
        </div>
      )}
    </div>
  );
}
