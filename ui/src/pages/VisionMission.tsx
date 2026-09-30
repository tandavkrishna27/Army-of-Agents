import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";
import { Field } from "../components/agent-config-primitives";

export function VisionMission() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [vision, setVision] = useState("");
  const [mission, setMission] = useState("");
  const [values, setValues] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/home" },
      { label: "Vision & Mission" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  useEffect(() => {
    if (!selectedCompany) return;
    setVision(selectedCompany.vision ?? "");
    setMission(selectedCompany.mission ?? "");
    setValues(selectedCompany.values ?? "");
  }, [selectedCompany]);

  const dirty =
    !!selectedCompany &&
    (vision !== (selectedCompany.vision ?? "") ||
      mission !== (selectedCompany.mission ?? "") ||
      values !== (selectedCompany.values ?? ""));

  const mutation = useMutation({
    mutationFn: (data: {
      vision: string | null;
      mission: string | null;
      values: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSave() {
    mutation.mutate({
      vision: vision.trim() || null,
      mission: mission.trim() || null,
      values: values.trim() || null,
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Compass className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Vision & Mission</h1>
      </div>

      {/* Vision */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Vision
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Where are we headed?" hint="A single-line statement describing the future you're building toward.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={vision}
              placeholder="e.g. Make AI accessible to every small business"
              onChange={(e) => setVision(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Mission */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Mission
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="How do we get there?" hint="A short statement describing your approach and strategy.">
            <textarea
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none resize-none"
              rows={3}
              value={mission}
              placeholder="e.g. We build tools that let founders run hybrid AI + human teams from a single control room"
              onChange={(e) => setMission(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Values */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Values
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="What do we stand for?" hint="Core principles that guide decisions. One per line works well.">
            <textarea
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none resize-none"
              rows={5}
              value={values}
              placeholder={"e.g.\nShip fast, fix faster\nFounder knows best\nAgents are teammates, not tools"}
              onChange={(e) => setValues(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Save */}
      {dirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {mutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {mutation.isError && (
            <span className="text-xs text-destructive">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Failed to save"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
