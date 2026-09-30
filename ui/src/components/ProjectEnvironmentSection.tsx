import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EnvBinding, CompanySecret } from "@armyofagents/shared";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";

const inputClass =
  "h-7 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/* ── Env var editor (mirrors EnvVarEditor in AgentConfigForm) ── */

type Row = {
  key: string;
  source: "plain" | "secret";
  plainValue: string;
  secretId: string;
};

function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
  if (!rec || typeof rec !== "object") {
    return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
  }
  const entries = Object.entries(rec).map(([k, binding]) => {
    if (typeof binding === "string") {
      return { key: k, source: "plain" as const, plainValue: binding, secretId: "" };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding
    ) {
      const b = binding as { type?: unknown; value?: unknown; secretId?: unknown };
      if (b.type === "secret_ref") {
        return {
          key: k,
          source: "secret" as const,
          plainValue: "",
          secretId: typeof b.secretId === "string" ? b.secretId : "",
        };
      }
      if (b.type === "plain") {
        return {
          key: k,
          source: "plain" as const,
          plainValue: typeof b.value === "string" ? b.value : "",
          secretId: "",
        };
      }
    }
    return { key: k, source: "plain" as const, plainValue: "", secretId: "" };
  });
  return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
}

function rowsToEnv(rows: Row[]): Record<string, EnvBinding> | null {
  const rec: Record<string, EnvBinding> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    if (row.source === "secret") {
      if (!row.secretId) continue;
      rec[k] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
    } else {
      rec[k] = { type: "plain", value: row.plainValue };
    }
  }
  return Object.keys(rec).length > 0 ? rec : null;
}

function defaultSecretName(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function EnvEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding> | null;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, plainValue: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    onChange(rowsToEnv(nextRows));
  }

  function updateRow(i: number, patch: Partial<Row>) {
    const withPatch = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    const last = withPatch[withPatch.length - 1];
    if (last && (last.key || last.plainValue || last.secretId)) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (
      next.length === 0 ||
      (next[next.length - 1] &&
        (next[next.length - 1].key ||
          next[next.length - 1].plainValue ||
          next[next.length - 1].secretId))
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  async function sealRow(i: number) {
    const row = rows[i];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;
    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;
    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(i, { source: "secret", secretId: created.id });
    } catch (err) {
      setSealError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const isTrailing =
          i === rows.length - 1 && !row.key && !row.plainValue && !row.secretId;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(e) =>
                updateRow(i, {
                  source: e.target.value === "secret" ? "secret" : "plain",
                  ...(e.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  onChange={(e) => updateRow(i, { secretId: e.target.value })}
                >
                  <option value="">Select secret...</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  onChange={(e) => updateRow(i, { plainValue: e.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  title="Create secret from plain value"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing && (
              <button
                type="button"
                className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                onClick={() => removeRow(i)}
                aria-label="Remove variable"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {sealError && (
        <p className="text-xs text-destructive">{sealError}</p>
      )}
    </div>
  );
}

/* ── Main section component ── */

export function ProjectEnvironmentSection({ projectId }: { projectId: string }) {
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompany?.id ?? "";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projects.env(projectId),
    queryFn: () => projectsApi.getEnvironment(projectId),
    enabled: !!projectId,
  });

  const { data: secrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: !!companyId,
  });

  const [localEnv, setLocalEnv] = useState<Record<string, EnvBinding> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync from server when query resolves
  useEffect(() => {
    if (data !== undefined && !dirty) {
      setLocalEnv(data.env);
    }
  }, [data, dirty]);

  const saveEnv = useMutation({
    mutationFn: (env: Record<string, EnvBinding> | null) =>
      projectsApi.updateEnvironment(projectId, env),
    onSuccess: () => {
      setDirty(false);
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.env(projectId) });
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    },
  });

  const createSecret = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      secretsApi.create(companyId, { name, value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground">Loading environment variables...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Environment Variables</h3>
        {dirty && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                setLocalEnv(data?.env ?? null);
                setDirty(false);
                setSaveError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saveEnv.isPending}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              onClick={() => saveEnv.mutate(localEnv)}
            >
              {saveEnv.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Variables defined here are injected into agent runs for tasks in this project. Agent-level
        variables take precedence over project-level variables.
      </p>
      <EnvEditor
        value={localEnv}
        secrets={secrets}
        onCreateSecret={async (name, value) => {
          const created = await createSecret.mutateAsync({ name, value });
          return created;
        }}
        onChange={(env) => {
          setLocalEnv(env);
          setDirty(true);
        }}
      />
      {saveError && (
        <p className="text-xs text-destructive">{saveError}</p>
      )}
    </div>
  );
}
