import { useEffect, useState } from "react";
import type {
  AdapterConfigFieldSchema,
  AdapterConfigSchema,
  CreateConfigValues,
} from "@armyofagents/adapter-utils";
import type { AdapterConfigFieldsProps } from "./types";
import { Field, DraftInput, DraftNumberInput, DraftTextarea, ToggleField } from "../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const schemaCache = new Map<string, AdapterConfigSchema | null>();
const schemaFetchInflight = new Map<string, Promise<AdapterConfigSchema | null>>();
const failedSchemaTypes = new Set<string>();

async function fetchConfigSchema(adapterType: string): Promise<AdapterConfigSchema | null> {
  const cached = schemaCache.get(adapterType);
  if (cached !== undefined) return cached;
  if (failedSchemaTypes.has(adapterType)) return null;

  const inflight = schemaFetchInflight.get(adapterType);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/config-schema`);
      if (!res.ok) {
        failedSchemaTypes.add(adapterType);
        return null;
      }
      const schema = (await res.json()) as AdapterConfigSchema;
      schemaCache.set(adapterType, schema);
      return schema;
    } catch {
      failedSchemaTypes.add(adapterType);
      return null;
    } finally {
      schemaFetchInflight.delete(adapterType);
    }
  })();

  schemaFetchInflight.set(adapterType, promise);
  return promise;
}

export function invalidateConfigSchemaCache(adapterType: string): void {
  schemaCache.delete(adapterType);
  failedSchemaTypes.delete(adapterType);
}

function useConfigSchema(adapterType: string): AdapterConfigSchema | null {
  const [schema, setSchema] = useState<AdapterConfigSchema | null>(
    schemaCache.get(adapterType) ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    fetchConfigSchema(adapterType).then((next) => {
      if (!cancelled) setSchema(next);
    });
    return () => {
      cancelled = true;
    };
  }, [adapterType]);

  return schema;
}

function getDefaultValue(field: AdapterConfigFieldSchema): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case "boolean":
      return false;
    case "number":
      return 0;
    default:
      return "";
  }
}

export function fieldMatchesVisibleWhen(
  field: AdapterConfigFieldSchema,
  readValue: (field: AdapterConfigFieldSchema) => unknown,
  schema: AdapterConfigSchema,
): boolean {
  const visibleWhen = field.meta?.visibleWhen;
  if (!visibleWhen || typeof visibleWhen !== "object" || Array.isArray(visibleWhen)) return true;

  const condition = visibleWhen as {
    key?: unknown;
    value?: unknown;
    values?: unknown;
    notValues?: unknown;
  };
  if (typeof condition.key !== "string" || condition.key.length === 0) return true;

  const sourceField = schema.fields.find((candidate) => candidate.key === condition.key);
  if (!sourceField) return true;

  const actual = String(readValue(sourceField) ?? "");
  if (typeof condition.value === "string") return actual === condition.value;
  if (Array.isArray(condition.values)) {
    const values = condition.values.filter((value): value is string => typeof value === "string");
    return values.length > 0 && values.includes(actual);
  }
  if (Array.isArray(condition.notValues)) {
    const values = condition.notValues.filter((value): value is string => typeof value === "string");
    return !values.includes(actual);
  }
  return true;
}

export function SchemaConfigFields({
  adapterType,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const schema = useConfigSchema(adapterType);

  useEffect(() => {
    if (!schema || !isCreate) return;
    const defaults: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const defaultValue = getDefaultValue(field);
      if (defaultValue !== undefined && defaultValue !== "") {
        defaults[field.key] = defaultValue;
      }
    }
    if (Object.keys(defaults).length > 0) {
      set?.({
        adapterSchemaValues: { ...defaults, ...values?.adapterSchemaValues },
      });
    }
  }, [schema, isCreate, set, values?.adapterSchemaValues]);

  if (!schema || schema.fields.length === 0) return null;

  function readValue(field: AdapterConfigFieldSchema): unknown {
    if (isCreate) {
      return values?.adapterSchemaValues?.[field.key] ?? getDefaultValue(field);
    }
    const stored = config[field.key];
    return eff("adapterConfig", field.key, (stored ?? getDefaultValue(field)) as string);
  }

  function writeValue(field: AdapterConfigFieldSchema, value: unknown): void {
    if (isCreate) {
      set?.({
        adapterSchemaValues: {
          ...values?.adapterSchemaValues,
          [field.key]: value,
        },
      });
    } else {
      mark("adapterConfig", field.key, value);
    }
  }

  return (
    <>
      {schema.fields
        .filter((field) => fieldMatchesVisibleWhen(field, readValue, schema))
        .map((field) => {
          const hint = field.hint ?? field.description;
          switch (field.type) {
            case "select":
              return (
                <Field key={field.key} label={field.label} hint={hint}>
                  <select
                    className={inputClass}
                    value={String(readValue(field) ?? "")}
                    onChange={(event) => writeValue(field, event.target.value)}
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            case "boolean":
              return (
                <ToggleField
                  key={field.key}
                  label={field.label}
                  hint={hint}
                  checked={readValue(field) === true}
                  onChange={(value) => writeValue(field, value)}
                />
              );
            case "number":
              return (
                <Field key={field.key} label={field.label} hint={hint}>
                  <DraftNumberInput
                    value={Number(readValue(field) ?? 0)}
                    onCommit={(value) => writeValue(field, value)}
                    immediate
                    className={inputClass}
                  />
                </Field>
              );
            case "textarea":
            case "json":
            case "env":
              return (
                <Field key={field.key} label={field.label} hint={hint}>
                  <DraftTextarea
                    value={String(readValue(field) ?? "")}
                    onCommit={(value) => writeValue(field, value || undefined)}
                    immediate
                  />
                </Field>
              );
            case "secret":
            case "text":
            default:
              return (
                <Field key={field.key} label={field.label} hint={hint}>
                  <DraftInput
                    value={String(readValue(field) ?? "")}
                    onCommit={(value) => writeValue(field, value || undefined)}
                    immediate
                    className={inputClass}
                  />
                </Field>
              );
          }
        })}
    </>
  );
}

export function buildSchemaAdapterConfig(values: CreateConfigValues): Record<string, unknown> {
  const adapterConfig: Record<string, unknown> = {};

  if (values.model?.trim()) adapterConfig.model = values.model.trim();
  if (values.cwd) adapterConfig.cwd = values.cwd;
  if (values.command) adapterConfig.command = values.command;
  if (values.instructionsFilePath) adapterConfig.instructionsFilePath = values.instructionsFilePath;
  if (values.thinkingEffort) adapterConfig.thinkingEffort = values.thinkingEffort;

  if (values.extraArgs) {
    adapterConfig.extraArgs = values.extraArgs.split(/\s+/).filter(Boolean);
  }

  if (values.adapterSchemaValues) {
    Object.assign(adapterConfig, values.adapterSchemaValues);
  }

  return adapterConfig;
}
