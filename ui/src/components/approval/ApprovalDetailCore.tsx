import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../../api/approvals";
import { agentsApi } from "../../api/agents";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { queryKeys } from "../../lib/queryKeys";
import { StatusBadge } from "../StatusBadge";
import { Identity } from "../Identity";
import { typeLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../ApprovalPayload";
import { PageSkeleton } from "../PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@armyofagents/shared";
import { MarkdownBody } from "../MarkdownBody";
import { agentTab, taskTab, type HubTab } from "../hub/hubViewerModel";

export interface ApprovalDetailCoreProps {
  /** The approval to render. Route wrapper passes the `:approvalId` param. */
  approvalId: string;
  /**
   * D3 (Inbox Hub): when hosted inside a hub tab, drop the route/page couplings
   * — company route-sync, breadcrumbs, the `?resolved=approved` search-param
   * banner, and post-action navigation. Linked-task / resolved CTA links become
   * `onOpenTab` calls instead of route `<Link>`s.
   */
  embedded?: boolean;
  /**
   * D3: when embedded, opening a linked task / hired agent spawns a sibling hub
   * tab instead of navigating. Ignored (falls back to `<Link>`s) when absent.
   */
  onOpenTab?: (tab: HubTab) => void;
}

export function ApprovalDetailCore({ approvalId, embedded = false, onOpenTab }: ApprovalDetailCoreProps) {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  // Route-only: the `?resolved=approved` success banner. Read unconditionally
  // (hooks rules) but only consulted when NOT embedded — hub tabs have no route
  // search params and drive the banner from local `justApproved` state instead.
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [deleteAgentConfirmOpen, setDeleteAgentConfirmOpen] = useState(false);
  // Embedded tabs have no route search params, so the post-approve success
  // banner is driven by local state instead of `?resolved=approved`.
  const [justApproved, setJustApproved] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId),
    queryFn: () => approvalsApi.get(approvalId),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId),
    queryFn: () => approvalsApi.listComments(approvalId),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId),
    queryFn: () => approvalsApi.listIssues(approvalId),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  // Coupling 1: company route-sync — only when NOT embedded. In a hub tab the
  // company is already selected; syncing it would clobber the host selection.
  useEffect(() => {
    if (embedded) return;
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [embedded, approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  // Coupling (breadcrumbs): page chrome only — the host owns breadcrumbs when
  // embedded (mirrors ThreadDetail's `!embedded` gate).
  useEffect(() => {
    if (embedded) return;
    setBreadcrumbs([
      { label: "Approvals", href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? "Approval" },
    ]);
  }, [embedded, setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
      if (approval.requestedByAgentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.trustScores.list(approval.companyId) });
        queryClient.invalidateQueries({
          queryKey: queryKeys.trustScores.detail(approval.companyId, approval.requestedByAgentId),
        });
      }
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId),
    onSuccess: () => {
      setError(null);
      refresh();
      // Coupling 3: navigate on approve — only when NOT embedded. Embedded tabs
      // stay put; the refetch above + hub reconcile surface the new state.
      if (embedded) {
        setJustApproved(true);
      } else {
        navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      // Coupling 3: navigate on delete — only when NOT embedded. Embedded tabs
      // refetch and let the hub item reconcile.
      if (!embedded) navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  // Coupling 2: the `?resolved=approved` search-param banner is route-only.
  // Embedded tabs have no route search params, so surface the same success via
  // local `justApproved` state.
  const showApprovedBanner =
    approval.status === "approved" &&
    (embedded ? justApproved : searchParams.get("resolved") === "approved");
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const primaryLinkedIssueId = primaryLinkedIssue
    ? primaryLinkedIssue.identifier ?? primaryLinkedIssue.id
    : null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? "Review linked tasks"
              : "Review linked task",
          to: `/issues/${primaryLinkedIssueId}`,
          tab: () => taskTab(primaryLinkedIssue.id, primaryLinkedIssue.title),
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
            tab: () => agentTab(linkedAgentId),
          }
        : {
            label: "Back to approvals",
            to: "/approvals",
            tab: null,
          };

  // Coupling 4: in a hub tab with an onOpenTab handler, the resolved CTA opens a
  // sibling tab instead of navigating; otherwise keep the route navigation.
  const useTabHandoff = embedded && !!onOpenTab;
  const onResolvedCta = () => {
    if (useTabHandoff && resolvedCta.tab) {
      onOpenTab!(resolvedCta.tab());
      return;
    }
    // Never route-navigate away from a hub tab. When embedded with no sibling-tab
    // target (the rare null-tab "Back to approvals" fallback), do nothing rather
    // than escaping the hub. Route mode keeps the navigation.
    if (embedded) return;
    navigate(resolvedCta.to);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">Approval confirmed</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  Requesting agent was notified to review this approval and linked issues.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={onResolvedCta}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h1 className="text-lg font-semibold">{typeLabel[approval.type] ?? approval.type.replace(/_/g, " ")}</h1>
              <p className="text-xs text-muted-foreground font-mono">{approval.id}</p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Requested by</span>
              <Identity
                name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">Linked Tasks</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) =>
                useTabHandoff ? (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onOpenTab!(taskTab(issue.id, issue.title))}
                    className="block w-full text-left text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                  >
                    <span className="font-mono text-muted-foreground mr-2">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    <span>{issue.title}</span>
                  </button>
                ) : (
                  <Link
                    key={issue.id}
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                  >
                    <span className="font-mono text-muted-foreground mr-2">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    <span>{issue.title}</span>
                  </Link>
                ),
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Linked issues remain open until the requesting agent follows up and closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              Request revision
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              Mark resubmitted
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => setDeleteAgentConfirmOpen(true)}
              disabled={deleteAgentMutation.isPending}
            >
              Delete disapproved agent
            </Button>
          )}
        </div>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="border border-border/60 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  useTabHandoff ? (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => onOpenTab!(agentTab(comment.authorAgentId!))}
                    >
                      <Identity
                        name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                        size="sm"
                      />
                    </button>
                  ) : (
                    <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                      <Identity
                        name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                        size="sm"
                      />
                    </Link>
                  )
                ) : (
                  <Identity name="Board" size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteAgentConfirmOpen}
        onOpenChange={setDeleteAgentConfirmOpen}
        title="Delete disapproved agent?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (!linkedAgentId) return;
          deleteAgentMutation.mutate(linkedAgentId);
          setDeleteAgentConfirmOpen(false);
        }}
      />
    </div>
  );
}
