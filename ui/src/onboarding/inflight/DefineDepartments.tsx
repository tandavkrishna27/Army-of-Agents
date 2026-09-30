import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, X } from "lucide-react";
import { DEPARTMENT_FUNCTION_TYPES, isGitHubRepoUrl } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import { companiesApi } from "../../api/companies";
import { companyWorkspaceFsApi } from "../../api/filesystem";
import { Button } from "@/components/ui/button";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { cn } from "@/lib/utils";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "../steps/shared";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

/** Minimal shape used for the idempotency lookup — deliberately loose (not the
 * full `@armyofagents/shared` `Project`) so mocked test fixtures don't need
 * every field. */
type ProjectSummary = { id: string; type?: string; name?: string };

type DeptStatus = "idle" | "creating" | "created" | "error";

type DeptDraft = {
  /** Stable local key — NOT the server project id (that's `createdProjectId`,
   * only known once the department is created). */
  key: string;
  name: string;
  functionType: string;
  useLocal: boolean;
  useRepo: boolean;
  localPath: string;
  repoUrl: string;
  /** Once true, the auto-prefill-from-company-root effect stops touching
   * `localPath` for this department (the user (or a folder-browse pick)
   * took over). */
  pathManuallyEdited: boolean;
  status: DeptStatus;
  error: string | null;
  /** Set once the project exists server-side — carried across retries so a
   * retry never re-creates the project, only resumes the workspace step. */
  createdProjectId: string | null;
};

function slugify(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const isAbsolute = (v: string) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v);
function nestedPath(root: string, name: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${sep}${slugify(name)}`;
}

let localKeySeq = 0;
function nextLocalKey(): string {
  localKeySeq += 1;
  return `dept-local-${localKeySeq}`;
}

function makeDept(partial: Partial<DeptDraft> & { name: string; functionType: string }): DeptDraft {
  return {
    key: nextLocalKey(),
    useLocal: false,
    useRepo: false,
    localPath: "",
    repoUrl: "",
    pathManuallyEdited: false,
    status: "idle",
    error: null,
    createdProjectId: null,
    ...partial,
  };
}

export type DefineDepartmentsProps = {
  companyId: string;
  onDone: () => void;
};

/**
 * WS4 — the In-flight "Define departments" surface. NOT a FlowEngine wizard
 * step (WS0c moved Department off the wizard onto Home's In-flight persona
 * tail — see `ui/src/onboarding/steps/DepartmentStep.tsx`'s header comment).
 * This component is domain-only: it creates projects/workspaces and never
 * calls `advanceOnboarding` — there is intentionally no import of it here.
 *
 * Partial-failure semantics (Codex P2, plan §WS4): creation is per-department
 * (project created before mkdir/workspace), so a mid-sequence failure only
 * marks THAT department `error` with a Retry action — it doesn't fail the
 * whole surface, and it doesn't re-create a department that already exists
 * server-side (`createdProjectId` idempotency carries across retries).
 * `onDone` fires only once every department reaches `status: "created"`.
 */
export function DefineDepartments({ companyId, onDone }: DefineDepartmentsProps) {
  const [departments, setDepartments] = useState<DeptDraft[]>(() => [
    makeDept({ name: "Software", functionType: "software_development", useLocal: true }),
  ]);
  const [rootFolder, setRootFolder] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [browserForKey, setBrowserForKey] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  /** Always-current mirror of `departments`, read inside `submitAll`'s
   * sequential loop so each department's turn uses LIVE field values, never
   * a snapshot frozen at the start of the whole submit.
   *
   * Synced DURING render (the `useLatest` pattern), NOT via a passive effect.
   * `submitAll` reads `departmentsRef.current` from a click handler; a passive
   * `useEffect` sync lags one commit behind, so a handler could observe a
   * stale row even when the committed DOM the caller just gated on is current
   * — e.g. a not-yet-prefilled `localPath` (→ the workspace step throws
   * "must be an absolute path" and `onDone` never fires) or a status still
   * "idle" after a prior submit already flipped it to "created" (→ the
   * department gets re-created). Assigning during render keeps the mirror
   * consistent with the render being committed, removing that settle race. */
  const departmentsRef = useRef<DeptDraft[]>(departments);
  departmentsRef.current = departments;

  /** Guards against `onDone` firing more than once in a mounted lifecycle —
   * e.g. the founder clicking Continue again after every department already
   * reached `status: "created"`. */
  const doneFiredRef = useRef(false);
  function fireOnDoneOnce() {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    onDone();
  }

  useEffect(() => {
    if (!companyId) return;
    companiesApi
      .get(companyId)
      .then((c) => setRootFolder((c as { rootFolder?: string | null }).rootFolder ?? null))
      .catch(() => {});
  }, [companyId]);

  // Prefill each software department's local folder under the company root
  // once it resolves — mirrors DepartmentStep's nested-folder prefill, but
  // applies to every department that hasn't had its path manually edited.
  useEffect(() => {
    if (!rootFolder) return;
    setDepartments((prev) =>
      prev.map((d) =>
        d.useLocal && !d.pathManuallyEdited && d.name.trim()
          ? { ...d, localPath: nestedPath(rootFolder, d.name) }
          : d,
      ),
    );
  }, [rootFolder]);

  function updateDeptName(key: string, name: string) {
    setDepartments((prev) =>
      prev.map((d) => {
        if (d.key !== key) return d;
        const next = { ...d, name };
        if (d.useLocal && !d.pathManuallyEdited && rootFolder) {
          next.localPath = nestedPath(rootFolder, name);
        }
        return next;
      }),
    );
  }

  function updateDeptFunctionType(key: string, functionType: string) {
    setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, functionType } : d)));
  }

  function toggleUseLocal(key: string) {
    setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, useLocal: !d.useLocal } : d)));
  }

  function toggleUseRepo(key: string) {
    setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, useRepo: !d.useRepo } : d)));
  }

  function updateLocalPath(key: string, value: string, manual = true) {
    setDepartments((prev) =>
      prev.map((d) => (d.key === key ? { ...d, localPath: value, pathManuallyEdited: manual } : d)),
    );
  }

  function updateRepoUrl(key: string, value: string) {
    setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, repoUrl: value } : d)));
  }

  function addDepartment() {
    setDepartments((prev) => [...prev, makeDept({ name: "", functionType: "general" })]);
  }

  function removeDepartment(key: string) {
    setDepartments((prev) => (prev.length <= 1 ? prev : prev.filter((d) => d.key !== key)));
  }

  /** Create (or resume creating) a single department. Idempotent: reuses an
   * existing same-named project, and never re-creates a project once
   * `createdProjectId` is known (even across a failed-then-retried run). */
  async function createDepartment(
    dept: DeptDraft,
  ): Promise<Pick<DeptDraft, "status" | "error" | "createdProjectId">> {
    let deptId = dept.createdProjectId;
    const isSoftware = dept.functionType === "software_development";
    try {
      if (isSoftware && dept.useRepo && !dept.repoUrl.trim()) {
        throw new Error("Please enter a GitHub repository URL.");
      }
      if (isSoftware && dept.useRepo && dept.repoUrl.trim() && !isGitHubRepoUrl(dept.repoUrl.trim())) {
        throw new Error("Please enter a valid GitHub repository URL.");
      }

      if (!deptId) {
        const existing = (await projectsApi.list(companyId).catch(() => [])) as ProjectSummary[];
        deptId = existing.find((p) => p.type === "department" && p.name === dept.name.trim())?.id ?? null;
      }

      if (!deptId) {
        const created = await projectsApi.create(companyId, {
          name: dept.name.trim(),
          type: "department",
          status: "planned",
          functionType: dept.functionType,
        });
        deptId = (created as ProjectSummary).id;
      }

      if (isSoftware && (dept.useLocal || dept.useRepo)) {
        if (dept.useLocal && !isAbsolute(dept.localPath.trim())) {
          throw new Error("Local folder must be an absolute path.");
        }
        const workspaces = await projectsApi.listWorkspaces(deptId, companyId);
        if (workspaces.length === 0) {
          if (dept.useLocal) {
            try {
              await companyWorkspaceFsApi(companyId).mkdir(dept.localPath.trim());
            } catch (mkErr) {
              throw new Error(
                mkErr instanceof Error
                  ? `Couldn't create the folder "${dept.localPath.trim()}": ${mkErr.message}`
                  : `Couldn't create the folder "${dept.localPath.trim()}".`,
              );
            }
          }
          if (dept.useLocal && dept.useRepo) {
            await projectsApi.createWorkspace(
              deptId,
              { name: dept.name.trim(), cwd: dept.localPath.trim(), repoUrl: dept.repoUrl.trim() },
              companyId,
            );
          } else if (dept.useLocal) {
            await projectsApi.createWorkspace(
              deptId,
              { name: dept.name.trim(), cwd: dept.localPath.trim() },
              companyId,
            );
          } else if (dept.useRepo) {
            await projectsApi.createWorkspace(
              deptId,
              { name: dept.name.trim(), cwd: REPO_ONLY_CWD_SENTINEL, repoUrl: dept.repoUrl.trim() },
              companyId,
            );
          }
        }
      }

      return { status: "created", error: null, createdProjectId: deptId };
    } catch (e) {
      return {
        status: "error",
        error: e instanceof Error ? e.message : "Failed to create this department.",
        createdProjectId: deptId,
      };
    }
  }

  async function retryDepartment(key: string) {
    const dept = departments.find((d) => d.key === key);
    if (!dept) return;
    setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, status: "creating", error: null } : d)));
    const result = await createDepartment(dept);
    setDepartments((prev) => {
      const updated = prev.map((d) => (d.key === key ? { ...d, ...result } : d));
      if (updated.every((d) => d.status === "created")) fireOnDoneOnce();
      return updated;
    });
  }

  const hasBlockingIssue = departments.some((d) => {
    if (!d.name.trim()) return true;
    if (d.functionType === "software_development" && d.useRepo) {
      const url = d.repoUrl.trim();
      if (!url || !isGitHubRepoUrl(url)) return true;
    }
    return false;
  });

  async function submitAll() {
    if (submitting || hasBlockingIssue) return;
    setGlobalError(null);
    setSubmitting(true);
    // Fixed set of keys to process this run — stable even though the
    // underlying department rows keep changing (input fields stay editable
    // during submit; see disabled={submitting} below for the UX guard).
    const keys = departments.map((d) => d.key);
    const results: Array<Pick<DeptDraft, "status" | "error" | "createdProjectId">> = [];
    for (const key of keys) {
      // Read LIVE state right before this department's turn — never a copy
      // frozen at the top of submitAll — so an edit made while an earlier
      // department is still being created (a) is what actually gets sent to
      // the server for THIS department, and (b) never gets silently
      // reverted by the write-back below (which only merges status/error/
      // createdProjectId, not the whole row).
      const live = departmentsRef.current.find((d) => d.key === key);
      if (!live) continue;
      if (live.status === "created") {
        results.push({ status: live.status, error: live.error, createdProjectId: live.createdProjectId });
        continue;
      }
      const toCreate: DeptDraft = { ...live, status: "creating", error: null };
      setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, status: "creating", error: null } : d)));
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: per-department idempotency lookups must not race each other.
      const result = await createDepartment(toCreate);
      results.push(result);
      setDepartments((prev) => prev.map((d) => (d.key === key ? { ...d, ...result } : d)));
    }
    setSubmitting(false);
    const allCreated = results.every((d) => d.status === "created");
    if (allCreated) {
      fireOnDoneOnce();
    } else {
      setGlobalError("Some departments couldn't be created — fix and retry them below.");
    }
  }

  const browsingDept = departments.find((d) => d.key === browserForKey) ?? null;

  return (
    <StepShell className="max-w-lg">
      <Reveal>
        <StepHeading
          title={
            <>
              Shape your <GradientText>departments</GradientText>
            </>
          }
          subtitle="Each one becomes a brain and a worker. Start with Software — add more anytime."
        />
      </Reveal>

      <div className="flex flex-col gap-3">
        {departments.map((dept, i) => {
          const isSoftware = dept.functionType === "software_development";
          return (
            <Reveal key={dept.key} delay={0.09 + i * 0.09}>
              <StepCard className={cn(isSoftware && i === 0 && "border-brand")}>
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`dept-name-${dept.key}`}>
                    Department name
                  </label>
                  <input
                    id={`dept-name-${dept.key}`}
                    className={cn(FIELD, "flex-1")}
                    placeholder="Department name"
                    value={dept.name}
                    disabled={submitting}
                    onChange={(e) => updateDeptName(dept.key, e.target.value)}
                  />
                  {i === 0 && <span className="shrink-0 rounded-full border border-border-strong px-2 py-1 text-[10px] text-dim">default</span>}
                  {departments.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove ${dept.name.trim() || "department"}`}
                      className="shrink-0 rounded-md p-1.5 text-dim hover:text-text"
                      disabled={submitting}
                      onClick={() => removeDepartment(dept.key)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  {DEPARTMENT_FUNCTION_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      className={cn(
                        "rounded-md border px-2 py-2 text-left text-xs",
                        dept.functionType === t.value
                          ? "border-brand bg-card-2 text-text"
                          : "border-border-strong text-dim hover:bg-card-2/60",
                      )}
                      disabled={submitting}
                      onClick={() => updateDeptFunctionType(dept.key, t.value)}
                    >
                      <span className="mr-1">{t.icon}</span>
                      {t.label}
                    </button>
                  ))}
                </div>

                {isSoftware && (
                  <div className="mt-3 space-y-2 rounded-md border border-border-strong p-3">
                    <label className="flex items-center gap-2 text-xs text-dim">
                      <input
                        type="checkbox"
                        checked={dept.useLocal}
                        disabled={submitting}
                        onChange={() => toggleUseLocal(dept.key)}
                      />
                      Local folder (nested under your root)
                    </label>
                    {dept.useLocal && (
                      <div className="flex gap-2">
                        <input
                          aria-label={`Local folder path for ${dept.name.trim() || "this department"}`}
                          className={cn(FIELD, "font-mono text-xs")}
                          value={dept.localPath}
                          disabled={submitting}
                          onChange={(e) => updateLocalPath(dept.key, e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          disabled={submitting}
                          onClick={() => setBrowserForKey(dept.key)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                          Browse
                        </Button>
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-xs text-dim">
                      <input
                        type="checkbox"
                        checked={dept.useRepo}
                        disabled={submitting}
                        onChange={() => toggleUseRepo(dept.key)}
                      />
                      GitHub repo
                    </label>
                    {dept.useRepo && (
                      <input
                        aria-label={`Repository URL for ${dept.name.trim() || "this department"}`}
                        className={cn(FIELD, "text-xs")}
                        value={dept.repoUrl}
                        disabled={submitting}
                        onChange={(e) => updateRepoUrl(dept.key, e.target.value)}
                        placeholder="https://github.com/org/repo"
                      />
                    )}
                    {dept.useRepo && dept.repoUrl.trim() && !isGitHubRepoUrl(dept.repoUrl.trim()) && (
                      <p className="text-xs text-destructive">Enter a valid GitHub repository URL.</p>
                    )}
                  </div>
                )}

                {dept.status === "error" && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2">
                    <p className="text-xs text-destructive">{dept.error}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => void retryDepartment(dept.key)}>
                      Retry
                    </Button>
                  </div>
                )}
                {dept.status === "created" && (
                  <p className="mt-2 text-xs" style={{ color: "var(--done)" }}>
                    Created
                  </p>
                )}
              </StepCard>
            </Reveal>
          );
        })}

        <Reveal delay={0.09 + departments.length * 0.09}>
          <button
            type="button"
            className={cn(LABEL, "self-start rounded-md border border-border-strong px-3 py-1.5 text-xs text-dim hover:text-text")}
            disabled={submitting}
            onClick={addDepartment}
          >
            <Plus className="mr-1 inline h-3 w-3" aria-hidden />
            Add department
          </button>
        </Reveal>
      </div>

      {globalError && <p className="text-xs text-destructive">{globalError}</p>}

      <Reveal delay={0.18 + departments.length * 0.09}>
        <Button className="w-full" onClick={() => void submitAll()} disabled={submitting || hasBlockingIssue}>
          {submitting ? "Creating…" : "Continue"}
        </Button>
      </Reveal>

      <FolderBrowserDialog
        open={browserForKey !== null}
        onClose={() => setBrowserForKey(null)}
        onSelect={(path) => {
          if (browserForKey) updateLocalPath(browserForKey, path, true);
          setBrowserForKey(null);
        }}
        companyId={companyId}
        gitAware={browsingDept?.functionType === "software_development"}
        initialPath={browsingDept?.localPath || rootFolder || undefined}
        title={browsingDept?.functionType === "software_development" ? "Select Git Repository" : "Select Folder"}
        description={
          browsingDept?.functionType === "software_development"
            ? "Choose an existing repository from your file system"
            : "Choose a folder for this department"
        }
      />
    </StepShell>
  );
}
