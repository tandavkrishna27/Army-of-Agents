import { useEffect, useRef, useState } from "react";
import { issuesApi } from "../../api/issues";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "../steps/shared";

type AgentRow = { id: string; kind?: string; name?: string; status?: string };
type DepartmentRow = { id: string; name?: string; type?: string };

type CardStatus = "idle" | "creating" | "created" | "error";

/** Matches `NewIssueDialog`'s exact priority contract (value/label pairs). */
const PRIORITIES = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

export type FirstJobStepProps = {
  companyId: string;
  deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  onDone: () => void;
};

/**
 * WS8 — the In-flight "First job" surface (mockup S7f). Standalone, like
 * `DefineDepartments` (WS4) and `CreateAgents` (WS7): domain-only, no
 * `advanceOnboarding` call — WS9 wires this onto Home later.
 *
 * Task-only: **Create a task**, with a description, priority, and an
 * assignee/department, via `issuesApi.create`. The assignee picker is
 * populated from `agentsApi.list`, which already scopes to `kind: "org"`
 * (non-terminated) server-side — the ones the founder just hired in WS7,
 * never the hidden internal crew. The client-side filter below is a
 * defensive belt-and-braces guard, not the primary exclusion mechanism.
 * Once agents load, the assignee defaults to the first one (rather than
 * "Unassigned") so the task the founder just described lands on the agent
 * they just hired; if there are no agents yet, the picker still works with
 * only "Unassigned". Likewise, the department picker (`projectsApi.list`,
 * filtered to `type === "department"`) defaults to the first department
 * once loaded and is omitted from the card (and from the create payload)
 * entirely when there are none. Priority mirrors `NewIssueDialog`'s exact
 * value set (critical/high/medium/low) and defaults to "medium".
 *
 * Creating a task is optional — this is a reward, not a wall: "Skip to
 * Home" always works, with nothing required and nothing created. `onDone`
 * fires the first time task creation succeeds, or when Skip is pressed —
 * guarded via `fireOnDoneOnce` so a rapid double-submit only ever calls it
 * once.
 */
export function FirstJobStep({ companyId, deploymentMode, onDone }: FirstJobStepProps) {
  const cloudMode = deploymentMode === "cloud_auth";
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);

  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState<string>("medium");
  const [taskAssigneeId, setTaskAssigneeId] = useState("");
  const [taskProjectId, setTaskProjectId] = useState("");
  const [taskStatus, setTaskStatus] = useState<CardStatus>("idle");
  const [taskError, setTaskError] = useState<string | null>(null);

  const doneFiredRef = useRef(false);
  function fireOnDoneOnce() {
    if (doneFiredRef.current) return;
    doneFiredRef.current = true;
    onDone();
  }

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    agentsApi
      .list(companyId)
      .then((list) => {
        if (cancelled) return;
        const orgAgents = (list as AgentRow[]).filter(
          (a) => a.kind !== "aoa" && a.status !== "terminated",
        );
        setAgents(orgAgents);
        // Default the assignee to the agent the founder just hired in the
        // prior WS7 step, so "Unassigned" isn't the default when there's
        // obviously someone to assign to. Only applies if untouched.
        if (orgAgents.length > 0) {
          setTaskAssigneeId((prev) => prev || orgAgents[0]!.id);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setAgentsError(e instanceof Error ? e.message : "Couldn't load agents.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    projectsApi
      .list(companyId)
      .then((list) => {
        if (cancelled) return;
        const depts = (list as DepartmentRow[]).filter((p) => p.type === "department");
        setDepartments(depts);
        // Default to the department the founder chose earlier — omit
        // projectId entirely if there are none yet.
        if (depts.length > 0) {
          setTaskProjectId((prev) => prev || depts[0]!.id);
        }
      })
      .catch(() => {
        // Best-effort — task creation still works without a department.
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function handleCreateTask() {
    if (!taskTitle.trim() || taskStatus === "creating") return;
    setTaskStatus("creating");
    setTaskError(null);
    try {
      await issuesApi.create(companyId, {
        title: taskTitle.trim(),
        status: "todo",
        priority: taskPriority,
        ...(taskDescription.trim() ? { description: taskDescription.trim() } : {}),
        ...(taskAssigneeId ? { assigneeAgentId: taskAssigneeId } : {}),
        ...(taskProjectId ? { projectId: taskProjectId } : {}),
      });
      setTaskStatus("created");
      fireOnDoneOnce();
    } catch (e) {
      setTaskStatus("error");
      setTaskError(e instanceof Error ? e.message : "Failed to create this task.");
    }
  }

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={
            <>
              Give it a <GradientText>first job</GradientText>
            </>
          }
          subtitle={cloudMode
            ? "Create a task now, but it will not execute until the assignee has an E2B environment and is enabled."
            : "Give your agent its first task — or skip straight to Home."}
        />
      </Reveal>

      {agentsError && <p className="text-center text-xs text-destructive">{agentsError}</p>}

      <Reveal delay={0.09}>
        <StepCard>
          <h3 className="text-sm font-medium text-text">Create a task</h3>
          <div className="mt-3 space-y-2">
            <label className="sr-only" htmlFor="first-job-task-title">
              Task title
            </label>
            <input
              id="first-job-task-title"
              className={FIELD}
              placeholder="What needs doing?"
              value={taskTitle}
              disabled={taskStatus === "creating" || taskStatus === "created"}
              onChange={(e) => setTaskTitle(e.target.value)}
            />
            <label className="sr-only" htmlFor="first-job-task-description">
              Description
            </label>
            <textarea
              id="first-job-task-description"
              className={FIELD}
              rows={3}
              placeholder="Describe the task (optional)"
              value={taskDescription}
              disabled={taskStatus === "creating" || taskStatus === "created"}
              onChange={(e) => setTaskDescription(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={LABEL} htmlFor="first-job-task-assignee">
                  Assignee
                </label>
                <select
                  id="first-job-task-assignee"
                  className={FIELD}
                  value={taskAssigneeId}
                  disabled={taskStatus === "creating" || taskStatus === "created"}
                  onChange={(e) => setTaskAssigneeId(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name ?? agent.id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="first-job-task-priority">
                  Priority
                </label>
                <select
                  id="first-job-task-priority"
                  className={FIELD}
                  value={taskPriority}
                  disabled={taskStatus === "creating" || taskStatus === "created"}
                  onChange={(e) => setTaskPriority(e.target.value)}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {departments.length > 0 && (
              <div>
                <label className={LABEL} htmlFor="first-job-task-department">
                  Department
                </label>
                <select
                  id="first-job-task-department"
                  className={FIELD}
                  value={taskProjectId}
                  disabled={taskStatus === "creating" || taskStatus === "created"}
                  onChange={(e) => setTaskProjectId(e.target.value)}
                >
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.id}>
                      {dept.name ?? dept.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {taskStatus === "error" && <p className="text-xs text-destructive">{taskError}</p>}
            <Button
              type="button"
              className="w-full"
              disabled={!taskTitle.trim() || taskStatus === "creating" || taskStatus === "created"}
              onClick={() => void handleCreateTask()}
            >
              {taskStatus === "creating"
                ? "Creating…"
                : taskStatus === "created"
                  ? "Created"
                  : taskStatus === "error"
                    ? "Retry"
                    : "Create task"}
            </Button>
          </div>
        </StepCard>
      </Reveal>

      <Reveal delay={0.18}>
        <Button type="button" variant="ghost" className="w-full" onClick={fireOnDoneOnce}>
          Skip to Home
        </Button>
      </Reveal>
    </StepShell>
  );
}
