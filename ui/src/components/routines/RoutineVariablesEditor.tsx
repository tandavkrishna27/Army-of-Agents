import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ROUTINE_VARIABLE_TYPES,
  syncRoutineVariablesWithTemplate,
  type Routine,
  type RoutineVariable,
  type RoutineVariableType,
} from "@armyofagents/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { routinesApi } from "@/api/routines";
import { useToast } from "@/context/ToastContext";

interface RoutineVariablesEditorProps {
  routineId: string;
  title: string;
  description: string | null;
  initialVariables: RoutineVariable[];
  getBaseRevisionId: () => string | null;
  onRoutineUpdated: (routine: Routine) => void;
}

function parseSelectOptions(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function replaceVariable(
  variables: RoutineVariable[],
  name: string,
  mutate: (variable: RoutineVariable) => RoutineVariable,
): RoutineVariable[] {
  return variables.map((variable) => (variable.name === name ? mutate(variable) : variable));
}

function serializeVariables(value: RoutineVariable[]): string {
  return JSON.stringify(value);
}

export function RoutineVariablesEditor({
  routineId,
  title,
  description,
  initialVariables,
  getBaseRevisionId,
  onRoutineUpdated,
}: RoutineVariablesEditorProps) {
  const { pushToast } = useToast();
  const detected = useMemo(
    () => syncRoutineVariablesWithTemplate([title, description], initialVariables),
    [title, description, initialVariables],
  );
  const [draft, setDraft] = useState<RoutineVariable[]>(detected);

  useEffect(() => {
    setDraft(detected);
  }, [detected]);

  const isDirty = serializeVariables(draft) !== serializeVariables(initialVariables);

  const saveMutation = useMutation({
    mutationFn: async (variables: RoutineVariable[]) => routinesApi.update(routineId, {
      variables,
      baseRevisionId: getBaseRevisionId(),
    }),
    onSuccess: (updated) => {
      onRoutineUpdated(updated);
      pushToast({ tone: "success", title: "Variables saved" });
    },
    onError: (error: Error) => {
      pushToast({ tone: "error", title: "Could not save variables", body: error.message });
    },
  });

  if (draft.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground space-y-2">
        <p>No variables detected.</p>
        <p className="text-xs">
          Use <code className="font-mono text-foreground">{"{{variable_name}}"}</code> placeholders in the
          routine title or instructions to prompt for values at runtime.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Variables are detected from <code className="font-mono">{"{{name}}"}</code> placeholders in the routine
        title and instructions. Configure how each value is prompted when the routine runs.
      </p>

      {draft.map((variable) => (
        <div key={variable.name} className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {`{{${variable.name}}}`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Prompted before each manual run.
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`var-${variable.name}-label`} className="text-xs">
                Label
              </Label>
              <Input
                id={`var-${variable.name}-label`}
                value={variable.label ?? ""}
                placeholder={variable.name.replaceAll("_", " ")}
                onChange={(event) =>
                  setDraft((current) =>
                    replaceVariable(current, variable.name, (v) => ({
                      ...v,
                      label: event.target.value || null,
                    })),
                  )
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select
                value={variable.type}
                onValueChange={(next) =>
                  setDraft((current) =>
                    replaceVariable(current, variable.name, (v) => ({
                      ...v,
                      type: next as RoutineVariableType,
                      defaultValue: next === "boolean" ? null : v.defaultValue,
                      options: next === "select" ? v.options : [],
                    })),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTINE_VARIABLE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Default value</Label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={variable.required}
                    onCheckedChange={(next) =>
                      setDraft((current) =>
                        replaceVariable(current, variable.name, (v) => ({
                          ...v,
                          required: next === true,
                        })),
                      )
                    }
                  />
                  Required
                </label>
              </div>

              {variable.type === "textarea" ? (
                <Textarea
                  rows={3}
                  value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceVariable(current, variable.name, (v) => ({
                        ...v,
                        defaultValue: event.target.value || null,
                      })),
                    )
                  }
                />
              ) : variable.type === "boolean" ? (
                <Select
                  value={
                    variable.defaultValue === true
                      ? "true"
                      : variable.defaultValue === false
                      ? "false"
                      : "__unset__"
                  }
                  onValueChange={(next) =>
                    setDraft((current) =>
                      replaceVariable(current, variable.name, (v) => ({
                        ...v,
                        defaultValue: next === "__unset__" ? null : next === "true",
                      })),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unset__">No default</SelectItem>
                    <SelectItem value="true">True</SelectItem>
                    <SelectItem value="false">False</SelectItem>
                  </SelectContent>
                </Select>
              ) : variable.type === "select" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Options (comma-separated)</Label>
                    <Input
                      value={variable.options.join(", ")}
                      placeholder="high, medium, low"
                      onChange={(event) => {
                        const options = parseSelectOptions(event.target.value);
                        setDraft((current) =>
                          replaceVariable(current, variable.name, (v) => ({
                            ...v,
                            options,
                            defaultValue:
                              typeof v.defaultValue === "string" && options.includes(v.defaultValue)
                                ? v.defaultValue
                                : null,
                          })),
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Default option</Label>
                    <Select
                      value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                      onValueChange={(next) =>
                        setDraft((current) =>
                          replaceVariable(current, variable.name, (v) => ({
                            ...v,
                            defaultValue: next === "__unset__" ? null : next,
                          })),
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="No default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No default</SelectItem>
                        {variable.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : (
                <Input
                  type={variable.type === "number" ? "number" : "text"}
                  value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                  placeholder={variable.type === "number" ? "42" : "Default value"}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceVariable(current, variable.name, (v) => ({
                        ...v,
                        defaultValue: event.target.value || null,
                      })),
                    )
                  }
                />
              )}
            </div>
          </div>
        </div>
      ))}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!isDirty || saveMutation.isPending}
          onClick={() => setDraft(detected)}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!isDirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(draft)}
        >
          {saveMutation.isPending ? "Saving..." : "Save variables"}
        </Button>
      </div>
    </div>
  );
}
