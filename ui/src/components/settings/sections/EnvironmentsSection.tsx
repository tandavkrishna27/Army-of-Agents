import { useState } from "react";
import { useCompany } from "@/context/CompanyContext";
import {
  useEnvironments,
  useCreateEnvironment,
  useUpdateEnvironment,
  useDeleteEnvironment,
  useProbeEnvironment,
} from "@/api/environments";
import { secretsApi } from "@/api/secrets";
import { executionTargetsApi } from "@/api/execution-targets";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import type { CompanySecret, DeploymentMode, Environment } from "@armyofagents/shared";
import type { CreateEnvironmentInput, EnvironmentProbeResult, UpdateEnvironmentInput } from "@armyofagents/shared";
import { buildGvisorConfig, normalizeExecutionTargetId, parseGvisorConfig } from "./environment-target-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Layers, Plus, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(val: Record<string, unknown> | null | undefined): string {
  if (val == null || Object.keys(val).length === 0) return "";
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return "";
  }
}

function safeParse(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      return { ok: false, error: "Must be a JSON object (e.g. { \"KEY\": \"value\" })" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type EnvTargetType = "local" | "sandbox-docker" | "e2b" | "gvisor";
type EnvTargetShell = "sh" | "bash";
type EnvTargetNetwork = "bridge" | "host" | "none";

const DEFAULT_GVISOR_FIELDS = { gvisorImage: "", gvisorMemory: "2g", gvisorCpus: "2", gvisorPidsLimit: "512" };

function readTarget(initial: Environment | undefined) {
  const raw = initial?.target;
  const config = initial?.config ?? {};
  const executionTargetId = initial?.executionTargetId ?? "";
  if (initial?.driver === "sandbox" && config.provider === "e2b") {
    const credentialSecretId = typeof config.credentialSecretId === "string" ? config.credentialSecretId : "";
    return {
      targetType: "e2b" as EnvTargetType,
      targetImage: "",
      targetWorkdir: "/workspace",
      targetShell: "bash" as EnvTargetShell,
      targetNetwork: "bridge" as EnvTargetNetwork,
      targetRemove: true,
      targetInstallCommand: "",
      configRaw: safeStringify(config),
      e2bCredentialMode: credentialSecretId ? "secret" as const : "default" as const,
      e2bCredentialSecretId: credentialSecretId,
      e2bTemplate: typeof config.template === "string" ? config.template : "base",
      e2bTimeoutMs: typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "60000",
      e2bReuseLease: config.reuseLease === true,
      ...DEFAULT_GVISOR_FIELDS,
      executionTargetId,
    };
  }
  if (initial?.driver === "sandbox" && config.provider === "gvisor") {
    const gvisorFields = parseGvisorConfig(config);
    return {
      targetType: "gvisor" as EnvTargetType,
      targetImage: "",
      targetWorkdir: "/workspace",
      targetShell: "sh" as EnvTargetShell,
      targetNetwork: "bridge" as EnvTargetNetwork,
      targetRemove: true,
      targetInstallCommand: "",
      configRaw: safeStringify(config),
      e2bCredentialMode: "default" as const,
      e2bCredentialSecretId: "",
      e2bTemplate: "base",
      e2bTimeoutMs: "60000",
      e2bReuseLease: false,
      gvisorImage: gvisorFields.image,
      gvisorMemory: gvisorFields.memory,
      gvisorCpus: gvisorFields.cpus,
      gvisorPidsLimit: gvisorFields.pidsLimit,
      executionTargetId,
    };
  }
  if (raw?.type !== "sandbox-docker") {
    return {
      targetType: "local" as EnvTargetType,
      targetImage: "",
      targetWorkdir: "/workspace",
      targetShell: "sh" as EnvTargetShell,
      targetNetwork: "bridge" as EnvTargetNetwork,
      targetRemove: true,
      targetInstallCommand: "",
      configRaw: "",
      e2bCredentialMode: "default" as const,
      e2bCredentialSecretId: "",
      e2bTemplate: "base",
      e2bTimeoutMs: "60000",
      e2bReuseLease: false,
      ...DEFAULT_GVISOR_FIELDS,
      executionTargetId,
    };
  }
  return {
    targetType: "sandbox-docker" as EnvTargetType,
    targetImage: typeof raw.image === "string" ? raw.image : "",
    targetWorkdir: typeof raw.workdir === "string" ? raw.workdir : "/workspace",
    targetShell: raw.shell === "bash" ? "bash" as EnvTargetShell : "sh" as EnvTargetShell,
    targetNetwork: raw.network === "host" || raw.network === "none" ? raw.network : "bridge" as EnvTargetNetwork,
    targetRemove: raw.remove !== false,
    targetInstallCommand: typeof raw.installCommand === "string" ? raw.installCommand : "",
    configRaw: safeStringify(initial?.config),
    e2bCredentialMode: "default" as const,
    e2bCredentialSecretId: "",
    e2bTemplate: "base",
    e2bTimeoutMs: "60000",
    e2bReuseLease: false,
    ...DEFAULT_GVISOR_FIELDS,
    executionTargetId,
  };
}

function formatTargetSummary(env: Environment): string {
  if (env.driver === "sandbox" && env.config?.provider === "e2b") {
    const template = typeof env.config.template === "string" && env.config.template.trim()
      ? env.config.template.trim()
      : "base";
    return `E2B Sandbox: ${template}`;
  }
  if (env.driver === "sandbox" && env.config?.provider === "gvisor") {
    const image = typeof env.config.image === "string" && env.config.image.trim()
      ? env.config.image.trim()
      : "image missing";
    return `gVisor Sandbox (runsc): ${image}`;
  }
  if (env.target?.type === "sandbox-docker") {
    const image = typeof env.target.image === "string" && env.target.image.trim()
      ? env.target.image
      : "image missing";
    return `sandbox-docker: ${image}`;
  }
  return "local target";
}

// ---------------------------------------------------------------------------
// Environment form dialog
// ---------------------------------------------------------------------------

interface EnvFormState {
  name: string;
  envVarsRaw: string;
  connectionTargetRaw: string;
  configRaw: string;
  targetType: EnvTargetType;
  targetImage: string;
  targetWorkdir: string;
  targetShell: EnvTargetShell;
  targetNetwork: EnvTargetNetwork;
  targetRemove: boolean;
  targetInstallCommand: string;
  e2bCredentialMode: "default" | "secret";
  e2bCredentialSecretId: string;
  e2bTemplate: string;
  e2bTimeoutMs: string;
  e2bReuseLease: boolean;
  gvisorImage: string;
  gvisorMemory: string;
  gvisorCpus: string;
  gvisorPidsLimit: string;
  // "" = unpinned (route by credential kind). See execution-target-resolver.ts.
  executionTargetId: string;
}

interface EnvironmentDialogProps {
  companyId: string;
  // Nullable: environments can be edited before a company has an
  // organization context resolved. The "Pin to execution target" picker
  // is hidden (not disabled) when this is null — see the render guard below.
  organizationId?: string | null;
  open: boolean;
  mode: "create" | "edit";
  initial?: Environment;
  isPending: boolean;
  submitError?: string | null;
  secrets: CompanySecret[];
  onClose: () => void;
  onSubmit: (data: CreateEnvironmentInput | UpdateEnvironmentInput) => void;
  cloudMode: boolean;
}

function EnvironmentDialog({
  companyId,
  organizationId,
  open,
  mode,
  initial,
  isPending,
  submitError,
  secrets,
  onClose,
  onSubmit,
  cloudMode,
}: EnvironmentDialogProps) {
  const probeMutation = useProbeEnvironment();
  // Org-admin-gated (server/src/routes/execution-targets.ts). A non-admin
  // viewer or a company with no organizationId just sees no pin options —
  // the picker degrades to "Auto" only, it never blocks the dialog.
  const executionTargetsQuery = useQuery({
    queryKey: queryKeys.executionTargets.list(organizationId ?? ""),
    queryFn: () => executionTargetsApi.list(organizationId as string),
    enabled: !!organizationId && !cloudMode,
    retry: false,
  });
  const executionTargets = executionTargetsQuery.data ?? [];
  const [form, setForm] = useState<EnvFormState>(() => ({
    name: initial?.name ?? "",
    envVarsRaw: safeStringify(initial?.envVars),
    connectionTargetRaw: safeStringify(initial?.connectionTarget ?? undefined),
    ...readTarget(initial),
    ...(!initial && cloudMode ? { targetType: "e2b" as const } : {}),
  }));

  const [envVarsError, setEnvVarsError] = useState<string | null>(null);
  const [connectionTargetError, setConnectionTargetError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<EnvironmentProbeResult | null>(null);

  // Reset form when dialog opens with fresh initial values
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setForm({
        name: initial?.name ?? "",
        envVarsRaw: safeStringify(initial?.envVars),
        connectionTargetRaw: safeStringify(initial?.connectionTarget ?? undefined),
        ...readTarget(initial),
        ...(!initial && cloudMode ? { targetType: "e2b" as const } : {}),
      });
      setEnvVarsError(null);
      setConnectionTargetError(null);
      setConfigError(null);
      setProbeResult(null);
      probeMutation.reset();
    }
  }

  function buildEnvironmentInput(): { ok: true; value: CreateEnvironmentInput | UpdateEnvironmentInput } | { ok: false } {
    if (cloudMode && form.targetType !== "e2b") {
      setConfigError("AoA Cloud currently supports E2B environments only. Migrate this environment to E2B to save changes.");
      return { ok: false };
    }
    const evResult = safeParse(form.envVarsRaw);
    const ctResult = safeParse(form.connectionTargetRaw);
    const configResult = form.targetType === "e2b" || form.targetType === "gvisor"
      ? { ok: true as const, value: {} }
      : safeParse(form.configRaw);

    if (!evResult.ok) {
      setEnvVarsError(evResult.error);
      return { ok: false };
    }
    if (!ctResult.ok) {
      setConnectionTargetError(ctResult.error);
      return { ok: false };
    }
    if (!configResult.ok) {
      setConfigError(configResult.error);
      return { ok: false };
    }
    if (form.targetType === "sandbox-docker" && !form.targetImage.trim()) {
      setConnectionTargetError("Docker image is required for sandbox-docker.");
      return { ok: false };
    }
    if (form.targetType === "gvisor" && !form.gvisorImage.trim()) {
      setConfigError("Docker image is required for gVisor.");
      return { ok: false };
    }
    if (form.targetType === "e2b" && form.e2bCredentialMode === "secret" && !form.e2bCredentialSecretId) {
      setConfigError("Choose a secret for this E2B environment.");
      return { ok: false };
    }
    const timeoutMs = Number(form.e2bTimeoutMs);
    if (form.targetType === "e2b" && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000)) {
      setConfigError("Timeout must be between 1000 and 86400000 ms.");
      return { ok: false };
    }
    setEnvVarsError(null);
    setConnectionTargetError(null);
    setConfigError(null);

    const trimmedCt = form.connectionTargetRaw.trim();
    const dockerConfig = form.targetType === "sandbox-docker"
      ? {
          provider: "sandbox-docker",
          image: form.targetImage.trim(),
          workdir: form.targetWorkdir.trim() || "/workspace",
          shell: form.targetShell,
          network: form.targetNetwork,
          remove: form.targetRemove,
          ...(form.targetInstallCommand.trim()
            ? { installCommand: form.targetInstallCommand.trim() }
            : {}),
        }
      : {};
    // gVisor target is null (like e2b): the sandbox-docker `target` field has
    // no "gvisor" variant in environmentTargetSchema — the hardened docker
    // invocation is derived server-side from `config` alone
    // (resolveGvisorSandboxTarget, server/src/services/environment-runtime.ts).
    const target: CreateEnvironmentInput["target"] = form.targetType === "sandbox-docker"
      ? {
          type: "sandbox-docker" as const,
          image: form.targetImage.trim(),
          workdir: form.targetWorkdir.trim() || "/workspace",
          shell: form.targetShell,
          network: form.targetNetwork,
          remove: form.targetRemove,
          ...(form.targetInstallCommand.trim()
            ? { installCommand: form.targetInstallCommand.trim() }
            : {}),
        }
      : form.targetType === "e2b" || form.targetType === "gvisor"
        ? null
        : { type: "local" as const };
    const config = form.targetType === "e2b"
      ? {
          provider: "e2b",
          ...(form.e2bCredentialMode === "secret"
            ? { credentialSecretId: form.e2bCredentialSecretId }
            : { credentialRef: "default" }),
          template: form.e2bTemplate.trim() || "base",
          timeoutMs,
          reuseLease: form.e2bReuseLease,
        }
      : form.targetType === "gvisor"
        ? buildGvisorConfig({
            image: form.gvisorImage,
            memory: form.gvisorMemory,
            cpus: form.gvisorCpus,
            pidsLimit: form.gvisorPidsLimit,
          })
        : dockerConfig;
    return { ok: true, value: {
      name: form.name.trim(),
      driver: form.targetType === "local" ? "local" : "sandbox",
      config,
      envVars: evResult.value,
      connectionTarget: trimmedCt ? ctResult.value : null,
      target,
      executionTargetId: normalizeExecutionTargetId(form.executionTargetId),
    } };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input = buildEnvironmentInput();
    if (!input.ok) return;
    onSubmit(input.value);
  }

  function handleProbe() {
    const input = buildEnvironmentInput();
    if (!input.ok) return;
    probeMutation.mutate(
      {
        companyId,
        input: {
          driver: input.value.driver ?? "local",
          config: input.value.config ?? {},
        },
      },
      { onSuccess: setProbeResult },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New Environment" : "Edit Environment"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure the environment name, runtime target, and environment variables.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {submitError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {submitError}
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              required
              placeholder="e.g. production"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          {/* Env vars */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Environment Variables
            </label>
            <p className="text-xs text-muted-foreground">
              JSON object — keys and values are strings (e.g.{" "}
              <code className="text-[11px] bg-muted/40 px-1 rounded">
                {`{"NODE_ENV": "production"}`}
              </code>
              ).
            </p>
            <Textarea
              rows={5}
              placeholder='{"KEY": "value"}'
              value={form.envVarsRaw}
              onChange={(e) => {
                setForm((f) => ({ ...f, envVarsRaw: e.target.value }));
                setEnvVarsError(null);
              }}
              className={cn("font-mono text-xs", envVarsError && "border-destructive")}
            />
            {envVarsError && (
              <p className="text-xs text-destructive">{envVarsError}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Execution Target
            </label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={form.targetType}
              onChange={(e) => {
                const value = e.target.value;
                setForm((f) => ({
                  ...f,
                  targetType: value === "sandbox-docker"
                    ? "sandbox-docker"
                    : value === "e2b"
                      ? "e2b"
                      : value === "gvisor"
                        ? "gvisor"
                        : "local",
                }));
              }}
              data-testid="environment-target-select"
            >
              {cloudMode && form.targetType !== "e2b" && (
                <option value={form.targetType} disabled>
                  {form.targetType} (unavailable on AoA Cloud)
                </option>
              )}
              {!cloudMode && <option value="local">Local</option>}
              {!cloudMode && <option value="sandbox-docker">Sandbox Docker</option>}
              <option value="e2b">E2B Sandbox</option>
              {!cloudMode && <option value="gvisor">gVisor Sandbox (hardened, runsc)</option>}
            </select>
            {cloudMode && (
              <p className="text-xs text-muted-foreground">
                E2B supports regular heartbeat-agent command execution. Commander, crew, local
                workspace jobs, Docker, gVisor, and worker-pool routing remain unavailable on AoA Cloud.
              </p>
            )}
          </div>

          {form.targetType === "gvisor" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Runs the CLI under gVisor's <code className="text-[11px] bg-muted/40 px-1 rounded">runsc</code>{" "}
                runtime with a hardened, default-off isolation profile (read-only rootfs, dropped
                capabilities, no new privileges, no network). See{" "}
                <code className="text-[11px] bg-muted/40 px-1 rounded">docs/aoa/guides/gvisor-worker-image.md</code>.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Docker Image <span className="text-destructive">*</span>
                </label>
                <Input
                  required
                  placeholder="aoa/agent-base:latest"
                  value={form.gvisorImage}
                  onChange={(e) => setForm((f) => ({ ...f, gvisorImage: e.target.value }))}
                  data-testid="environment-gvisor-image-input"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Memory
                  </label>
                  <Input
                    placeholder="2g"
                    value={form.gvisorMemory}
                    onChange={(e) => setForm((f) => ({ ...f, gvisorMemory: e.target.value }))}
                    data-testid="environment-gvisor-memory-input"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    CPUs
                  </label>
                  <Input
                    placeholder="2"
                    value={form.gvisorCpus}
                    onChange={(e) => setForm((f) => ({ ...f, gvisorCpus: e.target.value }))}
                    data-testid="environment-gvisor-cpus-input"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    PIDs limit
                  </label>
                  <Input
                    placeholder="512"
                    value={form.gvisorPidsLimit}
                    onChange={(e) => setForm((f) => ({ ...f, gvisorPidsLimit: e.target.value }))}
                    inputMode="numeric"
                    data-testid="environment-gvisor-pids-input"
                  />
                </div>
              </div>
              {configError && (
                <p className="text-xs text-destructive">{configError}</p>
              )}
            </div>
          )}

          {!!organizationId && !cloudMode && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Pin to Execution Target <span className="text-muted-foreground/50">(optional)</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Overrides route-by-credential — every run on this environment always uses the
                selected target. Leave unpinned to route automatically (company API keys go to the
                shared pool; personal subscriptions go to their bound dedicated target).
              </p>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.executionTargetId}
                onChange={(e) => setForm((f) => ({ ...f, executionTargetId: e.target.value }))}
                data-testid="environment-execution-target-pin-select"
                disabled={executionTargetsQuery.isLoading}
              >
                <option value="">Auto (route by credential)</option>
                {executionTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.slug} ({t.kind}{t.status !== "active" ? `, ${t.status}` : ""})
                  </option>
                ))}
              </select>
              {executionTargetsQuery.isError && (
                <p className="text-xs text-muted-foreground">
                  Execution targets are only visible to organization admins.
                </p>
              )}
            </div>
          )}

          {form.targetType === "sandbox-docker" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Docker Image <span className="text-destructive">*</span>
                </label>
                <Input
                  required
                  placeholder="node:22-bookworm"
                  value={form.targetImage}
                  onChange={(e) => setForm((f) => ({ ...f, targetImage: e.target.value }))}
                  data-testid="environment-target-image-input"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Workdir
                  </label>
                  <Input
                    placeholder="/workspace"
                    value={form.targetWorkdir}
                    onChange={(e) => setForm((f) => ({ ...f, targetWorkdir: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Shell
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={form.targetShell}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, targetShell: e.target.value === "bash" ? "bash" : "sh" }))
                    }
                  >
                    <option value="sh">sh</option>
                    <option value="bash">bash</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Network
                  </label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={form.targetNetwork}
                    onChange={(e) => {
                      const value = e.target.value;
                      setForm((f) => ({
                        ...f,
                        targetNetwork: value === "host" || value === "none" ? value : "bridge",
                      }));
                    }}
                  >
                    <option value="bridge">bridge</option>
                    <option value="host">host</option>
                    <option value="none">none</option>
                  </select>
                </div>
              </div>
              <Input
                placeholder="Optional install command"
                value={form.targetInstallCommand}
                onChange={(e) => setForm((f) => ({ ...f, targetInstallCommand: e.target.value }))}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.targetRemove}
                  onChange={(e) => setForm((f) => ({ ...f, targetRemove: e.target.checked }))}
                  className="h-4 w-4 rounded border-input"
                />
                Remove container after run
              </label>
            </div>
          )}

          {form.targetType === "e2b" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                E2B Credentials
              </label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.e2bCredentialMode}
                onChange={(e) => {
                  setForm((f) => ({
                    ...f,
                    e2bCredentialMode: e.target.value === "secret" ? "secret" : "default",
                  }));
                  setConfigError(null);
                  setProbeResult(null);
                }}
                data-testid="environment-e2b-credential-mode"
              >
                <option value="default">Company default provider key</option>
                <option value="secret">Specific secret</option>
              </select>
              {form.e2bCredentialMode === "secret" && (
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={form.e2bCredentialSecretId}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, e2bCredentialSecretId: e.target.value }));
                    setConfigError(null);
                    setProbeResult(null);
                  }}
                  data-testid="environment-e2b-secret-select"
                >
                  <option value="">Choose secret</option>
                  {secrets.filter((secret) => secret.status === "active" && !secret.deletedAt).map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}{secret.key ? ` (${secret.key})` : ""}
                    </option>
                  ))}
                </select>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Template
                  </label>
                  <Input
                    value={form.e2bTemplate}
                    onChange={(e) => setForm((f) => ({ ...f, e2bTemplate: e.target.value }))}
                    placeholder="base"
                    data-testid="environment-e2b-template-input"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Timeout ms
                  </label>
                  <Input
                    value={form.e2bTimeoutMs}
                    onChange={(e) => setForm((f) => ({ ...f, e2bTimeoutMs: e.target.value }))}
                    placeholder="60000"
                    inputMode="numeric"
                    data-testid="environment-e2b-timeout-input"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.e2bReuseLease}
                  onChange={(e) => setForm((f) => ({ ...f, e2bReuseLease: e.target.checked }))}
                  className="h-4 w-4 rounded border-input"
                />
                Reuse sandbox lease when possible
              </label>
              {configError && (
                <p className="text-xs text-destructive">{configError}</p>
              )}
              {probeResult && (
                <p className={cn("text-xs", probeResult.ok ? "text-emerald-600" : "text-destructive")}>
                  {probeResult.summary}
                </p>
              )}
              {probeMutation.isError && (
                <p className="text-xs text-destructive">
                  {probeMutation.error instanceof Error ? probeMutation.error.message : "Environment test failed"}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleProbe}
                disabled={probeMutation.isPending}
              >
                {probeMutation.isPending ? "Testing..." : "Test Environment"}
              </Button>
            </div>
          )}

          {/* Connection target */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Connection Target <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <p className="text-xs text-muted-foreground">
              JSON object describing the target infrastructure (e.g. host, port, region).
            </p>
            <Textarea
              rows={4}
              placeholder='{"host": "db.example.com", "port": 5432}'
              value={form.connectionTargetRaw}
              onChange={(e) => {
                setForm((f) => ({ ...f, connectionTargetRaw: e.target.value }));
                setConnectionTargetError(null);
              }}
              className={cn("font-mono text-xs", connectionTargetError && "border-destructive")}
            />
            {connectionTargetError && (
              <p className="text-xs text-destructive">{connectionTargetError}</p>
            )}
          </div>

          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={!form.name.trim() || isPending}
            >
              {isPending
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Row skeleton
// ---------------------------------------------------------------------------

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-md border border-border px-4 py-3">
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-7 w-14" />
      <Skeleton className="h-7 w-14" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function EnvironmentsSection({
  companyId,
  organizationId = null,
  deploymentMode = "local_trusted",
}: {
  companyId: string;
  organizationId?: string | null;
  deploymentMode?: DeploymentMode;
}) {
  const cloudMode = deploymentMode === "cloud_auth";
  const { data: environments, isLoading, isError } = useEnvironments(companyId);
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });

  const createMutation = useCreateEnvironment();
  const updateMutation = useUpdateEnvironment();
  const deleteMutation = useDeleteEnvironment();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Environment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);

  function handleCreate(input: CreateEnvironmentInput | UpdateEnvironmentInput) {
    createMutation.mutate(
      { companyId, input: input as CreateEnvironmentInput },
      { onSuccess: () => setCreateOpen(false) },
    );
  }

  function handleUpdate(input: CreateEnvironmentInput | UpdateEnvironmentInput) {
    if (!editTarget) return;
    updateMutation.mutate(
      { companyId, id: editTarget.id, input: input as UpdateEnvironmentInput },
      { onSuccess: () => setEditTarget(null) },
    );
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { companyId, id: deleteTarget.id },
      { onSuccess: () => setDeleteTarget(null) },
    );
  }

  const envVarCount = (env: Environment) =>
    Object.keys(env.envVars ?? {}).length;

  const createErrorMessage = createMutation.isError
    ? createMutation.error instanceof Error
      ? createMutation.error.message
      : "Failed to create environment"
    : null;
  const updateErrorMessage = updateMutation.isError
    ? updateMutation.error instanceof Error
      ? updateMutation.error.message
      : "Failed to update environment"
    : null;

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Section header                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <div className="flex items-center justify-between gap-4 mt-1">
          <div>
            <h2 className="text-[1.4rem] font-bold tracking-tight">
              Environments<span className="text-brand">.</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Named sets of environment variables and connection targets injected into agent runs.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="shrink-0"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Environment
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Content                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="p-8">
        {isLoading ? (
          <div className="space-y-2">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Failed to load environments. Please refresh and try again.
          </div>
        ) : !environments || environments.length === 0 ? (
          /* Empty state */
          <div className="rounded-lg border border-border bg-card py-12 text-center">
            <Layers className="mx-auto h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-foreground">No environments yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4 max-w-xs mx-auto">
              Create an environment to inject variables and connection details into agent runs.
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create your first environment
            </Button>
          </div>
        ) : (
          /* Environment list */
          <div className="space-y-2">
            {environments.map((env) => (
              <div
                key={env.id}
                className="flex items-center gap-4 rounded-md border border-border px-4 py-3 hover:bg-accent/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{env.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {envVarCount(env) === 0
                      ? "No variables"
                      : `${envVarCount(env)} variable${envVarCount(env) === 1 ? "" : "s"}`}
                    {env.connectionTarget
                      ? " · connection target set"
                      : ""}
                    {" · "}
                    {formatTargetSummary(env)}
                    {" · "}
                    Created {formatDate(env.createdAt)}
                  </div>
                  {cloudMode && !(
                    env.driver === "sandbox"
                    && env.config?.provider === "e2b"
                    && env.target == null
                    && env.executionTargetId == null
                  ) && (
                    <div className="mt-1 text-xs text-amber-500">
                      Unavailable on AoA Cloud. Edit this environment and migrate it to unpinned E2B.
                    </div>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditTarget(env)}
                  title="Edit environment"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="sr-only">Edit</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget(env)}
                  title="Delete environment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Delete</span>
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Mutation errors */}
        {createMutation.isError && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {createMutation.error instanceof Error
              ? createMutation.error.message
              : "Failed to create environment"}
          </div>
        )}
        {updateMutation.isError && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {updateMutation.error instanceof Error
              ? updateMutation.error.message
              : "Failed to update environment"}
          </div>
        )}
        {deleteMutation.isError && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {deleteMutation.error instanceof Error
              ? deleteMutation.error.message
              : "Failed to delete environment"}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Create dialog                                                       */}
      {/* ------------------------------------------------------------------ */}
      <EnvironmentDialog
        companyId={companyId}
        organizationId={organizationId}
        open={createOpen}
        mode="create"
        isPending={createMutation.isPending}
        submitError={createErrorMessage}
        secrets={secretsQuery.data ?? []}
        onClose={() => { setCreateOpen(false); createMutation.reset(); }}
        onSubmit={handleCreate}
        cloudMode={cloudMode}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Edit dialog                                                         */}
      {/* ------------------------------------------------------------------ */}
      <EnvironmentDialog
        companyId={companyId}
        organizationId={organizationId}
        open={!!editTarget}
        mode="edit"
        initial={editTarget ?? undefined}
        isPending={updateMutation.isPending}
        submitError={updateErrorMessage}
        secrets={secretsQuery.data ?? []}
        onClose={() => { setEditTarget(null); updateMutation.reset(); }}
        onSubmit={handleUpdate}
        cloudMode={cloudMode}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Delete confirmation                                                 */}
      {/* ------------------------------------------------------------------ */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> will be permanently deleted. Agent runs that
              reference this environment will no longer receive its variables.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wrapper that reads companyId from context (matches the pattern used by other
// sections — they all either get companyId from props or from CompanyContext).
// ---------------------------------------------------------------------------

export function EnvironmentsSectionWrapper() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Select a company to manage environments.</p>
      </div>
    );
  }

  return (
    <EnvironmentsSection
      companyId={selectedCompanyId}
      organizationId={selectedCompany?.organizationId ?? null}
      deploymentMode={healthQuery.data?.deploymentMode}
    />
  );
}
