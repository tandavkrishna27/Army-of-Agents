import { useEffect, useRef, useState } from "react";
import { Building2, FolderOpen, Github } from "lucide-react";
import { BRAINDUMP_CONTENT_MAX_LENGTH, type Project } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import { braindumpApi, braindumpIdempotencyKey, type BraindumpScope } from "../../api/braindump";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Reveal } from "../motion";
import { GradientText, StepCard, StepHeading, StepShell } from "../steps/shared";
import { BraindumpDropZone, type UploadedAsset } from "./BraindumpDropZone";

type BoxStatus = "idle" | "submitting" | "submitted" | "error";

type DumpBox = {
  /** Stable per-card key. "company" for the company-wide card, else the
   *  department id — also what the idempotency key is derived from. */
  key: string;
  scope: BraindumpScope;
  /** Null for the company-wide card. */
  departmentId: string | null;
  name: string;
  /** What this scope is for, in the founder's language. */
  hint: string;
  /** Memory-tree folder that dropped files are filed into. */
  folderPath: string;
  /** Connected repo/folder for a software department, shown as a chip.
   *  Null when there's no primary workspace or it's not a software dept. */
  repoChip: string | null;
  content: string;
  assets: UploadedAsset[];
  status: BoxStatus;
  error: string | null;
};

const COMPANY_HINT =
  "Vision, mission, values, brand voice, how you make decisions — anything true of the whole company.";

const DEPARTMENT_HINT =
  "How this team works: conventions, tools, standing preferences, domain context, key facts.";

/** Click-to-insert starter phrases. Short on purpose — they're a nudge, not a
 *  template; the founder finishes the sentence. `insert` is what lands in the
 *  textarea, `label` is the (slightly friendlier) chip text. */
type PromptChip = { label: string; insert: string };

const COMPANY_PROMPTS: PromptChip[] = [
  { label: "We value…", insert: "We value " },
  { label: "We ship by…", insert: "We ship by " },
  { label: "Our customers…", insert: "Our customers " },
  { label: "Never…", insert: "Never " },
];

const DEPARTMENT_PROMPTS: PromptChip[] = [
  { label: "We use…", insert: "We use " },
  { label: "Our convention is…", insert: "Our convention is " },
  { label: "Always…", insert: "Always " },
  { label: "Watch out for…", insert: "Watch out for " },
];

/** Shared pill styling for every click-to-act chip in this step — the
 *  example-prompt inserts and the "Add a department" chips both use it, so
 *  the two families of controls read as one visual language. */
const CHIP_CLASS =
  "rounded-full border border-border-strong px-2 py-1 text-[10px] text-dim transition-colors hover:border-brand hover:text-text disabled:pointer-events-none disabled:opacity-50";

function repoChipFor(project: Project): string | null {
  if (project.functionType !== "software_development") return null;
  const ws = project.primaryWorkspace ?? project.workspaces[0] ?? null;
  if (!ws) return null;
  return ws.repoUrl || ws.cwd || null;
}

/** Builds the DumpBox for a department project. Shared by the initial load
 *  (one box per department the founder already created) and by
 *  `addDepartmentBox` (for a department created after this step mounted, or
 *  any other future on-demand path) so both agree on the shape. */
function makeDeptBox(department: Project): DumpBox {
  return {
    key: department.id,
    scope: "department",
    departmentId: department.id,
    name: department.name,
    hint: DEPARTMENT_HINT,
    // Department folders are seeded under the project's urlKey
    // (memory-folders.ts seedForDepartment), so "Files" for a department is
    // "<urlKey>/Files".
    folderPath: `${department.urlKey}/Files`,
    repoChip: repoChipFor(department),
    content: "",
    assets: [],
    status: "idle",
    error: null,
  };
}

export type BraindumpStepProps = {
  companyId: string;
  onDone: () => void;
};

/**
 * WS6 — the In-flight "Braindump" surface. Standalone, like `DefineDepartments`
 * (WS4) and `IntegrationsStep` (WS5): domain-only, no `advanceOnboarding` call.
 *
 * Item 5 / Phase 5d: multi-scope. One COMPANY-wide card (seeds identity-layer
 * memory) plus one card per department (domain-layer), each accepting typed
 * text AND dropped files. That split matters because a founder's "we optimize
 * for candor" is not engineering knowledge — filing it under a department
 * would bury it, and the layer model treats the two differently.
 *
 * A software department that already has a connected repo/local folder (from
 * WS4) shows it as a chip. The chip is INFORMATIONAL only — nothing reads the
 * repo yet; it tells the founder what context already exists so they don't
 * re-type it.
 *
 * Submitting POSTs one braindump per card that has text or files (empty cards
 * are silently skipped — braindumping is optional per scope). Each card tracks
 * its own submit state so one scope's failure doesn't block the others.
 * `onDone` fires once every non-empty card has succeeded (or there were none);
 * Skip always fires it immediately.
 */
export function BraindumpStep({ companyId, onDone }: BraindumpStepProps) {
  const [boxes, setBoxes] = useState<DumpBox[]>([]);
  /** Every department project for the company, loaded once. Each one gets a
   *  card up front (see the load effect) — the founder created these
   *  departments explicitly, so they shouldn't hide behind an "Add" step.
   *  `remainingDepartments` below stays as a safety net for a department that
   *  somehow isn't in `boxes` yet; today it's always empty. */
  const [departments, setDepartments] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  /** Scope keys with an upload in flight. Continue is blocked while non-empty:
   *  submitting mid-upload would either drop the file the founder just added or
   *  treat the card as empty, leaving the finished upload unlinked. */
  const [uploadingKeys, setUploadingKeys] = useState<Set<string>>(new Set());

  const doneFiredRef = useRef(false);
  function fireOnDoneOnce() {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    onDone();
  }

  useEffect(() => {
    let cancelled = false;
    projectsApi
      .list(companyId)
      .then((projects) => {
        if (cancelled) return;
        const companyBox: DumpBox = {
          key: "company",
          scope: "company",
          departmentId: null,
          name: "Company-wide",
          hint: COMPANY_HINT,
          folderPath: "Company/Files",
          repoChip: null,
          content: "",
          assets: [],
          status: "idle",
          error: null,
        };
        // The company card plus one card per department the founder already
        // created — those departments were an explicit choice, so they
        // render up front rather than behind an "Add a department" chip.
        const depts = projects.filter((p) => p.type === "department");
        setDepartments(depts);
        setBoxes([companyBox, ...depts.map(makeDeptBox)]);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load your departments.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  function updateBox(key: string, patch: Partial<DumpBox>) {
    setBoxes((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  function hasInput(box: DumpBox): boolean {
    return box.content.trim().length > 0 || box.assets.length > 0;
  }

  // Departments not yet turned into a card. Always empty today since every
  // loaded department gets a box up front — kept as a safety net (e.g. a
  // department that loads after the initial fetch) rather than ripping out
  // the fallback path.
  const remainingDepartments = departments.filter((d) => !boxes.some((b) => b.key === d.id));

  function addDepartmentBox(department: Project) {
    setBoxes((prev) => [...prev, makeDeptBox(department)]);
  }

  /** Appends a starter phrase to a card's textarea — a nudge, not a
   *  replacement. Separated from existing text by a newline so a click never
   *  mashes two thoughts into one run-on sentence. */
  function insertPrompt(key: string, insert: string) {
    setBoxes((prev) =>
      prev.map((b) => {
        if (b.key !== key) return b;
        const existing = b.content.replace(/\s+$/, "");
        return { ...b, content: existing.length > 0 ? `${existing}\n${insert}` : insert };
      }),
    );
  }

  async function submitBox(box: DumpBox): Promise<BoxStatus> {
    try {
      await braindumpApi.submit(companyId, {
        scope: box.scope,
        departmentId: box.departmentId,
        content: box.content.trim(),
        assetIds: box.assets.map((a) => a.id),
        idempotencyKey: braindumpIdempotencyKey(companyId, box.departmentId),
      });
      return "submitted";
    } catch {
      return "error";
    }
  }

  async function submitAll() {
    // Imperative guard as well as the disabled button: a click that lands in
    // the same tick as an upload starting would otherwise submit the card
    // without the file and leave the finished upload unlinked.
    if (submitting || uploadingKeys.size > 0) return;
    setGlobalError(null);
    const toSubmit = boxes.filter((b) => hasInput(b) && b.status !== "submitted");
    if (toSubmit.length === 0) {
      fireOnDoneOnce();
      return;
    }
    setSubmitting(true);
    setBoxes((prev) =>
      prev.map((b) =>
        toSubmit.some((t) => t.key === b.key) ? { ...b, status: "submitting", error: null } : b,
      ),
    );

    const results = await Promise.all(
      toSubmit.map(async (box) => ({ key: box.key, status: await submitBox(box) })),
    );

    setBoxes((prev) =>
      prev.map((b) => {
        const result = results.find((r) => r.key === b.key);
        if (!result) return b;
        return {
          ...b,
          status: result.status,
          error: result.status === "error" ? "Couldn't save this braindump. Try again." : null,
        };
      }),
    );
    setSubmitting(false);

    if (results.every((r) => r.status === "submitted")) {
      fireOnDoneOnce();
    } else {
      setGlobalError("Some braindumps couldn't be saved — retry or skip below.");
    }
  }

  async function retryBox(key: string) {
    // Same race as submitAll, on the per-card path: retrying a failed card
    // while its replacement file is still uploading would submit the stale
    // asset list.
    if (uploadingKeys.has(key)) return;
    const box = boxes.find((b) => b.key === key);
    if (!box) return;
    updateBox(key, { status: "submitting", error: null });
    const status = await submitBox(box);
    updateBox(key, {
      status,
      error: status === "error" ? "Couldn't save this braindump. Try again." : null,
    });
  }

  return (
    <StepShell className="max-w-lg">
      <Reveal>
        <StepHeading
          title={
            <>
              Brain<GradientText>dump</GradientText> what you know
            </>
          }
          subtitle="Type it, paste it, or drop files. The Librarian sorts it into your company's memory — you approve what sticks."
        />
      </Reveal>

      {loading && <p className="text-center text-sm text-dim">Loading your departments…</p>}
      {loadError && <p className="text-center text-xs text-destructive">{loadError}</p>}

      <div className="flex flex-col gap-3">
        {boxes.map((box, i) => (
          <Reveal key={box.key} delay={0.09 + i * 0.09}>
            <StepCard>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                  {box.scope === "company" && <Building2 className="h-3.5 w-3.5 text-dim" aria-hidden />}
                  {box.name}
                </span>
                {box.repoChip && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full border border-border-strong px-2 py-1 text-[10px] text-dim">
                    {box.repoChip.startsWith("http") ? (
                      <Github className="h-3 w-3" aria-hidden />
                    ) : (
                      <FolderOpen className="h-3 w-3" aria-hidden />
                    )}
                    <span className="max-w-[180px] truncate">{box.repoChip}</span>
                  </span>
                )}
              </div>
              {box.repoChip && (
                <p className="mt-1 text-[10px] text-very-dim">Connected for reference — not read yet.</p>
              )}

              <p className="mt-1 text-[11px] text-dim">{box.hint}</p>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {(box.scope === "company" ? COMPANY_PROMPTS : DEPARTMENT_PROMPTS).map((prompt) => (
                  <button
                    key={prompt.label}
                    type="button"
                    disabled={submitting || box.status === "submitted"}
                    onClick={() => insertPrompt(box.key, prompt.insert)}
                    className={CHIP_CLASS}
                  >
                    {prompt.label}
                  </button>
                ))}
              </div>

              <label className="sr-only" htmlFor={`braindump-${box.key}`}>
                Braindump for {box.name}
              </label>
              <Textarea
                id={`braindump-${box.key}`}
                className="mt-3 min-h-[110px]"
                placeholder="Paste notes, context, decisions, anything the team should remember…"
                value={box.content}
                maxLength={BRAINDUMP_CONTENT_MAX_LENGTH}
                disabled={submitting || box.status === "submitted"}
                onChange={(e) => updateBox(box.key, { content: e.target.value })}
              />
              <p className="mt-1 text-right text-[10px] text-very-dim">
                {box.content.length.toLocaleString()} / {BRAINDUMP_CONTENT_MAX_LENGTH.toLocaleString()}
              </p>

              <BraindumpDropZone
                companyId={companyId}
                departmentId={box.departmentId}
                folderPath={box.folderPath}
                label={`Attach files for ${box.name}`}
                assets={box.assets}
                onAssetsChange={(assets) => updateBox(box.key, { assets })}
                onUploadingChange={(isUploading) =>
                  setUploadingKeys((prev) => {
                    const next = new Set(prev);
                    if (isUploading) next.add(box.key);
                    else next.delete(box.key);
                    return next;
                  })
                }
                disabled={submitting || box.status === "submitted"}
              />

              {box.status === "error" && (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2">
                  <p className="text-xs text-destructive">{box.error}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={uploadingKeys.has(box.key)}
                    onClick={() => void retryBox(box.key)}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {box.status === "submitted" && (
                <p className="mt-2 text-xs" style={{ color: "var(--done)" }}>
                  Saved
                </p>
              )}
            </StepCard>
          </Reveal>
        ))}
      </div>

      {remainingDepartments.length > 0 && (
        <Reveal delay={0.14 + boxes.length * 0.09}>
          <div>
            <p className="mb-1.5 text-[11px] text-dim">Add department knowledge</p>
            <div className="flex flex-wrap gap-1.5">
              {remainingDepartments.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => addDepartmentBox(department)}
                  className={CHIP_CLASS}
                >
                  + {department.name}
                </button>
              ))}
            </div>
          </div>
        </Reveal>
      )}

      {globalError && <p className="text-xs text-destructive">{globalError}</p>}

      <Reveal delay={0.18 + boxes.length * 0.09}>
        <div className="flex items-center gap-3">
          <Button
            className="flex-1"
            onClick={() => void submitAll()}
            disabled={submitting || loading || uploadingKeys.size > 0}
          >
            {submitting ? "Saving…" : uploadingKeys.size > 0 ? "Uploading…" : "Continue"}
          </Button>
          <button
            type="button"
            onClick={fireOnDoneOnce}
            className="shrink-0 text-xs text-dim underline-offset-2 hover:text-text hover:underline"
          >
            Skip for now
          </button>
        </div>
      </Reveal>
    </StepShell>
  );
}
