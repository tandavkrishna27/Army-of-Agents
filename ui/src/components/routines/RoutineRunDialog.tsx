import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { RoutineVariable } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export interface RoutineRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routineId: string;
  routineTitle: string;
  variables: RoutineVariable[];
  onRunComplete?: () => void;
}

type VariableValue = string | number | boolean | "";

function initialValueFor(variable: RoutineVariable): VariableValue {
  if (variable.defaultValue == null) {
    if (variable.type === "boolean") return "";
    return "";
  }
  if (variable.type === "boolean") return variable.defaultValue === true;
  if (variable.type === "number") {
    const parsed = typeof variable.defaultValue === "number"
      ? variable.defaultValue
      : Number(variable.defaultValue);
    return Number.isFinite(parsed) ? parsed : "";
  }
  return String(variable.defaultValue);
}

function buildInitialValues(variables: RoutineVariable[]): Record<string, VariableValue> {
  return Object.fromEntries(variables.map((variable) => [variable.name, initialValueFor(variable)]));
}

function isMissingValue(value: VariableValue): boolean {
  if (value === "") return true;
  if (typeof value === "string" && value.trim().length === 0) return true;
  return false;
}

function serializeVariableForSubmit(
  variable: RoutineVariable,
  raw: VariableValue,
): string | number | boolean | null {
  if (isMissingValue(raw)) return null;
  if (variable.type === "boolean") return raw === true;
  if (variable.type === "number") {
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(raw);
}

export function RoutineRunDialog({
  open,
  onOpenChange,
  routineId,
  routineTitle,
  variables,
  onRunComplete,
}: RoutineRunDialogProps) {
  const { pushToast } = useToast();
  const [values, setValues] = useState<Record<string, VariableValue>>(() =>
    buildInitialValues(variables),
  );

  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
  }, [open, variables]);

  const missingRequired = useMemo(
    () =>
      variables
        .filter((variable) => variable.required)
        .filter((variable) => isMissingValue(values[variable.name] ?? ""))
        .map((variable) => variable.label || variable.name),
    [values, variables],
  );

  const runMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { source: "manual" };
      if (variables.length > 0) {
        const overrides: Record<string, string> = {};
        for (const variable of variables) {
          const raw = values[variable.name] ?? "";
          const serialized = serializeVariableForSubmit(variable, raw);
          if (serialized !== null) overrides[variable.name] = String(serialized);
        }
        if (Object.keys(overrides).length > 0) payload.variableOverrides = overrides;
      }
      return routinesApi.run(routineId, payload);
    },
    onSuccess: () => {
      pushToast({ tone: "success", title: "Routine run queued" });
      onOpenChange(false);
      onRunComplete?.();
    },
    onError: (error: Error) => {
      pushToast({ tone: "error", title: "Could not run routine", body: error.message });
    },
  });

  const canSubmit = missingRequired.length === 0 && !runMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !runMutation.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Run routine</DialogTitle>
          <DialogDescription>{routineTitle}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {variables.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No variables to set. This routine will run immediately.
          </div>
        ) : (
          <div className="space-y-4">
            {variables.map((variable) => {
              const label = variable.label || variable.name;
              const inputId = `routine-run-${variable.name}`;
              const currentValue = values[variable.name] ?? "";
              return (
                <div key={variable.name} className="space-y-1.5">
                  <Label htmlFor={inputId} className="text-xs">
                    {label}
                    {variable.required ? " *" : ""}
                  </Label>
                  {variable.type === "textarea" ? (
                    <Textarea
                      id={inputId}
                      rows={4}
                      value={typeof currentValue === "string" ? currentValue : ""}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [variable.name]: event.target.value }))
                      }
                    />
                  ) : variable.type === "boolean" ? (
                    <Select
                      value={
                        currentValue === true
                          ? "true"
                          : currentValue === false
                          ? "false"
                          : "__unset__"
                      }
                      onValueChange={(next) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next === "true",
                        }))
                      }
                    >
                      <SelectTrigger id={inputId}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No value</SelectItem>
                        <SelectItem value="true">True</SelectItem>
                        <SelectItem value="false">False</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : variable.type === "select" ? (
                    <Select
                      value={typeof currentValue === "string" && currentValue ? currentValue : "__unset__"}
                      onValueChange={(next) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next,
                        }))
                      }
                    >
                      <SelectTrigger id={inputId}>
                        <SelectValue placeholder="Choose a value" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No value</SelectItem>
                        {variable.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={inputId}
                      type={variable.type === "number" ? "number" : "text"}
                      value={currentValue === "" || currentValue == null ? "" : String(currentValue)}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [variable.name]: event.target.value }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        </DialogBody>

        <DialogFooter showCloseButton={false}>
          {missingRequired.length > 0 ? (
            <p className="mr-auto text-xs text-amber-600">
              Missing: {missingRequired.join(", ")}
            </p>
          ) : (
            <span className="mr-auto" />
          )}
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={runMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => runMutation.mutate()} disabled={!canSubmit}>
            {runMutation.isPending ? "Running..." : "Run routine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
