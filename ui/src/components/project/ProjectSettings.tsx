import { useEffect, useState, type ReactNode } from "react";
import type { Project } from "@armyofagents/shared";
import { ProjectProperties } from "../ProjectProperties";
import { WorkspaceRuntimeSettings } from "./WorkspaceRuntimeSettings";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";

interface ProjectSettingsProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  environmentContent?: ReactNode;
}

function HumanQuestionSettings({ project, onUpdate }: Pick<ProjectSettingsProps, "project" | "onUpdate">) {
  const { selectedCompany } = useCompany();
  const companyHours = selectedCompany?.humanQuestionSlaHours ?? 24;
  const [customHours, setCustomHours] = useState(project.humanQuestionSlaHours ?? companyHours);

  useEffect(() => {
    setCustomHours(project.humanQuestionSlaHours ?? companyHours);
  }, [project.humanQuestionSlaHours, companyHours]);

  const inherited = project.humanQuestionSlaHours == null;
  return (
    <div className="space-y-3">
      <label className="grid gap-1 text-sm font-medium text-foreground">
        <span>Response-time policy</span>
        <select
          aria-label="Project human question response-time policy"
          value={inherited ? "company" : "project"}
          disabled={!onUpdate}
          onChange={(event) => {
            if (event.target.value === "company") {
              onUpdate?.({ humanQuestionSlaHours: null });
            } else {
              onUpdate?.({ humanQuestionSlaHours: customHours });
            }
          }}
          className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="company">Inherit company ({companyHours} elapsed hours)</option>
          <option value="project">Use a project override</option>
        </select>
      </label>
      {!inherited ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Project human question response time"
            type="number"
            min={1}
            max={24 * 30}
            value={customHours}
            onChange={(event) => setCustomHours(Number(event.target.value))}
            className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <span className="text-sm text-muted-foreground">elapsed hours</span>
          <Button
            type="button"
            size="sm"
            disabled={
              !onUpdate
              || !Number.isInteger(customHours)
              || customHours < 1
              || customHours > 24 * 30
              || customHours === project.humanQuestionSlaHours
            }
            onClick={() => onUpdate?.({ humanQuestionSlaHours: customHours })}
          >
            Save
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Applies to new agent questions in this department or project. Existing deadlines are not rewritten.
      </p>
    </div>
  );
}

export function ProjectSettings({ project, onUpdate, environmentContent }: ProjectSettingsProps) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 pt-2" data-testid="project-settings">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Department details</h2>
          <p className="text-sm text-muted-foreground">
            Basic profile, status, linked goals, and ownership details for this department.
          </p>
        </div>
        <ProjectProperties project={project} onUpdate={onUpdate} />
      </section>
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Workspace & Runtime</h2>
          <p className="text-sm text-muted-foreground">
            Defaults for new tasks and future agent runs. Existing workspaces are not moved by these settings.
          </p>
        </div>
        <WorkspaceRuntimeSettings project={project} onUpdate={onUpdate} />
      </section>
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Human questions</h2>
          <p className="text-sm text-muted-foreground">
            Set when unanswered agent questions become At risk for this scope.
          </p>
        </div>
        <HumanQuestionSettings project={project} onUpdate={onUpdate} />
      </section>
      {environmentContent && (
        <section className="space-y-4">
          {environmentContent}
        </section>
      )}
    </div>
  );
}
