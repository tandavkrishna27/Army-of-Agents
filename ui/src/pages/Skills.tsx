// ui/src/pages/Skills.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillProjectScanResult,
  CompanySkillListItem,
} from "@armyofagents/shared";
import { Boxes, FolderOpen, Home, PanelLeftClose, PanelLeftOpen, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useRecentSkills } from "../hooks/useRecentSkills";
import { queryKeys } from "../lib/queryKeys";
import { derivePackagesForLibrary } from "../lib/skillPackages";
import { EmptyState } from "../components/EmptyState";
import { AddSkillModal } from "../components/skills/AddSkillModal";
import { DeleteSkillModal } from "../components/skills/DeleteSkillModal";
import { SkillLibrary } from "../components/skills/SkillLibrary";
import { SkillViewer } from "../components/skills/SkillViewer";
import { SkillPackageOverview } from "../components/skills/SkillPackageOverview";
import { SkillsHomeEmpty } from "../components/skills/SkillsHomeEmpty";

type RouteShape =
  | { kind: "home" }
  | { kind: "package"; packageId: string }
  | { kind: "skill"; skillId: string; filePath: string };

function encodeSkillFilePath(filePath: string): string {
  return filePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function decodeSkillFilePath(filePath: string | undefined): string {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

function parseSkillRoute(routePath: string | undefined): RouteShape {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) return { kind: "home" };
  if (segments[0] === "package" && segments.length >= 3) {
    return { kind: "package", packageId: `${segments[1]}/${segments[2]}` };
  }
  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) return { kind: "home" };
  if (rawMode === "files") {
    return { kind: "skill", skillId, filePath: decodeSkillFilePath(rest.join("/")) };
  }
  return { kind: "skill", skillId, filePath: "SKILL.md" };
}

function skillRoute(skillId: string, filePath?: string | null): string {
  return filePath
    ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}`
    : `/skills/${skillId}`;
}

function packageRoute(packageId: string): string {
  return `/skills/package/${packageId}`;
}

function skillSourceTitle(skill: CompanySkillListItem): string {
  return skill.sourceLabel ? `${skill.name} · ${skill.sourceLabel}` : skill.name;
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return { frontmatter: null, body: normalized };
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string): string {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function formatProjectScanSummary(result: CompanySkillProjectScanResult): string {
  const parts = [
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedWorkspaces} workspace${result.scannedWorkspaces === 1 ? "" : "s"}.`;
}

export function Skills() {
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const { recent, recordOpen } = useRecentSkills();

  const [skillFilter, setSkillFilter] = useState("");
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [deleteSkillOpen, setDeleteSkillOpen] = useState(false);
  const [expandedPackageIds, setExpandedPackageIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const route = useMemo(() => parseSkillRoute(routePath), [routePath]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const skills = skillsQuery.data ?? [];

  // Auto-expand the package containing the active skill
  useEffect(() => {
    if (route.kind !== "skill") return;
    const skill = skills.find((s) => s.id === route.skillId);
    const meta = skill?.metadata && typeof skill.metadata === "object" ? skill.metadata : null;
    const owner = typeof meta?.["owner"] === "string" ? (meta["owner"] as string) : null;
    const repo = typeof meta?.["repo"] === "string" ? (meta["repo"] as string) : null;
    if (!owner || !repo) return;
    const packageId = `${owner}/${repo}`;
    setExpandedPackageIds((cur) => {
      if (cur.has(packageId)) return cur;
      const next = new Set(cur);
      next.add(packageId);
      return next;
    });
  }, [route, skills]);

  // Breadcrumbs
  useEffect(() => {
    if (route.kind === "package") {
      setBreadcrumbs([{ label: "Skills", href: "/skills" }, { label: route.packageId }]);
    } else if (route.kind === "skill") {
      setBreadcrumbs([{ label: "Skills", href: "/skills" }, { label: "Detail" }]);
    } else {
      setBreadcrumbs([{ label: "Skills", href: "/skills" }]);
    }
  }, [route, setBreadcrumbs]);

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(
      selectedCompanyId ?? "",
      route.kind === "skill" ? route.skillId : "",
    ),
    queryFn: () =>
      route.kind === "skill"
        ? companySkillsApi.detail(selectedCompanyId!, route.skillId)
        : Promise.reject(new Error("not a skill route")),
    enabled: Boolean(selectedCompanyId) && route.kind === "skill",
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(
      selectedCompanyId ?? "",
      route.kind === "skill" ? route.skillId : "",
      route.kind === "skill" ? route.filePath : "",
    ),
    queryFn: () =>
      route.kind === "skill"
        ? companySkillsApi.file(selectedCompanyId!, route.skillId, route.filePath)
        : Promise.reject(new Error("not a skill route")),
    enabled: Boolean(selectedCompanyId) && route.kind === "skill" && Boolean(route.skillId),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.companySkills.updateStatus(
      selectedCompanyId ?? "",
      route.kind === "skill" ? route.skillId : "",
    ),
    queryFn: () =>
      route.kind === "skill"
        ? companySkillsApi.updateStatus(selectedCompanyId!, route.skillId)
        : Promise.reject(new Error("not a skill route")),
    enabled:
      Boolean(selectedCompanyId) &&
      route.kind === "skill" &&
      detailQuery.data?.sourceType === "github",
    staleTime: 60_000,
  });

  // Record recently-opened
  useEffect(() => {
    if (route.kind === "skill" && detailQuery.data) {
      recordOpen(detailQuery.data.id);
    }
  }, [route, detailQuery.data, recordOpen]);

  // ---- Mutations ----

  const importSkill = useMutation({
    mutationFn: (source: string) => companySkillsApi.importFromSource(selectedCompanyId!, source),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      if (result.imported[0]) navigate(skillRoute(result.imported[0].id));
      const refused = result.refusedCustomized ?? [];
      // T2.9 — an import that only hit skills with local edits changed nothing.
      // Saying "0 skills added" in a success toast would read as a no-op success.
      if (result.imported.length === 0 && refused.length > 0) {
        pushToast({
          tone: "warn",
          title: "Your edits were kept",
          body: `${refused.length} skill${refused.length === 1 ? "" : "s"} skipped — `
            + "delete and re-import to take the upstream version.",
        });
      } else {
        pushToast({
          tone: "success",
          title: "Skills imported",
          body: `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added.`,
        });
      }
      if (result.warnings[0])
        pushToast({ tone: "warn", title: "Import warnings", body: result.warnings[0] });
      setAddSkillOpen(false);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: error instanceof Error ? error.message : "Failed to import skill source.",
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) =>
      companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      navigate(skillRoute(skill.id));
      setAddSkillOpen(false);
      pushToast({
        tone: "success",
        title: "Skill created",
        body: `${skill.name} is now editable in the AoA workspace.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      pushToast({
        tone: "success",
        title: "Project skill scan complete",
        body: formatProjectScanSummary(result),
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Project skill scan failed",
        body: error instanceof Error ? error.message : "Failed to scan project workspaces.",
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: ({ draft }: { draft: string }) => {
      if (route.kind !== "skill") return Promise.reject(new Error("not a skill route"));
      return companySkillsApi.updateFile(
        selectedCompanyId!,
        route.skillId,
        route.filePath,
        fileQuery.data?.markdown ? mergeFrontmatter(fileQuery.data.content, draft) : draft,
      );
    },
    onSuccess: async (result: CompanySkillFileDetail) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.companySkills.list(selectedCompanyId!),
        }),
        route.kind === "skill" &&
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.detail(selectedCompanyId!, route.skillId),
          }),
        route.kind === "skill" &&
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.file(
              selectedCompanyId!,
              route.skillId,
              route.filePath,
            ),
          }),
      ]);
      pushToast({ tone: "success", title: "Skill saved", body: result.path });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save skill file.",
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => {
      if (route.kind !== "skill") return Promise.reject(new Error("not a skill route"));
      return companySkillsApi.installUpdate(selectedCompanyId!, route.skillId);
    },
    onSuccess: async (skill: CompanySkill) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      pushToast({ tone: "success", title: "Skill updated", body: skill.name });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to install skill update.",
      });
    },
  });

  const deleteSkill = useMutation({
    mutationFn: () => {
      if (route.kind !== "skill") return Promise.reject(new Error("not a skill route"));
      return companySkillsApi.delete(selectedCompanyId!, route.skillId);
    },
    onSuccess: async () => {
      setDeleteSkillOpen(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      const fallback = skills.find((s) => route.kind === "skill" && s.id !== route.skillId);
      navigate(fallback ? skillRoute(fallback.id) : "/skills", { replace: true });
      pushToast({ tone: "success", title: "Skill deleted" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Failed to delete skill.",
      });
    },
  });

  // ---- Bulk package actions (client-side fan-out) ----

  const updatePackage = useMutation({
    mutationFn: async (memberIds: string[]) => {
      const results = await Promise.allSettled(
        memberIds.map((id) => companySkillsApi.installUpdate(selectedCompanyId!, id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { total: memberIds.length, failed };
    },
    onSuccess: async ({ total, failed }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      pushToast({
        tone: failed === 0 ? "success" : "warn",
        title: failed === 0 ? "Package updated" : "Package partially updated",
        body: `${total - failed}/${total} skills updated`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to update package.",
      });
    },
  });

  const removePackage = useMutation({
    mutationFn: async (memberIds: string[]) => {
      const results = await Promise.allSettled(
        memberIds.map((id) => companySkillsApi.delete(selectedCompanyId!, id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { total: memberIds.length, failed };
    },
    onSuccess: async ({ total, failed }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(selectedCompanyId!),
      });
      navigate("/skills", { replace: true });
      pushToast({
        tone: failed === 0 ? "success" : "warn",
        title: failed === 0 ? "Package removed" : "Package partially removed",
        body: `${total - failed}/${total} skills removed`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Remove failed",
        body: error instanceof Error ? error.message : "Failed to remove package.",
      });
    },
  });

  // ---- Render ----

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  const { packages, standalones } = derivePackagesForLibrary(skills);
  const activePackage =
    route.kind === "package" ? packages.find((p) => p.id === route.packageId) ?? null : null;
  const activePackageMembers = activePackage
    ? skills.filter((s) => activePackage.memberSkillIds.includes(s.id))
    : [];

  return (
    <>
      <AddSkillModal
        open={addSkillOpen}
        onOpenChange={setAddSkillOpen}
        onImport={(s) => importSkill.mutate(s)}
        importPending={importSkill.isPending}
        onCreate={(payload) => createSkill.mutate(payload)}
        createPending={createSkill.isPending}
      />
      <DeleteSkillModal
        open={deleteSkillOpen}
        onOpenChange={setDeleteSkillOpen}
        skill={detailQuery.data}
        onConfirm={() => deleteSkill.mutate()}
        pending={deleteSkill.isPending}
      />

      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden bg-muted/30 p-2">
          <aside
            className={cn(
              "flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
              sidebarCollapsed ? "w-[48px]" : "w-[300px]",
            )}
          >
            <div className="flex h-[42px] shrink-0 items-center border-b border-border px-1">
              {!sidebarCollapsed && (
                <span className="flex-1 px-2 text-xs font-medium text-muted-foreground">
                  Library
                </span>
              )}
              <button
                type="button"
                onClick={() => setSidebarCollapsed((v) => !v)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )}
              </button>
            </div>
            {!sidebarCollapsed ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SkillLibrary
                  skills={skills}
                  filter={skillFilter}
                  selectedSkillId={route.kind === "skill" ? route.skillId : null}
                  selectedPackageId={route.kind === "package" ? route.packageId : null}
                  homeActive={route.kind === "home"}
                  expandedPackageIds={expandedPackageIds}
                  packagesWithUpdate={new Set()}
                  onTogglePackage={(packageId) => {
                    setExpandedPackageIds((cur) => {
                      const next = new Set(cur);
                      if (next.has(packageId)) next.delete(packageId);
                      else next.add(packageId);
                      return next;
                    });
                  }}
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
                <Link
                  to="/skills"
                  title="Home"
                  aria-label="Home"
                  aria-current={route.kind === "home" ? "page" : undefined}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground",
                    route.kind === "home" && "bg-accent text-accent-foreground",
                  )}
                >
                  <Home className="size-4" />
                </Link>
                {packages.length > 0 && <div className="my-1 h-px w-5 bg-border" aria-hidden />}
                {packages.map((pkg) => (
                  <Link
                    key={pkg.id}
                    to={packageRoute(pkg.id)}
                    title={`${pkg.name} package`}
                    aria-label={`${pkg.name} package`}
                    aria-current={
                      route.kind === "package" && route.packageId === pkg.id ? "page" : undefined
                    }
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground",
                      route.kind === "package" &&
                        route.packageId === pkg.id &&
                        "bg-accent text-accent-foreground",
                    )}
                  >
                    <Sparkles className="size-4" />
                  </Link>
                ))}
                {standalones.length > 0 && <div className="my-1 h-px w-5 bg-border" aria-hidden />}
                {standalones.map((skill) => (
                  <Link
                    key={skill.id}
                    to={skillRoute(skill.id)}
                    title={skillSourceTitle(skill)}
                    aria-label={skillSourceTitle(skill)}
                    aria-current={
                      route.kind === "skill" && route.skillId === skill.id ? "page" : undefined
                    }
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground",
                      route.kind === "skill" &&
                        route.skillId === skill.id &&
                        "bg-accent text-accent-foreground",
                    )}
                  >
                    <FolderOpen className="size-4" />
                  </Link>
                ))}
              </div>
            )}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            {/* Toolbar — lives in the right pane so the sidebar runs full-height */}
            <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border px-4">
              <span className="shrink-0 text-sm font-semibold text-foreground">
                Skills Library
              </span>
              <div className="flex-1" />
              <div className="relative w-56">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  value={skillFilter}
                  onChange={(e) => setSkillFilter(e.target.value)}
                  placeholder="Filter skills…"
                  className="h-7 w-full rounded-md border border-border bg-transparent pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </header>

            <div className="flex-1 overflow-y-auto">
            {route.kind === "package" && activePackage ? (
              <SkillPackageOverview
                pkg={activePackage}
                members={activePackageMembers}
                membersWithUpdate={new Set()}
                totalUsedByAgents={activePackageMembers.reduce(
                  (sum, m) => sum + m.attachedAgentCount,
                  0,
                )}
                onUpdateAll={() => updatePackage.mutate(activePackage.memberSkillIds)}
                onRemovePackage={() => removePackage.mutate(activePackage.memberSkillIds)}
                updateAllPending={updatePackage.isPending}
                removePending={removePackage.isPending}
              />
            ) : route.kind === "skill" && detailQuery.data ? (
              <SkillViewer
                detail={detailQuery.data}
                file={fileQuery.data ?? null}
                fileLoading={fileQuery.isLoading}
                selectedPath={route.filePath}
                updateStatus={updateStatusQuery.data}
                onSelectPath={(path) => {
                  if (route.kind === "skill") navigate(skillRoute(route.skillId, path));
                }}
                onCheckUpdates={() => {
                  void updateStatusQuery.refetch();
                }}
                onInstallUpdate={() => installUpdate.mutate()}
                checkUpdatesPending={updateStatusQuery.isFetching}
                installUpdatePending={installUpdate.isPending}
                onSave={(draft) => saveFile.mutate({ draft })}
                savePending={saveFile.isPending}
                onDelete={() => setDeleteSkillOpen(true)}
              />
            ) : (
              <SkillsHomeEmpty
                skills={skills}
                recent={recent}
                onAddSkill={() => setAddSkillOpen(true)}
                onScanSkills={() => scanProjects.mutate()}
                scanPending={scanProjects.isPending}
              />
            )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
