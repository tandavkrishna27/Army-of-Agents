import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { WorkspaceLayout } from "../components/workspace/WorkspaceLayout";
import { PageSkeleton } from "../components/PageSkeleton";

export function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const selectedIssueParam = searchParams.get("issue");

  const { data: workspace, isLoading: wsLoading } = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: !!workspaceId,
  });

  const effectiveIssueId = selectedIssueId ?? workspace?.sourceIssueId ?? null;

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(effectiveIssueId ?? ""),
    queryFn: () => issuesApi.get(effectiveIssueId!),
    enabled: !!effectiveIssueId,
  });

  const { data: project } = useQuery({
    queryKey: queryKeys.projects.detail(workspace?.projectId ?? ""),
    queryFn: () => projectsApi.get(workspace!.projectId),
    enabled: !!workspace?.projectId,
  });

  // Set the active issue from URL first, then fall back to the workspace source task.
  useEffect(() => {
    if (selectedIssueParam) {
      setSelectedIssueId(selectedIssueParam);
      return;
    }
    if (workspace?.sourceIssueId) {
      setSelectedIssueId(workspace.sourceIssueId);
    }
  }, [workspace?.id, workspace?.sourceIssueId, selectedIssueParam]);

  const handleSelectIssue = (issueId: string, executionWorkspaceId?: string | null) => {
    setSelectedIssueId(issueId);
    const nextWorkspaceId = executionWorkspaceId ?? workspace?.id ?? workspaceId;
    if (!nextWorkspaceId) return;
    const prefix = selectedCompany?.issuePrefix ?? "";
    const nextPath = `/${prefix}/workspaces/${nextWorkspaceId}?issue=${encodeURIComponent(issueId)}`;
    navigate(nextPath, { replace: nextWorkspaceId === workspace?.id });
  };

  useEffect(() => {
    if (workspace && project) {
      setBreadcrumbs([
        { label: project.name, href: `/projects/${project.id}` },
        { label: issue?.identifier ?? workspace.name, href: issue ? `/issues?selected=${issue.id}` : "" },
        { label: workspace.name },
      ]);
    } else {
      setBreadcrumbs([{ label: "Workspace" }]);
    }
  }, [workspace, project, issue, setBreadcrumbs]);

  if (wsLoading) {
    return <PageSkeleton />;
  }

  if (!workspace) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Workspace not found
      </div>
    );
  }

  return (
    <WorkspaceLayout
      workspace={workspace}
      project={project ?? null}
      selectedIssueId={selectedIssueId}
      onSelectIssue={handleSelectIssue}
      companyId={selectedCompanyId!}
      companyPrefix={selectedCompany?.issuePrefix ?? ""}
      selectedIssueIdentifier={issue?.identifier ?? null}
      onBack={() => {
        if (project) {
          navigate(`/projects/${project.id}`);
        } else {
          navigate(-1);
        }
      }}
    />
  );
}
