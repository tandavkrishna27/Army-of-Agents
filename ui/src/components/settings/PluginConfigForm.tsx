/**
 * Renders a configuration form from a JSON Schema (manifest.instanceConfigSchema).
 * Supports: string (text input), string+format:password (password input),
 * boolean (toggle), number (number input).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as pluginsApi from "../../api/plugins.js";
import { useToast } from "../../context/ToastContext.js";

interface JsonSchemaProperty {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface Props {
  companyId: string;
  pluginId: string;
  schema: JsonSchema | undefined;
  initialValues: Record<string, unknown>;
  onSaved?: () => void;
}

export function PluginConfigForm({ companyId, pluginId, schema, initialValues, onSaved }: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.savePluginConfig(companyId, pluginId, configJson),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      pushToast({ title: "Settings saved", tone: "success" });
      onSaved?.();
    },
    onError: (err: Error) => pushToast({ title: "Save failed", body: err.message, tone: "error" }),
  });

  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return (
      <p className="text-xs text-zinc-500 py-2">This plugin has no configurable settings.</p>
    );
  }

  function handleChange(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSave() {
    const errors: Record<string, string> = {};
    for (const key of schema?.required ?? []) {
      if (values[key] === undefined || values[key] === "") {
        errors[key] = "Required";
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    mutation.mutate(values);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        Company-scoped config. Each company has independent values.
      </p>

      {Object.entries(schema.properties).map(([key, prop]) => {
        const label = prop.title ?? key;
        const isPassword = prop.format === "password";
        const isBoolean = prop.type === "boolean";
        const isNumber = prop.type === "number" || prop.type === "integer";
        const error = fieldErrors[key];

        return (
          <div key={key} className="space-y-1.5">
            {isBoolean ? (
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-zinc-400">{label}</div>
                  {prop.description && (
                    <div className="text-[10px] text-zinc-600">{prop.description}</div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!values[key]}
                  onClick={() => handleChange(key, !values[key])}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                    values[key] ? "bg-indigo-600" : "bg-zinc-700"
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform mt-[3px] ${
                      values[key] ? "translate-x-4.5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            ) : (
              <>
                <label className="block text-xs font-semibold text-zinc-400">{label}</label>
                {prop.description && (
                  <div className="text-[10px] text-zinc-600">{prop.description}</div>
                )}
                <input
                  type={isPassword ? "password" : isNumber ? "number" : "text"}
                  value={String(values[key] ?? "")}
                  onChange={(e) => handleChange(key, isNumber ? Number(e.target.value) : e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
                {error && <p className="text-[10px] text-red-400">{error}</p>}
              </>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={handleSave}
        disabled={mutation.isPending}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold py-2 rounded-md transition-colors"
      >
        {mutation.isPending ? "Saving…" : "Save settings"}
      </button>

    </div>
  );
}
