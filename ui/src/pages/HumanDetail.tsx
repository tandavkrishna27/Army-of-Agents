import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Users,
  Bot,
  ClipboardList,
  FileText,
  Shield,
  Trash2,
  ChevronRight,
  MapPin,
  Clock,
  Link as LinkIcon,
  Activity,
  Camera,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import type {
  ActivityEvent,
  HumanCapabilityDocumentDetail,
  HumanWorkloadTaskSummary,
  HumanSocialLink,
  HumanSocialLinkType,
  Issue,
  Project,
  UpdateCompanyUserProfile,
  UserRole,
} from "@armyofagents/shared";
import { teamApi } from "../api/team";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { assetsApi } from "../api/assets";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { MetricCard } from "../components/MetricCard";
import { Identity } from "../components/Identity";
import { TaskSlideOver } from "../components/TaskSlideOver";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageTabBar } from "../components/PageTabBar";
import { ReassignmentDialog } from "../components/team/ReassignmentDialog";
import { cn } from "../lib/utils";
import { HUMAN_TITLE_OPTIONS, getTimezoneOptions } from "@/lib/human-profile-constants";

const ROLE_STYLES: Record<UserRole, string> = {
  founder: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  team_lead: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  team_member: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

const ROLE_LABELS: Record<UserRole, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Team Member",
};

const TAB_ITEMS = [
  { value: "overview", label: "Overview" },
  { value: "workload", label: "Workload" },
  { value: "roles", label: "Roles" },
  { value: "capabilities", label: "Capabilities" },
  { value: "settings", label: "Settings" },
];

const HUMAN_SOCIAL_LINK_TYPES: HumanSocialLinkType[] = [
  "linkedin",
  "github",
  "x",
  "instagram",
  "facebook",
  "substack",
  "website",
  "portfolio",
  "youtube",
  "medium",
  "other",
];

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function compactDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function displayIssueStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function displaySocialLabel(link: HumanSocialLink): string {
  return link.label?.trim() || link.type[0].toUpperCase() + link.type.slice(1);
}

function filenameToTitle(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function activityTitle(event: ActivityEvent): string | null {
  const title = event.details?.title;
  const name = event.details?.name;
  if (typeof title === "string" && title.trim()) return title;
  if (typeof name === "string" && name.trim()) return name;
  return null;
}

function TaskListSection({
  title,
  icon: Icon,
  tasks,
  isLoading,
  empty,
}: {
  title: string;
  icon: typeof ClipboardList;
  tasks: Array<Issue & { responsibleAgentId?: string }>;
  isLoading: boolean;
  empty: string;
}) {
  const visible = tasks.slice(0, 5);
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Icon className="h-4 w-4" />
          {title}
        </h3>
        {tasks.length > visible.length && (
          <span className="text-xs text-muted-foreground">{tasks.length - visible.length} more</span>
        )}
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1">
          {visible.map((task) => (
            <Link
              key={task.id}
              to={`/issues/${task.id}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
            >
              <span className="min-w-0">
                <span className="mr-2 text-xs font-medium text-muted-foreground">{task.identifier ?? `#${task.issueNumber ?? ""}`}</span>
                <span className="font-medium">{task.title}</span>
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="capitalize">{displayIssueStatus(task.status)}</span>
                <span>{compactDate(task.updatedAt)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkloadTaskRow({ task, onOpen }: { task: HumanWorkloadTaskSummary; onOpen: (taskId: string) => void }) {
  return (
    <button
      type="button"
      aria-label={`Open ${task.title}`}
      onClick={() => onOpen(task.id)}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors text-inherit"
    >
      <span className="min-w-0">
        <span className="mr-2 text-xs font-medium text-muted-foreground">{task.identifier ?? task.id.slice(0, 8)}</span>
        <span className="font-medium">{task.title}</span>
      </span>
      <span className="text-xs capitalize text-muted-foreground">{displayIssueStatus(task.status)}</span>
    </button>
  );
}

function WorkloadSection({
  title,
  tasks,
  empty,
  onOpenTask,
}: {
  title: string;
  tasks: HumanWorkloadTaskSummary[];
  empty: string;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1">
          {tasks.map((task) => (
            <WorkloadTaskRow key={task.id} task={task} onOpen={onOpenTask} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivitySection({ events, isLoading }: { events: ActivityEvent[]; isLoading: boolean }) {
  const visible = events.slice(0, 6);
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4" />
        Activity
      </h3>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent activity by this person.</p>
      ) : (
        <div className="space-y-1">
          {visible.map((event) => {
            const label = activityTitle(event);
            const body = (
              <>
                <span className="font-medium">{event.action}</span>
                {label && <span className="truncate text-muted-foreground">{label}</span>}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{compactDate(event.createdAt)}</span>
              </>
            );
            const className = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit";
            return event.entityType === "issue" ? (
              <Link key={event.id} to={`/issues/${event.entityId}`} className={className}>
                {body}
              </Link>
            ) : (
              <div key={event.id} className={className}>
                {body}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function HumanDetail() {
  const { userId, tab } = useParams<{ userId: string; tab?: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const activeTab = tab === "settings" || tab === "roles" || tab === "capabilities" || tab === "workload"
    ? tab
    : "overview";
  const selectedTaskId = searchParams.get("task");

  const humanPath = useCallback(
    (targetTab = activeTab) => targetTab === "overview" ? `/team/${userId}` : `/team/${userId}/${targetTab}`,
    [activeTab, userId],
  );

  const handleTabChange = useCallback(
    (value: string) => {
      navigate(value === "overview" ? `/team/${userId}` : `/team/${userId}/${value}`);
    },
    [navigate, userId],
  );

  const handleOpenTask = useCallback(
    (taskId: string) => {
      navigate(`${humanPath()}?task=${encodeURIComponent(taskId)}`);
    },
    [humanPath, navigate],
  );

  const handleCloseTask = useCallback(() => {
    navigate(humanPath(), { replace: true });
  }, [humanPath, navigate]);

  // Member + dependencies
  const { data, isLoading } = useQuery({
    queryKey: selectedCompanyId && userId
      ? queryKeys.team.member(selectedCompanyId, userId)
      : ["team", "none", "member"],
    queryFn: () => teamApi.getMember(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId),
  });

  // Team summary (for settings tab — member list for reports-to, permissions)
  const teamQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.team.summary(selectedCompanyId)
      : ["team", "none"],
    queryFn: () => teamApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const capabilitiesQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? queryKeys.team.capabilities(selectedCompanyId, userId)
      : ["team", "none", "capabilities"],
    queryFn: () => teamApi.listCapabilities(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "capabilities",
  });

  const workloadQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? queryKeys.team.workload(selectedCompanyId, userId)
      : ["team", "none", "member", "workload"],
    queryFn: () => teamApi.getWorkload(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "workload",
  });

  // Departments (for role editing)
  const deptQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.projects.list(selectedCompanyId)
      : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && activeTab === "roles",
  });

  const member = data?.member;
  const deps = data?.dependencies;
  const teamSummary = teamQuery.data;
  const directAgentIds = useMemo(
    () => Array.from(new Set((deps?.agentTrees ?? []).flatMap((tree) => tree.agentIds ?? [tree.rootAgentId]))),
    [deps?.agentTrees],
  );
  const departments = useMemo(
    () => (deptQuery.data ?? []).filter((p: Project) => p.type === "department"),
    [deptQuery.data],
  );

  // Settings draft state
  const [draftRole, setDraftRole] = useState<UserRole>("team_member");
  const [draftDepartmentId, setDraftDepartmentId] = useState<string>("none");
  const [draftParentId, setDraftParentId] = useState<string>("none");
  const [profileDraft, setProfileDraft] = useState<UpdateCompanyUserProfile>({
    socialLinks: [],
  });
  const [profileDraftDirty, setProfileDraftDirty] = useState(false);
  const profileDraftSourceKeyRef = useRef<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarFileDirty, setAvatarFileDirty] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);
  const [capabilityEditing, setCapabilityEditing] = useState(false);
  const [capabilityDraft, setCapabilityDraft] = useState("");
  const [newCapabilityOpen, setNewCapabilityOpen] = useState(false);
  const [newCapabilityTitle, setNewCapabilityTitle] = useState("");
  const [newCapabilityFilename, setNewCapabilityFilename] = useState("");
  const timezoneOptions = useMemo(() => getTimezoneOptions(), []);
  const titleOptions = useMemo(
    () => Array.from(new Set([
      ...HUMAN_TITLE_OPTIONS,
      ...(member?.title ? [member.title] : []),
      ...(profileDraft.title ? [profileDraft.title] : []),
    ])).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [member?.title, profileDraft.title],
  );

  const resetProfileDraftFromMember = useCallback(() => {
    if (!member) return;
    setProfileDraft({
      displayName: member.displayName ?? null,
      title: member.title ?? null,
      bio: member.bio ?? null,
      location: member.location ?? null,
      timezone: member.timezone ?? null,
      socialLinks: member.socialLinks.length > 0
        ? member.socialLinks
        : [{ type: "github", label: null, url: "" }],
    });
    setProfileDraftDirty(false);
    setAvatarFileDirty(false);
  }, [member]);

  // Sync draft state when member loads
  useEffect(() => {
    if (member) {
      const sourceKey = `${selectedCompanyId ?? "none"}:${member.userId}`;
      if (profileDraftSourceKeyRef.current === sourceKey && (profileDraftDirty || avatarFileDirty)) return;
      profileDraftSourceKeyRef.current = sourceKey;
      setDraftRole(member.role);
      setDraftDepartmentId(member.departmentId ?? "none");
      setDraftParentId(member.parentId ?? "none");
      resetProfileDraftFromMember();
    }
  }, [avatarFileDirty, member, profileDraftDirty, resetProfileDraftFromMember, selectedCompanyId]);

  // Permissions
  const currentUser = teamSummary?.currentUser;
  const canManageRoles = currentUser?.permissions?.canManageRoles ?? false;
  const founderCount = useMemo(
    () => (teamSummary?.members ?? []).filter((m) => m.role === "founder").length,
    [teamSummary?.members],
  );
  const isSelf = member?.isCurrentUser ?? false;
  const canEditProfile = isSelf || canManageRoles || (currentUser?.isSystemAdmin ?? false);
  const selfFounderLock = isSelf && member?.role === "founder" && founderCount <= 1;
  const canRemove = canManageRoles && !isSelf && !(member?.role === "founder" && founderCount <= 1);

  const manager = useMemo(
    () => (member?.parentId ? (teamSummary?.members ?? []).find((m) => m.userId === member.parentId) : null),
    [member?.parentId, teamSummary?.members],
  );

  const responsibleTasksQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? ["team", selectedCompanyId, "human", userId, "responsible-tasks", "all"]
      : ["team", "none", "human", "responsible-tasks"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { responsibleUserId: userId!, taskScope: "all" }),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
  });

  const assignedTasksQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? ["team", selectedCompanyId, "human", userId, "assigned-tasks", "all"]
      : ["team", "none", "human", "assigned-tasks"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeUserId: userId!, taskScope: "all" }),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
  });

  const createdTasksQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? ["team", selectedCompanyId, "human", userId, "created-tasks", "all"]
      : ["team", "none", "human", "created-tasks"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { createdByUserId: userId!, taskScope: "all" }),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
  });

  const agentTasksQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? ["team", selectedCompanyId, "human", userId, "responsible-agent-tasks", directAgentIds]
      : ["team", "none", "human", "responsible-agent-tasks"],
    queryFn: async () => {
      const taskLists = await Promise.all(
        directAgentIds.map(async (agentId) => ({
          agentId,
          tasks: await issuesApi.list(selectedCompanyId!, { assigneeAgentId: agentId, taskScope: "all" }),
        })),
      );
      const byId = new Map<string, Issue & { responsibleAgentId?: string }>();
      for (const { agentId, tasks } of taskLists) {
        for (const task of tasks) {
          if (!byId.has(task.id)) byId.set(task.id, { ...task, responsibleAgentId: agentId });
        }
      }
      return Array.from(byId.values());
    },
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview" && directAgentIds.length > 0,
  });

  const activityQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? ["team", selectedCompanyId, "human", userId, "activity", "user"]
      : ["team", "none", "human", "activity"],
    queryFn: () => activityApi.list(selectedCompanyId!, { actorType: "user", actorId: userId! }),
    enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
  });

  // Reports-to options: all members except self
  const reportsToOptions = useMemo(
    () => (teamSummary?.members ?? []).filter((m) => m.userId !== userId),
    [teamSummary?.members, userId],
  );

  const capabilityDocuments = capabilitiesQuery.data?.documents ?? [];
  const selectedCapability = useMemo<HumanCapabilityDocumentDetail | null>(() => {
    if (capabilityDocuments.length === 0) return null;
    return capabilityDocuments.find((doc) => doc.id === selectedCapabilityId) ?? capabilityDocuments[0] ?? null;
  }, [capabilityDocuments, selectedCapabilityId]);

  useEffect(() => {
    if (!selectedCapability && selectedCapabilityId) {
      setSelectedCapabilityId(null);
    }
    if (!selectedCapabilityId && capabilityDocuments[0]) {
      setSelectedCapabilityId(capabilityDocuments[0].id);
    }
  }, [capabilityDocuments, selectedCapability, selectedCapabilityId]);

  useEffect(() => {
    if (!selectedCapability) return;
    setCapabilityDraft(selectedCapability.content);
    setCapabilityEditing(false);
  }, [selectedCapability?.id, selectedCapability?.content]);

  // Remove dialog
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  // Has unsaved changes?
  const hasChanges = Boolean(member && (
    draftRole !== member.role ||
    (draftDepartmentId === "none" ? null : draftDepartmentId) !== member.departmentId ||
    (draftParentId === "none" ? null : draftParentId) !== member.parentId
  ));

  const invalidateAll = useCallback(() => {
    if (!selectedCompanyId || !userId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.team.member(selectedCompanyId, userId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org.tree(selectedCompanyId) });
  }, [queryClient, selectedCompanyId, userId]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: () =>
      teamApi.updateRole(selectedCompanyId!, userId!, {
        role: draftRole,
        projectId: draftRole === "founder" ? null : (draftDepartmentId === "none" ? null : draftDepartmentId),
        parentType: draftParentId === "none" ? null : "user",
        parentId: draftParentId === "none" ? null : draftParentId,
      }),
    onSuccess: () => {
      setRoleDialogOpen(false);
      invalidateAll();
      pushToast({ title: "Role saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Save failed", body: err.message, tone: "error" }),
  });

  const saveProfileMutation = useMutation({
    mutationFn: (input: UpdateCompanyUserProfile) => teamApi.updateProfile(selectedCompanyId!, userId!, input),
    onSuccess: () => {
      setProfileDraftDirty(false);
      setProfileDialogOpen(false);
      invalidateAll();
      pushToast({ title: "Profile saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Profile save failed", body: err.message, tone: "error" }),
  });

  const updateCapabilityMutation = useMutation({
    mutationFn: ({ documentId, content }: { documentId: string; content: string }) =>
      teamApi.updateCapabilityDocument(selectedCompanyId!, userId!, documentId, { content }),
    onSuccess: () => {
      setCapabilityEditing(false);
      if (selectedCompanyId && userId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.team.capabilities(selectedCompanyId, userId) });
      }
      pushToast({ title: "Document saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Document save failed", body: err.message, tone: "error" }),
  });

  const createCapabilityMutation = useMutation({
    mutationFn: () => teamApi.createCapabilityDocument(selectedCompanyId!, userId!, {
      title: newCapabilityTitle.trim() || filenameToTitle(newCapabilityFilename),
      filename: newCapabilityFilename.trim(),
      content: `# ${newCapabilityTitle.trim() || filenameToTitle(newCapabilityFilename)}\n`,
    }),
    onSuccess: (result) => {
      setSelectedCapabilityId(result.document.id);
      setNewCapabilityOpen(false);
      setNewCapabilityTitle("");
      setNewCapabilityFilename("");
      if (selectedCompanyId && userId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.team.capabilities(selectedCompanyId, userId) });
      }
      pushToast({ title: "Document added", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Document add failed", body: err.message, tone: "error" }),
  });

  const deleteCapabilityMutation = useMutation({
    mutationFn: (documentId: string) => teamApi.deleteCapabilityDocument(selectedCompanyId!, userId!, documentId),
    onSuccess: () => {
      setSelectedCapabilityId(null);
      if (selectedCompanyId && userId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.team.capabilities(selectedCompanyId, userId) });
      }
      pushToast({ title: "Document deleted", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Document delete failed", body: err.message, tone: "error" }),
  });

  const avatarUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const asset = await assetsApi.uploadImage(selectedCompanyId!, file, "humans/avatars");
      return teamApi.updateProfile(selectedCompanyId!, userId!, { avatarAssetId: asset.assetId });
    },
    onSuccess: () => {
      setAvatarFileDirty(false);
      invalidateAll();
      pushToast({ title: "Avatar updated", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Avatar update failed", body: err.message, tone: "error" }),
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => teamApi.updateProfile(selectedCompanyId!, userId!, { avatarAssetId: null }),
    onSuccess: () => {
      invalidateAll();
      pushToast({ title: "Avatar removed", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Avatar remove failed", body: err.message, tone: "error" }),
  });

  const saveProfile = useCallback(() => {
    const socialLinks = (profileDraft.socialLinks ?? [])
      .map((link) => ({
        type: link.type,
        label: link.label?.trim() ? link.label.trim() : null,
        url: link.url.trim(),
      }))
      .filter((link) => link.url.length > 0);

    saveProfileMutation.mutate({
      displayName: profileDraft.displayName?.trim() ? profileDraft.displayName.trim() : null,
      title: profileDraft.title?.trim() ? profileDraft.title.trim() : null,
      bio: profileDraft.bio?.trim() ? profileDraft.bio.trim() : null,
      location: profileDraft.location?.trim() ? profileDraft.location.trim() : null,
      timezone: profileDraft.timezone?.trim() ? profileDraft.timezone.trim() : null,
      socialLinks,
    });
  }, [profileDraft, saveProfileMutation]);

  const updateSocialLink = useCallback((index: number, patch: Partial<HumanSocialLink>) => {
    setProfileDraftDirty(true);
    setProfileDraft((current) => {
      const links = [...(current.socialLinks ?? [])];
      links[index] = { ...links[index], ...patch } as HumanSocialLink;
      return { ...current, socialLinks: links };
    });
  }, []);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Team", href: "/team" },
      { label: member?.displayName ?? member?.email ?? "Member" },
    ]);
  }, [setBreadcrumbs, member]);

  if (!selectedCompanyId || !userId) {
    return <EmptyState icon={Users} message="Select a company to view team." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  if (!member) {
    return <EmptyState icon={Users} message="Team member not found" />;
  }

  const displayName = member.displayName ?? member.email ?? member.userId.slice(0, 8);
  const initials = deriveInitials(displayName);
  const headerMeta = [
    member.location ? { icon: MapPin, label: member.location } : null,
    member.timezone ? { icon: Clock, label: member.timezone } : null,
  ].filter(Boolean) as Array<{ icon: typeof MapPin; label: string }>;
  const canRemoveAvatar = Boolean(member.avatarUrl) || avatarUploadMutation.isSuccess;

  return (
    <div className="space-y-6">
      <Link to="/team?tab=humans" className="inline-flex no-underline">
        <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground -ml-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Team
        </Button>
      </Link>

      {/* Header */}
      <div className="relative rounded-2xl border border-border bg-card p-5 pr-16">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-4 top-4"
          aria-label="Edit profile"
          onClick={() => setProfileDialogOpen(true)}
        >
          <Pencil className="h-4 w-4" />
        </Button>

        <div className="grid gap-4 sm:grid-cols-[4rem_minmax(0,1fr)] sm:items-start">
          <Avatar
            data-testid="human-profile-avatar"
            shape="squircle"
            className="h-16 w-16 border border-border bg-accent text-lg shadow-sm sm:mt-1"
          >
            {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={displayName} />}
            <AvatarFallback className="bg-accent text-foreground font-semibold">{initials}</AvatarFallback>
          </Avatar>

          <div className="min-w-0">
            <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
              <h1 className="min-w-0 text-2xl font-bold leading-tight">{displayName}</h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className={cn("border-0", ROLE_STYLES[member.role])}>
                  {ROLE_LABELS[member.role]}
                </Badge>
                {member.isSystemAdmin && (
                  <Badge variant="secondary" className="border-0 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                    <Shield className="mr-1 h-3 w-3" />
                    Admin
                  </Badge>
                )}
                {member.isCurrentUser && (
                  <Badge variant="outline" className="text-[11px]">You</Badge>
                )}
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {member.email ?? "No email"} · {member.departmentName ?? "No department"}
            </p>
            {member.title && <p className="mt-2 text-sm font-medium text-foreground">{member.title}</p>}
            {member.bio && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{member.bio}</p>}
            {(headerMeta.length > 0 || member.socialLinks.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {headerMeta.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1">
                    <Icon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{label}</span>
                  </span>
                ))}
                {member.socialLinks.map((social) => (
                  <a
                    key={`${social.type}-${social.url}`}
                    href={social.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground no-underline hover:text-foreground"
                  >
                    <LinkIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{displaySocialLabel(social)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      <Dialog
        open={roleDialogOpen}
        onOpenChange={(open) => {
          setRoleDialogOpen(open);
          if (!open && member) {
            setDraftRole(member.role);
            setDraftDepartmentId(member.departmentId ?? "none");
            setDraftParentId(member.parentId ?? "none");
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader className="shrink-0 px-6 pt-4 pb-2">
            <DialogTitle>Edit Roles</DialogTitle>
            <DialogDescription className="sr-only">
              Update this person's company role, department, and reporting line.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-2 pb-4">
            <div className="rounded-lg border border-border bg-muted/25 p-4">
              <p className="text-sm font-medium">{displayName}</p>
              <p className="mt-1 text-xs text-muted-foreground">{member.email ?? "No email"}</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Role</label>
              <Select
                value={draftRole}
                onValueChange={(value) => {
                  const nextRole = value as UserRole;
                  setDraftRole(nextRole);
                  if (nextRole === "founder") {
                    setDraftDepartmentId("none");
                    setDraftParentId("none");
                  }
                }}
                disabled={!canManageRoles || selfFounderLock || saveMutation.isPending}
              >
                <SelectTrigger className="w-full" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="founder">Founder</SelectItem>
                  <SelectItem value="team_lead">Team Lead</SelectItem>
                  <SelectItem value="team_member">Team Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Department</label>
              <Select
                value={draftDepartmentId}
                onValueChange={setDraftDepartmentId}
                disabled={!canManageRoles || selfFounderLock || draftRole === "founder" || saveMutation.isPending}
              >
                <SelectTrigger className="w-full" aria-label="Department">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No department</SelectItem>
                  {departments.map((dept: Project) => (
                    <SelectItem key={dept.id} value={dept.id}>
                      {dept.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Reports to</label>
              <Select
                value={draftParentId}
                onValueChange={setDraftParentId}
                disabled={!canManageRoles || selfFounderLock || saveMutation.isPending}
              >
                <SelectTrigger className="w-full" aria-label="Reports to">
                  <SelectValue placeholder="No manager" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No manager (root)</SelectItem>
                  {reportsToOptions.map((opt) => (
                    <SelectItem key={opt.userId} value={opt.userId}>
                      {opt.displayName ?? opt.email ?? opt.userId.slice(0, 8)}{" "}
                      <span className="text-muted-foreground">({ROLE_LABELS[opt.role]})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selfFounderLock && (
              <div className="rounded-lg border border-border bg-muted/25 p-3">
                <p className="text-sm text-muted-foreground">
                  Your founder role is locked because this company needs at least one founder. Add or promote another
                  founder before changing your own role hierarchy.
                </p>
              </div>
            )}

            {!canManageRoles && (
              <div className="rounded-lg border border-border bg-muted/25 p-3">
                <p className="text-sm text-muted-foreground">
                  You don't have permission to manage roles. Contact a founder or system admin.
                </p>
              </div>
            )}
          </DialogBody>
          <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRoleDialogOpen(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={!hasChanges || selfFounderLock || saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={profileDialogOpen}
        onOpenChange={(open) => {
          setProfileDialogOpen(open);
          if (!open) resetProfileDraftFromMember();
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0 px-6 pt-4 pb-2">
            <DialogTitle>Edit Profile</DialogTitle>
            <DialogDescription className="sr-only">
              Update this person's profile details.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pt-2 pb-4">
            <div className="rounded-lg border border-border bg-muted/25 p-4">
              <div className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <Avatar
                    shape="squircle"
                    className="h-16 w-16 border border-border bg-accent text-lg shadow-sm"
                  >
                    {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={displayName} />}
                    <AvatarFallback className="bg-accent text-foreground font-semibold">{initials}</AvatarFallback>
                  </Avatar>
                  <input
                    ref={avatarInputRef}
                    id="human-avatar"
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    aria-label="Change avatar"
                    disabled={!canEditProfile || avatarUploadMutation.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setAvatarFileDirty(true);
                      if (file) avatarUploadMutation.mutate(file);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="absolute -bottom-2 -right-2 h-7 w-7 rounded-md border border-border shadow-sm"
                    disabled={!canEditProfile || avatarUploadMutation.isPending}
                    aria-label="Choose avatar image"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </Button>
                  {canRemoveAvatar && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute -left-2 -top-2 h-6 w-6 rounded-md border border-border bg-card shadow-sm"
                      disabled={!canEditProfile || removeAvatarMutation.isPending}
                      onClick={() => removeAvatarMutation.mutate()}
                      aria-label="Remove avatar"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">{displayName}</p>
                  <p className="text-xs text-muted-foreground">{member.email ?? "No email"}</p>
                </div>
                <div className="ml-auto">
                  {!canEditProfile && <Badge variant="outline" className="text-[10px]">Read only</Badge>}
                  {avatarUploadMutation.isPending && <Badge variant="outline" className="text-[10px]">Uploading</Badge>}
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="human-display-name" className="text-xs font-medium text-muted-foreground">Display name</label>
                <input
                  id="human-display-name"
                  className={FIELD_CLASS}
                  value={profileDraft.displayName ?? ""}
                  disabled={!canEditProfile || saveProfileMutation.isPending}
                  onChange={(event) => {
                    setProfileDraftDirty(true);
                    setProfileDraft((current) => ({ ...current, displayName: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="human-title" className="text-xs font-medium text-muted-foreground">Title</label>
                <select
                  id="human-title"
                  className={FIELD_CLASS}
                  value={profileDraft.title ?? ""}
                  disabled={!canEditProfile || saveProfileMutation.isPending}
                  onChange={(event) => {
                    setProfileDraftDirty(true);
                    setProfileDraft((current) => ({ ...current, title: event.target.value || null }));
                  }}
                >
                  <option value="">No title</option>
                  {titleOptions.map((title) => (
                    <option key={title} value={title}>{title}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="human-location" className="text-xs font-medium text-muted-foreground">Location</label>
                <input
                  id="human-location"
                  className={FIELD_CLASS}
                  value={profileDraft.location ?? ""}
                  disabled={!canEditProfile || saveProfileMutation.isPending}
                  onChange={(event) => {
                    setProfileDraftDirty(true);
                    setProfileDraft((current) => ({ ...current, location: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="human-timezone" className="text-xs font-medium text-muted-foreground">Timezone</label>
                <select
                  id="human-timezone"
                  className={FIELD_CLASS}
                  value={profileDraft.timezone ?? ""}
                  disabled={!canEditProfile || saveProfileMutation.isPending}
                  onChange={(event) => {
                    setProfileDraftDirty(true);
                    setProfileDraft((current) => ({ ...current, timezone: event.target.value || null }));
                  }}
                >
                  <option value="">No timezone</option>
                  {timezoneOptions.map((timezone) => (
                    <option key={timezone} value={timezone}>{timezone}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="human-bio" className="text-xs font-medium text-muted-foreground">Bio</label>
              <textarea
                id="human-bio"
                className={TEXTAREA_CLASS}
                value={profileDraft.bio ?? ""}
                disabled={!canEditProfile || saveProfileMutation.isPending}
                onChange={(event) => {
                  setProfileDraftDirty(true);
                  setProfileDraft((current) => ({ ...current, bio: event.target.value }));
                }}
              />
            </div>

            <div className="space-y-3">
              {(profileDraft.socialLinks ?? []).map((link, index) => (
                <div key={index} className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,2fr)_auto]">
                  <div className="space-y-1.5">
                    <label htmlFor={`human-social-type-${index}`} className="text-xs font-medium text-muted-foreground">Type</label>
                    <select
                      id={`human-social-type-${index}`}
                      className={FIELD_CLASS}
                      value={link.type}
                      disabled={!canEditProfile || saveProfileMutation.isPending}
                      onChange={(event) => updateSocialLink(index, { type: event.target.value as HumanSocialLinkType })}
                    >
                      {HUMAN_SOCIAL_LINK_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`human-social-label-${index}`} className="text-xs font-medium text-muted-foreground">Label</label>
                    <input
                      id={`human-social-label-${index}`}
                      className={FIELD_CLASS}
                      value={link.label ?? ""}
                      disabled={!canEditProfile || saveProfileMutation.isPending}
                      onChange={(event) => updateSocialLink(index, { label: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`human-social-url-${index}`} className="text-xs font-medium text-muted-foreground">URL</label>
                    <input
                      id={`human-social-url-${index}`}
                      className={FIELD_CLASS}
                      value={link.url}
                      disabled={!canEditProfile || saveProfileMutation.isPending}
                      onChange={(event) => updateSocialLink(index, { url: event.target.value })}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!canEditProfile || saveProfileMutation.isPending}
                      onClick={() => {
                        setProfileDraftDirty(true);
                        setProfileDraft((current) => ({
                          ...current,
                          socialLinks: (current.socialLinks ?? []).filter((_, i) => i !== index),
                        }));
                      }}
                      aria-label="Remove social link"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEditProfile || saveProfileMutation.isPending}
                onClick={() => {
                  setProfileDraftDirty(true);
                  setProfileDraft((current) => ({
                    ...current,
                    socialLinks: [...(current.socialLinks ?? []), { type: "website", label: null, url: "" }],
                  }));
                }}
              >
                Add Social Link
              </Button>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setProfileDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={saveProfile}
              disabled={!canEditProfile || saveProfileMutation.isPending}
            >
              {saveProfileMutation.isPending ? "Saving..." : "Save Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newCapabilityOpen}
        onOpenChange={(open) => {
          setNewCapabilityOpen(open);
          if (!open) {
            setNewCapabilityTitle("");
            setNewCapabilityFilename("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Document</DialogTitle>
            <DialogDescription className="sr-only">
              Add a custom markdown capability document.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="capability-title" className="text-xs font-medium text-muted-foreground">Title</label>
              <input
                id="capability-title"
                className={FIELD_CLASS}
                value={newCapabilityTitle}
                onChange={(event) => setNewCapabilityTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="capability-filename" className="text-xs font-medium text-muted-foreground">Filename</label>
              <input
                id="capability-filename"
                className={FIELD_CLASS}
                value={newCapabilityFilename}
                placeholder="portfolio.md"
                onChange={(event) => setNewCapabilityFilename(event.target.value)}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewCapabilityOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!newCapabilityFilename.trim() || createCapabilityMutation.isPending}
              onClick={() => createCapabilityMutation.mutate()}
            >
              Add Document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar items={TAB_ITEMS} value={activeTab} onValueChange={handleTabChange} />

        {/* ── Overview Tab ── */}
        {activeTab === "overview" && deps && (
          <div className="space-y-4 mt-4">
            {/* Metric cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-border bg-card">
                <MetricCard icon={Users} value={deps.teamMembers.length} label="Reports" />
              </div>
              <div className="rounded-lg border border-border bg-card">
                <MetricCard icon={Bot} value={deps.agentTrees.length} label="Agents" />
              </div>
              <div className="rounded-lg border border-border bg-card">
                <MetricCard icon={ClipboardList} value={deps.assignedTaskCount} label="Assigned Tasks" />
              </div>
              <div className="rounded-lg border border-border bg-card">
                <MetricCard icon={FileText} value={deps.createdTaskCount} label="Created Tasks" />
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <TaskListSection
                title="Responsible Tasks"
                icon={Shield}
                tasks={responsibleTasksQuery.data ?? []}
                isLoading={responsibleTasksQuery.isLoading}
                empty="No tasks owned by this person."
              />
              <TaskListSection
                title="Assigned Tasks"
                icon={ClipboardList}
                tasks={assignedTasksQuery.data ?? []}
                isLoading={assignedTasksQuery.isLoading}
                empty="No tasks assigned directly to this person."
              />
              <TaskListSection
                title="Created Tasks"
                icon={FileText}
                tasks={createdTasksQuery.data ?? []}
                isLoading={createdTasksQuery.isLoading}
                empty="No tasks created by this person."
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <TaskListSection
                title="Agent Tree Tasks"
                icon={Bot}
                tasks={agentTasksQuery.data ?? []}
                isLoading={agentTasksQuery.isLoading}
                empty="No active tasks assigned to this person's agent tree."
              />
              <ActivitySection
                events={activityQuery.data ?? []}
                isLoading={activityQuery.isLoading}
              />
            </div>

            {/* Team Reports */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Users className="h-4 w-4" />
                Team Reports ({deps.teamMembers.length})
              </h3>
              {deps.teamMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No team members reporting to this person.</p>
              ) : (
                <div className="space-y-1">
                  {deps.teamMembers.map((tm) => (
                    <Link
                      key={tm.userId}
                      to={`/team/${tm.userId}`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
                    >
                      <Identity
                        name={tm.displayName ?? tm.email ?? tm.userId.slice(0, 8)}
                        size="sm"
                      />
                      <Badge variant="secondary" className={cn("border-0 text-[10px] ml-auto", ROLE_STYLES[tm.role])}>
                        {ROLE_LABELS[tm.role] ?? tm.role}
                      </Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Agent trees */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Bot className="h-4 w-4" />
                Agents ({deps.agentTrees.length})
              </h3>
              {deps.agentTrees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agents reporting to this person.</p>
              ) : (
                <div className="space-y-1">
                  {deps.agentTrees.map((tree) => (
                    <Link
                      key={tree.rootAgentId}
                      to={`/agents/${tree.rootAgentId}`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
                    >
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium">{tree.rootAgentName}</span>
                      {tree.subAgentCount > 0 && (
                        <span className="text-muted-foreground text-xs">(+{tree.subAgentCount} sub-agents)</span>
                      )}
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-auto" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "workload" && (
          <div className="space-y-4 mt-4">
            {workloadQuery.isLoading ? (
              <PageSkeleton />
            ) : !workloadQuery.data ? (
              <EmptyState
                icon={ClipboardList}
                message="No workload data"
                description="Workload could not be loaded."
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <div className="rounded-lg border border-border bg-card">
                    <MetricCard
                      icon={Shield}
                      value={workloadQuery.data.summary.responsibleOpenTaskCount}
                      label="Responsible"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-card">
                    <MetricCard
                      icon={ClipboardList}
                      value={workloadQuery.data.summary.assignedOpenTaskCount}
                      label="Assigned"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-card">
                    <MetricCard
                      icon={Bot}
                      value={workloadQuery.data.summary.managedAgentCount}
                      label="Managed Agents"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-card">
                    <MetricCard
                      icon={ClipboardList}
                      value={workloadQuery.data.summary.managedAgentOpenTaskCount}
                      label="Agent Tasks"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-card">
                    <MetricCard
                      icon={Activity}
                      value={workloadQuery.data.summary.attentionCount}
                      label="Needs Attention"
                    />
                  </div>
                </div>

                <section className="rounded-xl border border-border bg-card p-4">
                  <h3 className="mb-3 text-sm font-semibold">Needs Attention</h3>
                  {workloadQuery.data.attentionItems.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No blocked or review tasks need attention.</p>
                  ) : (
                    <div className="space-y-1">
                      {workloadQuery.data.attentionItems.map((item) => (
                        <button
                          type="button"
                          key={`${item.source}:${item.taskId}`}
                          aria-label={`Open ${item.title}`}
                          onClick={() => handleOpenTask(item.taskId)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors text-inherit"
                        >
                          <span className="min-w-0 truncate font-medium">{item.title}</span>
                          <Badge variant="outline" className="capitalize">{displayIssueStatus(item.status)}</Badge>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <div className="grid gap-4 xl:grid-cols-2">
                  <WorkloadSection
                    title="Responsible Tasks"
                    tasks={workloadQuery.data.responsibleTasks}
                    empty="No open tasks owned by this person."
                    onOpenTask={handleOpenTask}
                  />
                  <WorkloadSection
                    title="Assigned Tasks"
                    tasks={workloadQuery.data.assignedTasks}
                    empty="No open tasks assigned directly to this person."
                    onOpenTask={handleOpenTask}
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <WorkloadSection
                    title="Managed-Agent Tasks"
                    tasks={workloadQuery.data.managedAgentTasks}
                    empty="No open tasks assigned to this person's managed agents."
                    onOpenTask={handleOpenTask}
                  />
                  <section className="rounded-xl border border-border bg-card p-4">
                    <h3 className="mb-3 text-sm font-semibold">Managed Agents</h3>
                    {workloadQuery.data.managedAgents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No managed agents.</p>
                    ) : (
                      <div className="space-y-1">
                        {workloadQuery.data.managedAgents.map((agent) => (
                          <Link
                            key={agent.id}
                            to={`/agents/${agent.id}`}
                            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
                          >
                            <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                            <Badge variant="outline">{agent.openTaskCount} open</Badge>
                          </Link>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}
          </div>
        )}

        {/* Capabilities Tab */}
        {activeTab === "capabilities" && (
          <div className="mt-4 grid gap-4 lg:h-[calc(100vh-18rem)] lg:min-h-[34rem] lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-stretch">
            <section
              data-testid="capabilities-document-list"
              className="flex min-h-[22rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
            >
              <div
                data-testid="capabilities-document-list-header"
                className="flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-border px-4"
              >
                <h3 className="text-sm font-semibold">Documents</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add document"
                  disabled={!canEditProfile}
                  onClick={() => setNewCapabilityOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {capabilitiesQuery.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Loading...</p>
              ) : capabilityDocuments.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No capability documents yet.</p>
              ) : (
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
                  {capabilityDocuments.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={cn(
                        "flex w-full min-w-0 flex-col rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors hover:border-muted-foreground/30 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        selectedCapability?.id === doc.id && "border-border bg-accent text-accent-foreground shadow-sm",
                      )}
                      onClick={() => setSelectedCapabilityId(doc.id)}
                    >
                      <span className="truncate font-medium">{doc.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{doc.filename}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section
              data-testid="capabilities-document-detail"
              className="min-h-[22rem] min-w-0 overflow-hidden rounded-xl border border-border bg-card"
            >
              {!selectedCapability ? (
                <p className="p-4 text-sm text-muted-foreground">Select a capability document.</p>
              ) : (
                <div className="flex h-full min-h-[24rem] flex-col">
                  <div
                    data-testid="capabilities-document-detail-header"
                    className="flex h-[42px] shrink-0 items-center justify-between gap-3 border-b border-border px-4"
                  >
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold leading-tight">{selectedCapability.title}</h3>
                      <p className="truncate text-xs leading-tight text-muted-foreground">{selectedCapability.filename}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {capabilityEditing ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={updateCapabilityMutation.isPending}
                            onClick={() => {
                              setCapabilityDraft(selectedCapability.content);
                              setCapabilityEditing(false);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={updateCapabilityMutation.isPending}
                            onClick={() => updateCapabilityMutation.mutate({
                              documentId: selectedCapability.id,
                              content: capabilityDraft,
                            })}
                          >
                            Save document
                          </Button>
                        </>
                      ) : (
                        <>
                          {!selectedCapability.isStandard && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete document"
                              disabled={!canEditProfile || deleteCapabilityMutation.isPending}
                              onClick={() => deleteCapabilityMutation.mutate(selectedCapability.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!canEditProfile}
                            onClick={() => setCapabilityEditing(true)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit document
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-4">
                    {capabilityEditing ? (
                      <textarea
                        aria-label="Capability markdown"
                        className="h-full min-h-[20rem] w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={capabilityDraft}
                        onChange={(event) => setCapabilityDraft(event.target.value)}
                      />
                    ) : selectedCapability.content.trim() ? (
                      <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                        {selectedCapability.content}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground">This document is ready to fill in.</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* Roles Tab */}
        {activeTab === "roles" && deps && (
          <div className="space-y-4 mt-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Authority
                </h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRoleDialogOpen(true)}
                  className="shrink-0"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit roles
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Role</p>
                  <p className="mt-1 text-sm">{ROLE_LABELS[member.role]}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Department</p>
                  <p className="mt-1 text-sm">{member.departmentName ?? "No department"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Reports to</p>
                  <p className="mt-1 text-sm">{manager?.displayName ?? manager?.email ?? "No manager"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Access</p>
                  <p className="mt-1 text-sm">{member.isSystemAdmin ? "System admin" : "Company member"}</p>
                </div>
              </div>
              <div className="mt-3">
                <p className="text-xs font-medium text-muted-foreground">Explicit grants</p>
                {member.permissions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {member.permissions.slice(0, 6).map((permission) => (
                      <Badge key={permission} variant="outline" className="max-w-full truncate text-[10px]">
                        {permission}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">No explicit grants</p>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Users className="h-4 w-4" />
                Responsibilities
              </h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">Reports</p>
                  <p className="mt-1 text-2xl font-semibold">{deps.teamMembers.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">Agents</p>
                  <p className="mt-1 text-2xl font-semibold">{deps.agentTrees.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">Manager</p>
                  <p className="mt-1 text-sm">{manager?.displayName ?? manager?.email ?? "No manager"}</p>
                </div>
              </div>
            </section>

            {selfFounderLock && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-sm text-muted-foreground">
                  Your founder role is locked because this company needs at least one founder. Add or promote another
                  founder before changing your own role hierarchy.
                </p>
              </div>
            )}

            {!canManageRoles && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-sm text-muted-foreground">
                  You don't have permission to manage roles. Contact a founder or system admin.
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <div className="space-y-4 mt-4">
            {/* Danger Zone */}
            {canRemove && (
              <div className="rounded-xl border border-destructive/30 bg-card p-5">
                <h3 className="text-sm font-semibold text-destructive mb-2">Danger Zone</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Removing this member will revoke their access to the company. Any tasks assigned to them will need to be reassigned.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setRemoveDialogOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove from Team
                </Button>
                <ReassignmentDialog
                  companyId={selectedCompanyId!}
                  member={member}
                  allMembers={teamSummary?.members ?? []}
                  open={removeDialogOpen}
                  onOpenChange={setRemoveDialogOpen}
                  onSuccess={() => navigate("/team?tab=humans")}
                />
              </div>
            )}

            {/* Read-only notice for non-admins */}
            {!canManageRoles && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="text-sm text-muted-foreground">
                  You don't have permission to manage roles. Contact a founder or system admin.
                </p>
              </div>
            )}
          </div>
        )}
      </Tabs>
      <TaskSlideOver
        issueId={selectedTaskId}
        open={Boolean(selectedTaskId)}
        onClose={handleCloseTask}
      />
    </div>
  );
}
