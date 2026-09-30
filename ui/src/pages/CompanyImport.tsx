import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import type { Company } from "@armyofagents/shared";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  KeyRound,
  Loader2,
  Upload,
} from "lucide-react";
import type {
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewResult,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companyPortabilityApi } from "../api/company-portability";
import { healthApi } from "../api/health";
import { organizationsApi } from "../api/organizations";
import { ApiError } from "../api/client";
import { cn } from "@/lib/utils";

type ParsedBundle = Pick<CompanyPortabilityExportResult, "manifest" | "files">;

type ShowcaseVariant = "initial" | "parsed" | "preview" | "preview-warnings";

export type CompanyImportProps = {
  showcase?: ShowcaseVariant;
  initialBundle?: ParsedBundle | null;
  initialPreview?: CompanyPortabilityPreviewResult | null;
};

const COLLISION_STRATEGIES: { value: CompanyPortabilityCollisionStrategy; label: string; help: string }[] = [
  { value: "rename", label: "Rename", help: "Safe default. Clashing slugs get a numeric suffix." },
  { value: "skip", label: "Skip", help: "Keep existing. Clashing entities are left untouched." },
  { value: "replace", label: "Replace", help: "Overwrite existing entities where supported." },
];

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function parseBundle(text: string): ParsedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Bundle root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.manifest || typeof obj.manifest !== "object") {
    throw new Error("Bundle is missing the `manifest` object");
  }
  const manifest = obj.manifest as Record<string, unknown>;
  if (typeof manifest.schemaVersion !== "number") {
    throw new Error("manifest.schemaVersion is required");
  }
  const files = (obj.files && typeof obj.files === "object" ? obj.files : {}) as Record<string, string>;
  return { manifest: obj.manifest as ParsedBundle["manifest"], files };
}

export function CompanyImport({
  showcase,
  initialBundle = null,
  initialPreview = null,
}: CompanyImportProps = {}) {
  const { reloadCompanies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [fileName, setFileName] = useState<string | null>(
    initialBundle ? "bundle.aoa-bundle.json" : null,
  );
  const [bundle, setBundle] = useState<ParsedBundle | null>(initialBundle);
  const [parseError, setParseError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<CompanyPortabilityCollisionStrategy>("rename");
  const [preview, setPreview] = useState<CompanyPortabilityPreviewResult | null>(initialPreview);
  const [previewDestinationId, setPreviewDestinationId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CompanyPortabilityImportResult | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const organizationsQuery = useQuery({
    queryKey: queryKeys.organizations.list,
    queryFn: () => organizationsApi.list(),
    retry: false,
  });
  const memberships = organizationsQuery.data ?? [];
  const eligibleOrganizations = useMemo(
    () => memberships.filter(
      (membership) =>
        membership.status === "active" &&
        (membership.role === "owner" || membership.role === "admin"),
    ),
    [memberships],
  );
  const isCloud = healthQuery.data?.deploymentMode === "cloud_auth";
  const selectedOrganizationIsEligible = selectedOrganizationId !== null
    && eligibleOrganizations.some(
      (membership) => membership.organizationId === selectedOrganizationId,
    );
  const effectiveOrganizationId = isCloud
    ? eligibleOrganizations.length === 1
      ? eligibleOrganizations[0]!.organizationId
      : selectedOrganizationIsEligible
        ? selectedOrganizationId
        : null
    : null;
  const effectiveOrganizationIdRef = useRef<string | null>(effectiveOrganizationId);
  effectiveOrganizationIdRef.current = effectiveOrganizationId;

  useEffect(() => {
    const nextSelectedOrganizationId = isCloud
      ? eligibleOrganizations.length === 1
        ? eligibleOrganizations[0]!.organizationId
        : selectedOrganizationIsEligible
          ? selectedOrganizationId
          : null
      : null;
    if (nextSelectedOrganizationId !== selectedOrganizationId) {
      setSelectedOrganizationId(nextSelectedOrganizationId);
      setPreview(null);
      setPreviewDestinationId(null);
      setImportResult(null);
    }
  }, [eligibleOrganizations, isCloud, selectedOrganizationId, selectedOrganizationIsEligible]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Import Company" }]);
  }, [setBreadcrumbs]);

  const buildRequest = (): CompanyPortabilityImportRequest => {
    if (!bundle) throw new Error("No bundle loaded");
    return {
      source: { type: "inline", manifest: bundle.manifest, files: bundle.files },
      target: {
        mode: "new_company",
        ...(effectiveOrganizationId
          ? { organizationId: effectiveOrganizationId }
          : {}),
      },
      collisionStrategy: strategy,
    };
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      const request = buildRequest();
      const destinationId = request.target.mode === "new_company"
        ? request.target.organizationId ?? null
        : null;
      return {
        destinationId,
        preview: await companyPortabilityApi.previewImport(request),
      };
    },
    onSuccess: ({ destinationId, preview: result }) => {
      if (destinationId !== effectiveOrganizationIdRef.current) return;
      setPreview(result);
      setPreviewDestinationId(destinationId);
      setImportResult(null);
    },
  });

  const importMutation = useMutation({
    mutationFn: () => companyPortabilityApi.importBundle(buildRequest()),
    onSuccess: async (data) => {
      setImportResult(data);
      await reloadCompanies();
      const fresh = await queryClient.fetchQuery<Company[]>({
        queryKey: queryKeys.companies.all,
        queryFn: () => companiesApi.list(),
      });
      const match = fresh.find((c) => c.id === data.company.id);
      if (match?.issuePrefix) {
        navigate(`/${match.issuePrefix}/home`);
      } else {
        navigate("/");
      }
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setPreview(null);
    setPreviewDestinationId(null);
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseBundle(String(reader.result ?? ""));
        setBundle(parsed);
        setFileName(file.name);
      } catch (err) {
        setBundle(null);
        setFileName(file.name);
        setParseError(errorMessage(err));
      }
    };
    reader.onerror = () => setParseError("Failed to read file");
    reader.readAsText(file);
  }

  function handlePreview() {
    if (showcase) return;
    previewMutation.mutate();
  }

  function handleImport() {
    if (showcase) return;
    importMutation.mutate();
  }

  function handleOrganizationChange(organizationId: string) {
    setSelectedOrganizationId(organizationId || null);
    setPreview(null);
    setPreviewDestinationId(null);
    setImportResult(null);
  }

  function resetBundle() {
    setBundle(null);
    setFileName(null);
    setParseError(null);
    setPreview(null);
    setPreviewDestinationId(null);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasResolvedCloudDestination = !isCloud || Boolean(effectiveOrganizationId);
  const canPreview = !!bundle
    && healthQuery.isSuccess
    && organizationsQuery.isSuccess
    && hasResolvedCloudDestination
    && !previewMutation.isPending;
  const canImport = canPreview
    && previewDestinationId === effectiveOrganizationId
    && !!preview
    && !importMutation.isPending
    && preview.errors.length === 0;

  const bundleCompanyName = bundle?.manifest.company?.name ?? "Unknown";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-bold">Import Company</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload an AoA or Paperclip company bundle, preview what will be imported, then confirm.
        </p>
      </div>

      {/* Source card */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-sm font-semibold">Bundle source</h2>
            <p className="text-xs text-muted-foreground">
              Upload a <code>.json</code> or <code>.aoa-bundle.json</code> file exported from AoA or Paperclip.
            </p>
          </div>
          <Separator />

          {!bundle && (
            <label
              htmlFor="bundle-file"
              className={cn(
                "flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed border-border bg-muted/10 p-8 text-center",
                "hover:border-foreground/20 hover:bg-muted/20",
                "focus-within:ring-2 focus-within:ring-ring",
              )}
            >
              <FileUp className="h-6 w-6 text-muted-foreground" />
              <span className="text-sm font-medium">Upload bundle file</span>
              <span className="text-xs text-muted-foreground">
                JSON files only. Bundle must contain a <code>manifest</code> object.
              </span>
              <input
                ref={fileInputRef}
                id="bundle-file"
                data-testid="bundle-file-input"
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={handleFileChange}
              />
            </label>
          )}

          {bundle && (
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <div>
                    <p className="text-sm font-medium">{fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {bundleCompanyName} · schema v{bundle.manifest.schemaVersion}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={resetBundle} disabled={!!showcase}>
                  Remove
                </Button>
              </div>
            </div>
          )}

          {parseError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {parseError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Options card */}
      {bundle && (
        <Card>
          <CardContent className="space-y-4 p-6">
            <div>
              <h2 className="text-sm font-semibold">Import options</h2>
              <p className="text-xs text-muted-foreground">
                New companies are created. Collision strategy controls how clashing slugs are handled.
              </p>
            </div>
            <Separator />

            <div className="space-y-2">
              <Label htmlFor="collision-strategy" className="text-sm font-medium">
                Collision strategy
              </Label>
              <select
                id="collision-strategy"
                aria-label="Collision strategy"
                value={strategy}
                onChange={(e) =>
                  setStrategy(e.target.value as CompanyPortabilityCollisionStrategy)
                }
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {COLLISION_STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {COLLISION_STRATEGIES.find((s) => s.value === strategy)?.help}
              </p>
            </div>

            {isCloud && eligibleOrganizations.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="destination-organization" className="text-sm font-medium">
                  Destination organization
                </Label>
                <select
                  id="destination-organization"
                  aria-label="Destination organization"
                  value={selectedOrganizationId ?? ""}
                  onChange={(event) => handleOrganizationChange(event.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select an organization</option>
                  {eligibleOrganizations.map((membership) => (
                    <option key={membership.id} value={membership.organizationId}>
                      {membership.organizationName} ({membership.organizationSlug})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {healthQuery.isPending && (
              <div className="rounded-md border border-muted-foreground/30 bg-muted/20 p-3 text-sm text-muted-foreground">
                Loading deployment configuration…
              </div>
            )}
            {healthQuery.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Couldn't load your workspace deployment configuration. Import is unavailable until it loads.
              </div>
            )}
            {organizationsQuery.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Couldn't load your organizations. Import is unavailable until it loads.
              </div>
            )}
            {isCloud && organizationsQuery.isSuccess && eligibleOrganizations.length === 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                You need owner or admin access to an organization before importing a company.
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <Button onClick={handlePreview} disabled={!canPreview || !!showcase}>
                {previewMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Previewing...
                  </>
                ) : (
                  <>Preview</>
                )}
              </Button>
              <Button variant="default" onClick={handleImport} disabled={!canImport || !!showcase}>
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>Import</>
                )}
              </Button>
            </div>

            {previewMutation.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {errorMessage(previewMutation.error)}
              </div>
            )}
            {importMutation.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {errorMessage(importMutation.error)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {preview && <PreviewCard preview={preview} bundle={bundle} />}

      {importResult && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-sm font-medium">
                Imported <span className="text-foreground">{importResult.company.name}</span>
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {importResult.agents.length} agents · {importResult.projects.length} projects ·{" "}
              {importResult.issues.length} tasks · {importResult.skills.length} skills ·{" "}
              {importResult.routines.length} routines
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PreviewCard({
  preview,
  bundle,
}: {
  preview: CompanyPortabilityPreviewResult;
  bundle: ParsedBundle | null;
}) {
  const planRows = useMemo(() => {
    return [
      { label: "Agents", plans: preview.plan.agentPlans.map((p) => ({ slug: p.slug, action: p.action, name: p.plannedName })) },
      { label: "Projects", plans: preview.plan.projectPlans.map((p) => ({ slug: p.slug, action: p.action, name: p.plannedName })) },
      { label: "Tasks", plans: preview.plan.issuePlans.map((p) => ({ slug: p.slug, action: p.action, name: p.plannedTitle })) },
      { label: "Skills", plans: preview.plan.skillPlans.map((p) => ({ slug: p.slug, action: p.action, name: p.plannedName })) },
      { label: "Routines", plans: preview.plan.routinePlans.map((p) => ({ slug: p.slug, action: p.action, name: p.plannedTitle })) },
    ].filter((row) => row.plans.length > 0);
  }, [preview]);

  const bundleCountRows = useMemo(() => {
    const manifest = bundle?.manifest;
    if (!manifest) return [] as Array<{ label: string; value: number }>;
    const rows: Array<{ label: string; value: number }> = [];
    if (manifest.internalAgentConfig !== undefined) {
      rows.push({ label: "Internal agent", value: manifest.internalAgentConfig ? 1 : 0 });
    }
    if (manifest.budgetPolicies !== undefined) {
      rows.push({ label: "Budget policies", value: manifest.budgetPolicies.length });
    }
    if (manifest.costEvents !== undefined) {
      rows.push({ label: "Cost events", value: manifest.costEvents.length });
    }
    if (manifest.financeEvents !== undefined) {
      rows.push({ label: "Finance events", value: manifest.financeEvents.length });
    }
    if (manifest.quotaWindows !== undefined) {
      rows.push({ label: "Quota windows", value: manifest.quotaWindows.length });
    }
    if (manifest.workflowTemplates !== undefined) {
      rows.push({ label: "Workflow templates", value: manifest.workflowTemplates.length });
    }
    return rows;
  }, [bundle]);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <h2 className="text-sm font-semibold">Preview</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            Company: <span className="text-foreground">{preview.targetCompanyName ?? "(new)"}</span>
            {" · "}
            Action: <span className="text-foreground">{preview.plan.companyAction}</span>
          </span>
        </div>

        {preview.errors.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">Errors ({preview.errors.length})</p>
            <ul className="mt-1 list-disc space-y-1 pl-6 text-xs text-destructive">
              {preview.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {planRows.length > 0 && (
          <div className="space-y-3">
            {planRows.map((row) => (
              <PlanSection key={row.label} label={row.label} plans={row.plans} />
            ))}
          </div>
        )}

        {bundleCountRows.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium">Budget &amp; Internal Agent</span>
              <span className="text-xs text-muted-foreground">from bundle manifest</span>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {bundleCountRows.map((row) => (
                <div
                  key={row.label}
                  className="rounded-md border border-border bg-muted/20 px-2 py-1.5"
                >
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {row.label}
                  </p>
                  <p className="text-base font-semibold">{row.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {preview.warnings.length > 0 && (
          <div className="rounded-md border border-amber-400/50 bg-amber-50 p-3 dark:bg-amber-950/20">
            <div className="mb-1 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Warnings ({preview.warnings.length})
              </p>
            </div>
            <ul className="list-disc space-y-1 pl-6 text-xs text-amber-800 dark:text-amber-200">
              {preview.warnings.map((warning, i) => (
                <li key={i}>{warning.message}</li>
              ))}
            </ul>
          </div>
        )}

        {preview.requiredSecrets.length > 0 && (
          <details className="rounded-md border border-border bg-muted/20 p-3">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              Required secrets ({preview.requiredSecrets.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {preview.requiredSecrets.map((s, i) => (
                <li key={i} className="font-mono">
                  <span className="text-foreground">{s.key}</span>
                  {s.description ? <span className="ml-2">{s.description}</span> : null}
                  {s.agentSlug ? <span className="ml-2 text-[10px]">(agent {s.agentSlug})</span> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function PlanSection({
  label,
  plans,
}: {
  label: string;
  plans: { slug: string; action: string; name: string }[];
}) {
  const counts = plans.reduce<Record<string, number>>((acc, p) => {
    acc[p.action] = (acc[p.action] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          {Object.entries(counts)
            .map(([action, count]) => `${count} ${action}`)
            .join(" · ")}
        </span>
      </div>
      <ul className="space-y-1 text-xs">
        {plans.slice(0, 10).map((p) => (
          <li key={p.slug} className="flex items-center justify-between rounded border border-border bg-muted/10 px-2 py-1">
            <span className="truncate">{p.name}</span>
            <span
              className={cn(
                "ml-2 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                p.action === "create" && "border-emerald-500/40 text-emerald-600",
                p.action === "update" && "border-amber-500/40 text-amber-600",
                p.action === "skip" && "border-border text-muted-foreground",
              )}
            >
              {p.action}
            </span>
          </li>
        ))}
        {plans.length > 10 && (
          <li className="px-2 text-[10px] text-muted-foreground">+{plans.length - 10} more</li>
        )}
      </ul>
    </div>
  );
}

