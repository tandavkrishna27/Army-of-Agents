import { useEffect, useState } from "react";
import type { StepProps } from "../registry";
import { DEPARTMENT_FUNCTION_TYPES } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import { companiesApi } from "../../api/companies";
import { filesystemApi } from "../../api/filesystem";
import { advanceOnboarding } from "../../api/onboarding";
import { Button } from "@/components/ui/button";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

type Project = { id: string; type?: string; name?: string };

function slugify(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const isAbsolute = (v: string) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v);

/**
 * "Create your first department" step. Consumes the shared
 * DEPARTMENT_FUNCTION_TYPES (C9). Software departments default a local workspace
 * folder nested under companies.rootFolder (editable), and can additionally
 * connect a GitHub repo. Idempotent: guards on an existing same-named
 * department before creating.
 *
 * WS0c: NO LONGER a registered FlowEngine wizard step (`DEPARTMENT_CREATED`
 * was removed from `FOUNDER_PHASE1_STATES` — see
 * packages/shared/src/onboarding.ts). The `advanceOnboarding({ requestedState:
 * "DEPARTMENT_CREATED" })` call below would now be rejected as illegal if this
 * component were rendered as-is; it is kept only as source for a future
 * Home-hosted extraction (design §4.1) — WS4/WS7 must lift the domain-only
 * create logic into a component that does NOT call advanceOnboarding.
 */
export function DepartmentStep({ ctx, onComplete }: StepProps) {
  // Default to a real value (not just a placeholder) so the button isn't
  // silently disabled and the nested-folder path prefills — matching the agent
  // step's "Director" default. The user can still rename it.
  const [name, setName] = useState("Engineering");
  const [functionType, setFunctionType] = useState<string>("software_development");
  const [rootFolder, setRootFolder] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [useLocal, setUseLocal] = useState(true);
  const [useRepo, setUseRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx.companyId) return;
    companiesApi
      .get(ctx.companyId)
      .then((c) => setRootFolder((c as { rootFolder?: string | null }).rootFolder ?? null))
      .catch(() => {});
  }, [ctx.companyId]);

  // Prefill the nested folder under the company root: …/<root>/<slug>.
  useEffect(() => {
    if (!rootFolder || !name.trim()) return;
    const sep = rootFolder.includes("\\") ? "\\" : "/";
    setLocalPath(`${rootFolder}${sep}${slugify(name)}`);
  }, [rootFolder, name]);

  const isSoftware = functionType === "software_development";

  const create = async () => {
    if (!ctx.companyId || !name.trim()) return;
    if (isSoftware && useRepo && !repoUrl.trim()) {
      setError("Please enter a GitHub repository URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Idempotent guard: don't create a second department with the same name.
      const existing = (await projectsApi.list(ctx.companyId).catch(() => [])) as Project[];
      let deptId = existing.find((p) => p.type === "department" && p.name === name.trim())?.id ?? null;

      if (!deptId) {
        const created = await projectsApi.create(ctx.companyId, {
          name: name.trim(),
          type: "department",
          status: "planned",
          functionType,
        });
        deptId = (created as Project).id;
      }

      if (isSoftware && (useLocal || useRepo)) {
        if (useLocal && !isAbsolute(localPath.trim())) {
          throw new Error("Local folder must be an absolute path.");
        }
        const workspaces = await projectsApi.listWorkspaces(deptId, ctx.companyId);
        if (workspaces.length === 0) {
          // Don't swallow a real mkdir failure — otherwise we'd create a
          // workspace whose cwd points at a folder that was never created.
          if (useLocal) {
            try {
              await filesystemApi.mkdir(localPath.trim());
            } catch (mkErr) {
              throw new Error(
                mkErr instanceof Error
                  ? `Couldn't create the folder "${localPath.trim()}": ${mkErr.message}`
                  : `Couldn't create the folder "${localPath.trim()}".`,
              );
            }
          }
          if (useLocal && useRepo) {
            await projectsApi.createWorkspace(deptId, {
              name: name.trim(),
              cwd: localPath.trim(),
              repoUrl: repoUrl.trim(),
            }, ctx.companyId);
          } else if (useLocal) {
            await projectsApi.createWorkspace(
              deptId,
              { name: name.trim(), cwd: localPath.trim() },
              ctx.companyId,
            );
          } else if (useRepo) {
            await projectsApi.createWorkspace(deptId, {
              name: name.trim(),
              cwd: REPO_ONLY_CWD_SENTINEL,
              repoUrl: repoUrl.trim(),
            }, ctx.companyId);
          }
        }
      }

      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: "DEPARTMENT_CREATED",
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your department.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-10">
      <h1 className="text-xl font-semibold">Create your first department</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Departments organize agents and work. Software departments can connect a local folder
        and/or a GitHub repo.
      </p>
      <label className="mt-6 mb-1 block text-xs text-muted-foreground">Department name</label>
      <input
        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Engineering"
        autoFocus
      />
      <div className="mt-3 grid grid-cols-3 gap-2">
        {DEPARTMENT_FUNCTION_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`rounded-md border px-2 py-2 text-left text-xs ${
              functionType === t.value ? "border-foreground bg-accent" : "border-border hover:bg-accent/50"
            }`}
            onClick={() => setFunctionType(t.value)}
          >
            <span className="mr-1">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
      {isSoftware && (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={useLocal} onChange={(e) => setUseLocal(e.target.checked)} />
            Local folder (nested under your root)
          </label>
          {useLocal && (
            <input
              data-testid="department-local-folder"
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={useRepo} onChange={(e) => setUseRepo(e.target.checked)} />
            GitHub repo
          </label>
          {useRepo && (
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
            />
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <Button
        className="mt-4 w-full"
        onClick={() => void create()}
        disabled={busy || !name.trim() || (isSoftware && useRepo && !repoUrl.trim())}
      >
        {busy ? "Creating…" : "Create department"}
      </Button>
    </div>
  );
}
