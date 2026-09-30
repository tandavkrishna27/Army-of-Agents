import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, UserPlus, Shield, ArrowRightLeft, RotateCw, X, Search, Mail } from "lucide-react";
import type { HumanSearchResult, JoinRequest, TeamMemberSummary, TeamSummary, TeamPermissionSummary } from "@armyofagents/shared";
import { useNavigate } from "@/lib/router";
import { accessApi } from "../../api/access";
import { teamApi } from "../../api/team";
import { projectsApi } from "../../api/projects";
import { healthApi } from "../../api/health";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { formatInviteExpiry, toAbsoluteInviteUrl } from "../../lib/invite-expiry";
import { AddMemberDialog } from "./AddMemberDialog";
import { TransferAdminDialog } from "./TransferAdminDialog";
import { EmptyState } from "../EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ClickableDiv } from "@/components/ui/clickable-div";
import { cn } from "@/lib/utils";
import { getInitials } from "@/lib/initials";
import { RoleBadge } from "./RoleBadge";

type RoleFilter = "all" | "founder" | "team_lead" | "team_member" | "pending";

const ROLE_FILTERS: { value: RoleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "founder", label: "Founder" },
  { value: "team_lead", label: "Team Lead" },
  { value: "team_member", label: "Member" },
  { value: "pending", label: "Pending" },
];

interface HumansTabProps {
  teamSummary: TeamSummary;
  highlightId?: string | null;
  permissions: TeamPermissionSummary;
  isSystemAdmin: boolean;
  onMutationSuccess?: () => void;
}

function PermissionDisabledButton({
  disabled,
  tooltip,
  children,
}: {
  disabled: boolean;
  tooltip: string;
  children: React.ReactNode;
}) {
  if (!disabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function MemberCard({
  member,
  members,
}: {
  member: TeamMemberSummary;
  members: TeamMemberSummary[];
}) {
  const navigate = useNavigate();
  const displayName = member.displayName ?? member.email ?? member.userId.slice(0, 8);
  const initials = getInitials(displayName);
  const parent = member.parentId
    ? members.find((m) => m.userId === member.parentId)
    : null;

  return (
    <ClickableDiv
      className={cn(
        "border border-border bg-card rounded-lg p-4 transition-all duration-150 cursor-pointer hover:bg-accent/30",
      )}
      onClick={() => navigate(`/team/${member.userId}`)}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 shrink-0">
          {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={displayName} />}
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold truncate">{displayName}</span>
            {member.isCurrentUser && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">You</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {member.email ?? "No email"}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <RoleBadge role={member.role} />
          {member.isSystemAdmin && (
            <Badge variant="secondary" className="border-0 text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
              <Shield className="mr-0.5 h-2.5 w-2.5" />
              Admin
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {member.departmentName ?? "No department"}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-border/50 text-[11px] text-muted-foreground">
        {parent
          ? `Reports to ${parent.displayName ?? parent.email ?? parent.userId.slice(0, 8)}`
          : "No manager (root)"}
      </div>
    </ClickableDiv>
  );
}

export interface ResendLinkResult {
  /** Id of the NEW invite the rotated link belongs to. */
  inviteId: string;
  email: string | null;
  url: string;
  expiresAt: string;
}

function InviteCard({
  invite,
  canManage,
  onMutationSuccess,
  onResent,
  onRevoked,
}: {
  invite: TeamSummary["pendingInvites"][number];
  canManage: boolean;
  onMutationSuccess: () => Promise<void>;
  onResent: (result: ResendLinkResult) => void;
  onRevoked: (inviteId: string) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  const resendMutation = useMutation({
    mutationFn: () => teamApi.resendInvite(selectedCompanyId!, invite.id),
    onSuccess: async (result) => {
      // Resend rotates the token — surface the fresh link (this card is about
      // to be replaced by the new invite row, so the link lives in the parent).
      onResent({
        inviteId: result.inviteId,
        email: invite.email,
        url: toAbsoluteInviteUrl(result.inviteUrl),
        expiresAt: result.expiresAt,
      });
      await onMutationSuccess();
      pushToast({ title: "Invite recreated", body: "A fresh link is ready to copy.", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to resend invite", body: err.message, tone: "error" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => teamApi.revokeInvite(selectedCompanyId!, invite.id),
    onSuccess: async () => {
      // The link is dead now — retract any banner still offering it.
      onRevoked(invite.id);
      await onMutationSuccess();
      pushToast({ title: "Invite revoked", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to revoke invite", body: err.message, tone: "error" });
    },
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-muted text-muted-foreground">
          <Mail className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="block truncate text-sm font-semibold">
            {invite.email ?? "Pending invite"}
          </span>
          <span className="text-xs text-muted-foreground">Pending invite</span>
        </div>
      </div>

      {/* Role + dept */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <RoleBadge role={invite.role} />
        <span className="text-xs text-muted-foreground">
          {invite.departmentName ?? "No department"}
        </span>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-dashed border-border/50 pt-2.5">
        <span className="text-[11px] text-muted-foreground">
          {(() => {
            const expiry = formatInviteExpiry(invite.expiresAt);
            return expiry ? expiry.charAt(0).toUpperCase() + expiry.slice(1) : "";
          })()}
        </span>
        {canManage && (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Resend invite"
                  onClick={() => resendMutation.mutate()}
                  disabled={resendMutation.isPending || revokeMutation.isPending}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Resend invite</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Revoke invite"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => revokeMutation.mutate()}
                  disabled={resendMutation.isPending || revokeMutation.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Revoke invite</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}

function HumanSearchResultCard({ result }: { result: HumanSearchResult }) {
  const navigate = useNavigate();
  const displayName = result.displayName ?? result.email ?? result.userId.slice(0, 8);
  const initials = getInitials(displayName);
  const agentTreeCount = result.responsibilitySummary.directAgentTreeCount;

  return (
    <ClickableDiv
      className="border border-border bg-card rounded-lg p-4 transition-all duration-150 cursor-pointer hover:bg-accent/30"
      onClick={() => navigate(`/team/${result.userId}`)}
    >
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 shrink-0">
          {result.avatarUrl && <AvatarImage src={result.avatarUrl} alt={displayName} />}
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold truncate">{displayName}</span>
            <RoleBadge role={result.role} />
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {result.title ?? result.departmentName ?? result.email ?? "Human"}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {result.snippets.slice(0, 3).map((snippet) => (
          <p
            key={`${result.userId}-${snippet.field}-${snippet.label}-${snippet.documentId ?? snippet.value}`}
            className="line-clamp-2 text-xs text-muted-foreground"
          >
            <span className="font-medium text-foreground/80">{snippet.label}</span>
            {": "}
            {snippet.value}
          </p>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
        {result.departmentName && <span>{result.departmentName}</span>}
        {result.reportsToName && <span>Reports to {result.reportsToName}</span>}
        {agentTreeCount > 0 && (
          <span>{agentTreeCount} agent {agentTreeCount === 1 ? "tree" : "trees"}</span>
        )}
        {result.responsibilitySummary.assignedTaskCount > 0 && (
          <span>{result.responsibilitySummary.assignedTaskCount} assigned</span>
        )}
      </div>
    </ClickableDiv>
  );
}

function joinRequestLabel(request: JoinRequest) {
  if (request.requestType === "agent") {
    return request.agentName ?? request.requestEmailSnapshot ?? `Agent request ${request.id.slice(0, 8)}`;
  }
  return request.requestEmailSnapshot ?? request.requestingUserId ?? `Human request ${request.id.slice(0, 8)}`;
}

function JoinRequestCard({
  request,
  canManage,
  onMutationSuccess,
}: {
  request: JoinRequest;
  canManage: boolean;
  onMutationSuccess: () => Promise<void>;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const label = joinRequestLabel(request);

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveJoinRequest(selectedCompanyId!, request.id),
    onSuccess: async () => {
      await onMutationSuccess();
      pushToast({ title: "Join request approved", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to approve request", body: err.message, tone: "error" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => accessApi.rejectJoinRequest(selectedCompanyId!, request.id),
    onSuccess: async () => {
      await onMutationSuccess();
      pushToast({ title: "Join request declined", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to decline request", body: err.message, tone: "error" });
    },
  });

  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-muted text-muted-foreground">
          <UserPlus className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="block truncate text-sm font-semibold">{label}</span>
          <span className="text-xs text-muted-foreground">
            {request.requestType === "agent" ? "Agent join request" : "Human join request"}
          </span>
        </div>
      </div>

      {request.capabilities && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{request.capabilities}</p>
      )}

      <div className="flex items-center justify-between border-t border-dashed border-border/50 pt-2.5">
        <span className="text-[11px] text-muted-foreground">
          Requested {new Date(request.createdAt).toLocaleDateString()}
        </span>
        {canManage && (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={isMutating}
              onClick={() => rejectMutation.mutate()}
            >
              Decline
            </Button>
            <Button
              size="sm"
              disabled={isMutating}
              onClick={() => approveMutation.mutate()}
            >
              Approve
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function HumansTab({ teamSummary, permissions, isSystemAdmin, onMutationSuccess }: HumansTabProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [transferAdminOpen, setTransferAdminOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [resendLink, setResendLink] = useState<ResendLinkResult | null>(null);
  const [resendCopied, setResendCopied] = useState(false);

  const handleResent = useCallback((result: ResendLinkResult) => {
    setResendLink(result);
    setResendCopied(false);
  }, []);

  const handleRevoked = useCallback((inviteId: string) => {
    // Revoking the invite the banner belongs to makes its link dead.
    setResendLink((prev) => (prev?.inviteId === inviteId ? null : prev));
  }, []);

  async function copyResendLink() {
    if (!resendLink) return;
    try {
      await navigator.clipboard.writeText(resendLink.url);
      setResendCopied(true);
      pushToast({ title: "Invite link copied", tone: "success" });
    } catch {
      pushToast({ title: "Couldn't access the clipboard", body: "Copy the link manually.", tone: "error" });
    }
  }

  const { data: projects } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // Fix 1: cloud_auth admits humans invite-only (direct-add is server-rejected
  // because it never writes the org membership). Reuse the app-level health
  // query cache (same key) — no extra network round-trip.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const inviteOnly = health?.deploymentMode === "cloud_auth";

  const joinRequestsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.access.joinRequests(selectedCompanyId)
      : ["access", "join-requests", "none"],
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && permissions.canInviteUsers),
  });

  const departments = useMemo(
    () => (projects ?? []).filter((project) => project.type === "department"),
    [projects],
  );

  const members = teamSummary.members;
  const pendingInvites = teamSummary.pendingInvites;
  const pendingJoinRequests = joinRequestsQuery.data ?? [];
  const trimmedSearch = search.trim();

  const founderCount = members.filter((m) => m.role === "founder").length;
  const teamLeadCount = members.filter((m) => m.role === "team_lead").length;
  const memberCount = members.filter((m) => m.role === "team_member").length;
  const pendingCount = pendingInvites.length + pendingJoinRequests.length;

  const { filteredMembers, filteredInvites, filteredJoinRequests } = useMemo(() => {
    const showMembers = roleFilter !== "pending";
    const showPending = roleFilter === "all" || roleFilter === "pending";
    const roleToMatch = roleFilter !== "all" && roleFilter !== "pending" ? roleFilter : null;

    const fMembers = showMembers
      ? members.filter((m) => {
          if (roleToMatch && m.role !== roleToMatch) return false;
          if (search) {
            const q = search.toLowerCase();
            return (
              (m.displayName ?? "").toLowerCase().includes(q) ||
              (m.email ?? "").toLowerCase().includes(q)
            );
          }
          return true;
        })
      : [];

    const fInvites = showPending
      ? pendingInvites.filter((inv) => {
          if (!search) return true;
          return (inv.email ?? "").toLowerCase().includes(search.toLowerCase());
        })
      : [];

    const fJoinRequests = showPending
      ? pendingJoinRequests.filter((request) => {
          if (!search) return true;
          const q = search.toLowerCase();
          return joinRequestLabel(request).toLowerCase().includes(q);
        })
      : [];

    return { filteredMembers: fMembers, filteredInvites: fInvites, filteredJoinRequests: fJoinRequests };
  }, [members, pendingInvites, pendingJoinRequests, roleFilter, search]);

  const humanSearchInput = useMemo(() => ({
    q: trimmedSearch,
    role: roleFilter === "pending" ? "all" as const : roleFilter,
    limit: 20,
  }), [roleFilter, trimmedSearch]);

  const shouldUseHumanSearch = Boolean(selectedCompanyId && trimmedSearch && roleFilter !== "pending");
  const humanSearchQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.team.humanSearch(selectedCompanyId, humanSearchInput)
      : ["team", "human-search", "none"],
    queryFn: () => teamApi.searchHumans(selectedCompanyId!, humanSearchInput),
    enabled: shouldUseHumanSearch,
  });

  const invalidateTeam = useCallback(async () => {
    if (selectedCompanyId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(selectedCompanyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId) });
      await queryClient.invalidateQueries({ queryKey: ["hub-items", selectedCompanyId] });
    }
    onMutationSuccess?.();
  }, [queryClient, selectedCompanyId, onMutationSuccess]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view team." />;
  }

  const isEmpty = members.length === 0 && pendingInvites.length === 0 && pendingJoinRequests.length === 0;
  const humanSearchResults = shouldUseHumanSearch ? humanSearchQuery.data?.results ?? [] : [];
  const isFilteredEmpty = shouldUseHumanSearch
    ? !humanSearchQuery.isLoading && humanSearchResults.length === 0
    : filteredMembers.length === 0 && filteredInvites.length === 0 && filteredJoinRequests.length === 0;

  return (
    <TooltipProvider>
      <div className="p-5 space-y-4">
        {/* Header */}
        <header className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">
              Humans
              <span className="ml-1 font-mono text-xs font-medium text-muted-foreground">
                {members.length}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Roles, reporting structure, and invites for human collaborators.
            </p>
          </div>
          <div className="flex gap-2">
            {isSystemAdmin && (
              <Button variant="outline" size="sm" onClick={() => setTransferAdminOpen(true)}>
                <ArrowRightLeft className="mr-1.5 h-4 w-4" />
                Transfer Admin
              </Button>
            )}
            <PermissionDisabledButton
              disabled={!permissions.canInviteUsers}
              tooltip="You don't have permission to invite members"
            >
              <Button
                size="sm"
                onClick={() => setAddMemberOpen(true)}
                disabled={!permissions.canInviteUsers}
              >
                <UserPlus className="mr-1.5 h-4 w-4" />
                Invite teammate
              </Button>
            </PermissionDisabledButton>
          </div>
        </header>

        {/* Stats bar */}
        <div className="flex items-center gap-3 overflow-x-auto rounded-lg border border-border bg-card px-4 py-3 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="flex flex-col items-center gap-0.5 shrink-0">
            <span className="font-mono text-sm font-bold tabular-nums">{members.length}</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Members</span>
          </div>
          <div className="h-6 w-px shrink-0 bg-border" />
          <div className="flex flex-col items-center gap-0.5 shrink-0">
            <span className="font-mono text-sm font-bold tabular-nums text-brand">{founderCount}</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Founder</span>
          </div>
          <div className="h-6 w-px shrink-0 bg-border" />
          <div className="flex flex-col items-center gap-0.5 shrink-0">
            <span
              className="font-mono text-sm font-bold tabular-nums"
              style={{ color: "var(--data-indigo)" }}
            >
              {teamLeadCount}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Team Lead</span>
          </div>
          <div className="h-6 w-px shrink-0 bg-border" />
          <div className="flex flex-col items-center gap-0.5 shrink-0">
            <span className="font-mono text-sm font-bold tabular-nums">{memberCount}</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Member</span>
          </div>
          {pendingCount > 0 && (
            <>
              <div className="h-6 w-px shrink-0 bg-border" />
              <div className="flex flex-col items-center gap-0.5 shrink-0">
                <span
                  className="font-mono text-sm font-bold tabular-nums"
                  style={{ color: "var(--warning)" }}
                >
                  {pendingCount}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending</span>
              </div>
            </>
          )}
        </div>

        {/* Search + role filter */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search humans by skills, responsibilities, role, or docs..."
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {ROLE_FILTERS.map(({ value, label }) => {
              const isActive = roleFilter === value;
              const count =
                value === "all"
                  ? members.length + pendingCount
                  : value === "pending"
                    ? pendingCount
                    : value === "founder"
                      ? founderCount
                      : value === "team_lead"
                        ? teamLeadCount
                        : memberCount;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRoleFilter(value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap",
                    isActive
                      ? "bg-foreground text-background border-foreground"
                      : "bg-card border-border text-foreground/70 hover:bg-accent hover:text-foreground",
                  )}
                >
                  {label}
                  <span className="font-mono text-[10px] opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Fresh link after a resend — the token rotated, so this is the only
            place the founder can grab the new URL. */}
        {resendLink && (
          <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                New invite link{resendLink.email ? ` for ${resendLink.email}` : ""}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss new invite link"
                onClick={() => setResendLink(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Input readOnly value={resendLink.url} aria-label="New invite link URL" />
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={copyResendLink}>
                {resendCopied ? "Copied" : "Copy link"}
              </Button>
              <span className="text-xs text-muted-foreground">
                This link {formatInviteExpiry(resendLink.expiresAt)}.
              </span>
            </div>
          </div>
        )}

        {/* Grid */}
        {isEmpty ? (
          <EmptyState
            icon={Users}
            message="Invite your first teammate"
            description="Create an email-bound invite link — or add someone manually."
            action="Invite teammate"
            onAction={permissions.canInviteUsers ? () => setAddMemberOpen(true) : undefined}
          />
        ) : humanSearchQuery.isError ? (
          <p className="py-8 text-center text-sm text-destructive">
            Unable to search humans.
          </p>
        ) : humanSearchQuery.isLoading && shouldUseHumanSearch ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Searching humans...
          </p>
        ) : isFilteredEmpty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No results match your search or filter.
          </p>
        ) : shouldUseHumanSearch ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {humanSearchResults.map((result) => (
              <HumanSearchResultCard key={result.userId} result={result} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredMembers.map((member) => (
              <MemberCard
                key={member.userId}
                member={member}
                members={members}
              />
            ))}
            {filteredInvites.map((invite) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                canManage={permissions.canInviteUsers}
                onMutationSuccess={invalidateTeam}
                onResent={handleResent}
                onRevoked={handleRevoked}
              />
            ))}
            {filteredJoinRequests.map((request) => (
              <JoinRequestCard
                key={request.id}
                request={request}
                canManage={permissions.canInviteUsers}
                onMutationSuccess={invalidateTeam}
              />
            ))}
          </div>
        )}

        <AddMemberDialog
          companyId={selectedCompanyId}
          departments={departments}
          members={members}
          isSystemAdmin={isSystemAdmin}
          inviteOnly={inviteOnly}
          open={addMemberOpen}
          onOpenChange={setAddMemberOpen}
        />

        {isSystemAdmin && (
          <TransferAdminDialog
            companyId={selectedCompanyId}
            founders={members.filter((m) => m.role === "founder")}
            currentUserId={teamSummary.currentUser?.userId ?? ""}
            open={transferAdminOpen}
            onOpenChange={setTransferAdminOpen}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
