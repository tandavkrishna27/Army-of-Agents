import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ScopeTab } from "../ScopeTab";
import type { ScopeItem } from "../scopeGrouping";
import { ALL_SCOPE_TYPES } from "../scopeGrouping";
import type { ThreadScopeVersionDetail, ThreadScopeVersionSummary } from "../../../api/discussions";

vi.mock("../../../api/threads", () => ({
  threadsApi: {
    spinOff: vi.fn().mockResolvedValue({ id: "new-thread" }),
    routeItem: vi.fn().mockResolvedValue({ itemId: "item-1" }),
  },
}));

vi.mock("../../../api/discussions", () => ({
  discussionsApi: {
    approveItems: vi.fn().mockResolvedValue({}),
    rejectItems: vi.fn().mockResolvedValue({}),
    acceptScopeVersion: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

function makeItem(overrides: Partial<ScopeItem> = {}): ScopeItem {
  return {
    id: "item-1",
    type: "task",
    title: "Default item",
    description: null,
    status: "pending",
    conflictsWith: null,
    suggestedPriority: null,
    suggestedAssigneeId: null,
    suggestedDepartmentId: null,
    suggestedLayer: null,
    layer: null,
    dedupAction: null,
    resultTaskId: null,
    resultMemoryId: null,
    createdAt: "2026-01-01T00:00:00Z",
    dependsOn: [],
    ...overrides,
  };
}

function makeScopeVersion(
  overrides: Partial<ThreadScopeVersionDetail> = {},
): ThreadScopeVersionDetail {
  return {
    id: "scope-1",
    threadId: "thread-1",
    versionNumber: 1,
    status: "draft",
    sourceStartSeq: 1,
    sourceEndSeq: 3,
    summary: "Create the checkout handoff.",
    assumptions: [],
    decisions: [],
    openQuestions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items: [
      {
        id: "scope-item-task",
        kind: "task_proposal",
        status: "draft",
        title: "Implement checkout",
        description: "Build the guided checkout flow.",
        payload: {},
        sourceEntryIds: ["entry-1"],
        resultIssueId: null,
        resultMemoryId: null,
        artifactId: null,
        artifactVersionId: null,
      },
      {
        id: "scope-item-memory",
        kind: "memory_candidate",
        status: "draft",
        title: "Remember checkout preference",
        description: "Use low-friction payment copy.",
        payload: {},
        sourceEntryIds: ["entry-2"],
        resultIssueId: null,
        resultMemoryId: null,
        artifactId: null,
        artifactVersionId: null,
      },
      {
        id: "scope-item-noise",
        kind: "source_signal",
        status: "draft",
        title: "Noisy idea",
        description: "Do not turn this into work.",
        payload: {},
        sourceEntryIds: ["entry-3"],
        resultIssueId: null,
        resultMemoryId: null,
        artifactId: null,
        artifactVersionId: null,
      },
    ],
    ...overrides,
  };
}

function makeScopeVersionSummary(
  overrides: Partial<ThreadScopeVersionSummary> = {},
): ThreadScopeVersionSummary {
  return {
    id: "scope-summary-1",
    threadId: "thread-1",
    versionNumber: 1,
    status: "accepted",
    sourceStartSeq: 1,
    sourceEndSeq: 3,
    summary: "Accepted handoff.",
    assumptions: [],
    decisions: [],
    openQuestions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ScopeTab", () => {
  it("shows loading skeleton when isLoading", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={true}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-tab-skeleton")).toBeInTheDocument();
  });

  it("shows error state when isError", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={true}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-tab-error")).toBeInTheDocument();
  });

  it("renders the pre-scope state as summary action plus non-empty raw source signals", async () => {
    const user = userEvent.setup();
    const onCreateScopeDraft = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText="The team is discussing how the Scope tab should turn a messy conversation into executable work."
        summaryNext={null}
        items={[
          makeItem({
            id: "raw-signal-task",
            type: "task",
            title: "Task cards should open in the thread viewer",
            description: "Source from message 2. Not accepted yet.",
            status: "pending",
          }),
          makeItem({
            id: "raw-signal-memory",
            type: "preference",
            title: "Memory only matters if agents can retrieve it",
            description: "Potential memory candidate, but not written until accepted.",
            status: "pending",
          }),
        ]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeDraft={onCreateScopeDraft}
      />,
    );

    expect(screen.getByText("Conversation summary")).toBeInTheDocument();
    expect(screen.getByText(/turn a messy conversation into executable work/i)).toBeInTheDocument();
    expect(screen.getByText("No draft")).toBeInTheDocument();
    expect(screen.queryByText("Ready to scope")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ask agents to scope/i })).not.toBeInTheDocument();
    expect(screen.getByText("Raw source signals")).toBeInTheDocument();
    expect(screen.getByText("Waiting outside scope")).toBeInTheDocument();
    expect(screen.getByText("Task cards should open in the thread viewer")).toBeInTheDocument();
    expect(screen.getByText("Memory only matters if agents can retrieve it")).toBeInTheDocument();
    expect(screen.getAllByText("unscoped")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /create scope draft/i }));
    expect(onCreateScopeDraft).toHaveBeenCalledTimes(1);
  });

  it("hides empty raw signals in the no-scope state", () => {
    renderWithProviders(
      <ScopeTab
        summaryText="The team is still discussing what should become executable work."
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeDraft={vi.fn()}
      />,
    );

    expect(screen.getByText("Conversation summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create scope draft/i })).toBeInTheDocument();
    expect(screen.queryByText("Ready to scope")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-raw-source-signals")).not.toBeInTheDocument();
  });

  it("renders a versioned draft scope package with decisions and scope items", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={{
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 4,
          summary: "Ship the checkout onboarding cleanup.",
          assumptions: [],
          decisions: [{ text: "Engineer owns implementation." }],
          openQuestions: [{ text: "Do we need pricing copy?" }],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [
            {
              id: "scope-item-task",
              kind: "task_proposal",
              status: "draft",
              title: "Build onboarding cleanup",
              description: "Implement the first pass.",
              payload: {},
              sourceEntryIds: [],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-memory",
              kind: "memory_candidate",
              status: "draft",
              title: "Trial users need guided onboarding",
              description: "Remember this for future growth work.",
              payload: {},
              sourceEntryIds: [],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Scope v1");
    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Draft");
    expect(screen.getByText("Ship the checkout onboarding cleanup.")).toBeInTheDocument();
    expect(screen.getByText("Engineer owns implementation.")).toBeInTheDocument();
    expect(screen.getByText("Do we need pricing copy?")).toBeInTheDocument();
    expect(screen.getByText("Build onboarding cleanup")).toBeInTheDocument();
    expect(screen.getByText("Trial users need guided onboarding")).toBeInTheDocument();
  });

  it("shows saved memory status and placement on memory cards", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={makeScopeVersion({
          status: "accepted",
          items: [
            {
              id: "memory-1",
              kind: "memory_candidate",
              title: "Handoff rule",
              description: "Accepted scope is the source of truth.",
              status: "applied",
              payload: {
                category: "decision",
                layer: "domain",
                folderPath: "Software/Overview",
              },
              sourceEntryIds: ["entry-1"],
              resultIssueId: null,
              resultMemoryId: "mem-1",
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        })}
      />,
    );

    const card = screen.getByTestId("scope-version-card-memory-1");
    expect(card).toHaveTextContent("Saved memory");
    expect(card).toHaveTextContent("Decision");
    expect(card).toHaveTextContent("Domain");
    expect(card).toHaveTextContent("Software/Overview");
  });

  it("groups versioned scope items into clickable cards and keeps raw signals secondary", async () => {
    const user = userEvent.setup();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText="AI summary should appear as scope context."
        summaryNext={null}
        items={[
          makeItem({
            id: "signal-1",
            type: "reference",
            title: "Raw link from conversation",
            status: "pending",
          }),
        ]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={{
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 4,
          summary: "Scope summary is the handoff context.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [
            {
              id: "scope-item-task",
              kind: "task_proposal",
              status: "draft",
              title: "Build onboarding cleanup",
              description: "Implement the first pass.",
              payload: { priority: "high" },
              sourceEntryIds: ["entry-1", "entry-2"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-memory",
              kind: "memory_candidate",
              status: "draft",
              title: "Trial users need guided onboarding",
              description: "Remember this for future growth work.",
              payload: { layer: "domain" },
              sourceEntryIds: ["entry-3"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Task proposals")).toBeInTheDocument();
    expect(screen.getByText("Memory candidates")).toBeInTheDocument();
    expect(screen.getByTestId("scope-version-card-scope-item-task")).toHaveTextContent("2 sources");
    expect(screen.getByText("Source signals")).toBeInTheDocument();
    expect(screen.queryByText("No older extracted signals waiting outside this scope.")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("scope-version-card-scope-item-task"));
    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-task", kind: "task_proposal" }),
    );
  });

  it("renders versioned scope groups as accordions with source notes collapsed by default", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    const taskGroup = screen.getByTestId("scope-version-accordion-task-proposals");
    const memoryGroup = screen.getByTestId("scope-version-accordion-memory-candidates");
    const sourceGroup = screen.getByTestId("scope-version-accordion-source-notes");

    expect(taskGroup).toHaveAttribute("aria-expanded", "true");
    expect(memoryGroup).toHaveAttribute("aria-expanded", "true");
    expect(sourceGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("scope-version-card-scope-item-task")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-version-card-scope-item-noise")).not.toBeInTheDocument();

    await user.click(sourceGroup);
    expect(sourceGroup).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("scope-version-card-scope-item-noise")).toBeInTheDocument();

    await user.click(taskGroup);
    expect(taskGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("scope-version-card-scope-item-task")).not.toBeInTheDocument();
  });

  it("renders draft scope like the mockup review board", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={vi.fn()}
        onUpdateScopeItem={vi.fn()}
        onScopeVersionItemClick={vi.fn()}
        activeScopeVersion={makeScopeVersion({
          items: [
            {
              id: "scope-item-accepted-task",
              kind: "task_proposal",
              status: "accepted",
              title: "Converge scope proposal and version paths",
              description: "Make accepted scope versions create and display the real task outputs.",
              payload: { departmentName: "Engineering", priority: "medium" },
              sourceEntryIds: ["entry-1", "entry-2", "entry-3"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-draft-task",
              kind: "task_proposal",
              status: "draft",
              title: "Add scope E2E with agent discussion cycle",
              description: "Verify create thread, discuss, scope, accept, open created task.",
              payload: { departmentName: "QA", priority: "high" },
              sourceEntryIds: ["entry-2", "entry-3"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-accepted-memory",
              kind: "memory_candidate",
              status: "accepted",
              title: "Accepted scope versions are the handoff source of truth",
              description: "Agents should receive accepted scope context when executing downstream work.",
              payload: { layer: "domain" },
              sourceEntryIds: ["entry-2"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-rejected-artifact",
              kind: "artifact_link",
              status: "rejected",
              title: "Thread header options mock",
              description: "Existing HTML mockup referenced as input for implementation.",
              payload: { role: "artifact" },
              sourceEntryIds: ["entry-3"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: "artifact-1",
              artifactVersionId: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("scope-workspace").className).toContain("max-w-[560px]");
    expect(screen.getByTestId("scope-version-card-lane").className).toContain("grid");
    expect(screen.getByText("Scope v1 draft")).toBeInTheDocument();
    expect(screen.getByText("Messages 1-3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply accepted/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject draft/i })).toBeInTheDocument();

    expect(screen.getByTestId("scope-version-group-task-proposals")).toHaveTextContent("1 accepted · 1 undecided");
    expect(screen.getByTestId("scope-version-group-memory-candidates")).toHaveTextContent("1 accepted");
    expect(screen.getByText("Artifacts and references")).toBeInTheDocument();
    expect(screen.getByTestId("scope-version-group-artifacts-and-references")).toHaveTextContent("1 rejected");

    const acceptedTask = within(screen.getByTestId("scope-version-card-scope-item-accepted-task"));
    expect(acceptedTask.getAllByText("Accepted").length).toBeGreaterThanOrEqual(1);
    expect(acceptedTask.getByRole("button", { name: /edit in viewer/i })).toBeInTheDocument();
    expect(acceptedTask.getByRole("button", { name: /remove from draft/i })).toBeInTheDocument();
    expect(acceptedTask.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();

    const draftTask = within(screen.getByTestId("scope-version-card-scope-item-draft-task"));
    expect(draftTask.getByRole("button", { name: /^review task$/i })).toBeInTheDocument();
    expect(draftTask.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(draftTask.getByRole("button", { name: /edit in viewer/i })).toBeInTheDocument();
    expect(draftTask.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();

    const rejectedArtifact = within(screen.getByTestId("scope-version-card-scope-item-rejected-artifact"));
    expect(rejectedArtifact.getAllByText("Rejected").length).toBeGreaterThanOrEqual(1);
    expect(rejectedArtifact.getByRole("button", { name: /^link artifact$/i })).toBeInTheDocument();
  });

  it("renders a version rail for prior accepted scope and the active draft", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        scopeVersions={[
          makeScopeVersionSummary({
            id: "scope-v1",
            versionNumber: 1,
            status: "accepted",
            sourceStartSeq: 1,
            sourceEndSeq: 8,
            summary: "First accepted handoff.",
          }),
          makeScopeVersionSummary({
            id: "scope-v2",
            versionNumber: 2,
            status: "draft",
            sourceStartSeq: 9,
            sourceEndSeq: 12,
            summary: "Follow-up draft.",
          }),
        ]}
        activeScopeVersion={makeScopeVersion({
          id: "scope-v2",
          versionNumber: 2,
          status: "draft",
          sourceStartSeq: 9,
          sourceEndSeq: 12,
          summary: "Follow-up draft.",
        })}
      />,
    );

    const rail = screen.getByTestId("scope-version-rail");
    expect(rail).toHaveTextContent("v1");
    expect(rail).toHaveTextContent("Accepted");
    expect(rail).toHaveTextContent("Messages 1-8");
    expect(rail).toHaveTextContent("v2");
    expect(rail).toHaveTextContent("Draft");
    expect(rail).toHaveTextContent("Messages 9-12");
  });

  it("selects a scope version from the version rail", async () => {
    const user = userEvent.setup();
    const onScopeVersionSelect = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onScopeVersionSelect={onScopeVersionSelect}
        scopeVersions={[
          makeScopeVersionSummary({
            id: "scope-v1",
            versionNumber: 1,
            status: "accepted",
            sourceStartSeq: 1,
            sourceEndSeq: 8,
            summary: "First accepted handoff.",
          }),
          makeScopeVersionSummary({
            id: "scope-v2",
            versionNumber: 2,
            status: "draft",
            sourceStartSeq: 9,
            sourceEndSeq: 12,
            summary: "Follow-up draft.",
          }),
        ]}
        activeScopeVersion={makeScopeVersion({
          id: "scope-v2",
          versionNumber: 2,
          status: "draft",
          sourceStartSeq: 9,
          sourceEndSeq: 12,
          summary: "Follow-up draft.",
        })}
      />,
    );

    const previousVersion = screen.getByTestId("scope-version-tab-scope-v1");
    expect(previousVersion).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("scope-version-tab-scope-v2")).toHaveAttribute("aria-pressed", "true");

    await user.click(previousVersion);

    expect(onScopeVersionSelect).toHaveBeenCalledWith("scope-v1");
  });

  it("opens a versioned scope card with keyboard activation", async () => {
    const user = userEvent.setup();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    const card = screen.getByTestId("scope-version-card-scope-item-task");
    card.focus();
    await user.keyboard("{Enter}");

    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-task", kind: "task_proposal" }),
    );
  });

  it("applies accepted scope items from the versioned package", async () => {
    const user = userEvent.setup();
    const onAcceptScopeVersion = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onAcceptScopeVersion={onAcceptScopeVersion}
        activeScopeVersion={{
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Create the first handoff.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [
            {
              id: "scope-item-task",
              kind: "task_proposal",
              status: "accepted",
              title: "Build first task",
              description: null,
              payload: {},
              sourceEntryIds: [],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /apply accepted/i }));

    expect(onAcceptScopeVersion).toHaveBeenCalledWith("scope-1", ["scope-item-task"]);
  });

  it("opens task proposal primary action in the viewer instead of creating immediately", async () => {
    const user = userEvent.setup();
    const onCreateScopeOutputItem = vi.fn();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-task")).getByRole("button", {
        name: /^review task$/i,
      }),
    );

    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-task", kind: "task_proposal" }),
    );
    expect(onCreateScopeOutputItem).not.toHaveBeenCalled();
  });

  it("opens memory candidate primary action in the viewer instead of saving immediately", async () => {
    const user = userEvent.setup();
    const onCreateScopeOutputItem = vi.fn();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-memory")).getByRole("button", {
        name: /^review memory$/i,
      }),
    );

    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-memory", kind: "memory_candidate" }),
    );
    expect(onCreateScopeOutputItem).not.toHaveBeenCalled();
  });

  it("links artifact cards directly only when the artifact target exists", async () => {
    const user = userEvent.setup();
    const onCreateScopeOutputItem = vi.fn();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeOutputItem={onCreateScopeOutputItem}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion({
          items: [
            {
              id: "scope-item-artifact-linked",
              kind: "artifact_link",
              status: "draft",
              title: "Existing artifact",
              description: "Artifact can be linked directly.",
              payload: {},
              sourceEntryIds: ["entry-1"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: "artifact-1",
              artifactVersionId: null,
            },
            {
              id: "scope-item-artifact-review",
              kind: "artifact_link",
              status: "draft",
              title: "Missing artifact",
              description: "Needs review before linking.",
              payload: {},
              sourceEntryIds: ["entry-2"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        })}
      />,
    );

    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-artifact-linked")).getByRole("button", {
        name: /^link artifact$/i,
      }),
    );
    expect(onCreateScopeOutputItem).toHaveBeenCalledWith("scope-1", "scope-item-artifact-linked");

    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-artifact-review")).getByRole("button", {
        name: /^review artifact$/i,
      }),
    );
    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-artifact-review", kind: "artifact_link" }),
    );
  });

  it("rejects a draft scope card without opening the viewer", async () => {
    const user = userEvent.setup();
    const onReviewScopeItems = vi.fn();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(screen.getByTestId("scope-version-accordion-source-notes"));
    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-noise")).getByRole("button", {
        name: /^reject$/i,
      }),
    );

    expect(onReviewScopeItems).toHaveBeenCalledWith("scope-1", [
      { itemId: "scope-item-noise", status: "rejected" },
    ]);
    expect(onScopeVersionItemClick).not.toHaveBeenCalled();
  });

  it("restores a rejected draft scope card without showing a second reject action", async () => {
    const user = userEvent.setup();
    const onReviewScopeItems = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        activeScopeVersion={makeScopeVersion({
          items: makeScopeVersion().items.map((item) =>
            item.id === "scope-item-task" ? { ...item, status: "rejected" } : item,
          ),
        })}
      />,
    );

    const card = screen.getByTestId("scope-version-card-scope-item-task");
    expect(within(card).getByRole("button", { name: /^restore$/i })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: /^restore$/i }));
    expect(onReviewScopeItems).toHaveBeenCalledWith("scope-1", [
      { itemId: "scope-item-task", status: "draft" },
    ]);
  });

  it("opens an applied task card instead of showing draft mutation actions", async () => {
    const user = userEvent.setup();
    const onScopeVersionItemClick = vi.fn();
    const onReviewScopeItems = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion({
          items: [
            {
              ...makeScopeVersion().items[0],
              status: "applied",
              resultIssueId: "TC-42",
            },
          ],
        })}
      />,
    );

    const card = screen.getByTestId("scope-version-card-scope-item-task");
    expect(within(card).getByRole("button", { name: /^open task$/i })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: /create task/i })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: /^open task$/i }));
    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-task", resultIssueId: "TC-42" }),
    );
    expect(onReviewScopeItems).not.toHaveBeenCalled();
  });

  it("labels a draft scope with created outputs and remaining draft items as partially applied", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={makeScopeVersion({
          items: [
            {
              ...makeScopeVersion().items[0],
              status: "applied",
              resultIssueId: "TC-42",
            },
            {
              ...makeScopeVersion().items[1],
              status: "draft",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/Partially applied/i)).toBeInTheDocument();
    expect(screen.getByText(/1 created output/i)).toBeInTheDocument();
    expect(screen.getByText(/1 draft item/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open task/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review memory/i })).toBeInTheDocument();
  });

  it("falls back to review actions for non-output cards without opening the viewer", async () => {
    const user = userEvent.setup();
    const onReviewScopeItems = vi.fn();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(screen.getByTestId("scope-version-accordion-source-notes"));
    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-noise")).getByRole("button", {
        name: /^accept$/i,
      }),
    );

    expect(onReviewScopeItems).toHaveBeenCalledWith("scope-1", [
      { itemId: "scope-item-noise", status: "accepted" },
    ]);
    expect(onScopeVersionItemClick).not.toHaveBeenCalled();
  });

  it("shows accepted and rejected state tone on scope cards", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={makeScopeVersion({
          items: makeScopeVersion().items.map((item) =>
            item.id === "scope-item-task"
              ? { ...item, status: "accepted" }
              : item.id === "scope-item-noise"
                ? { ...item, status: "rejected" }
                : item,
          ),
        })}
      />,
    );

    expect(screen.getByTestId("scope-version-card-scope-item-task")).toHaveAttribute("data-review-status", "accepted");
    await user.click(screen.getByTestId("scope-version-accordion-source-notes"));
    expect(screen.getByTestId("scope-version-card-scope-item-noise")).toHaveAttribute("data-review-status", "rejected");
  });

  it("bulk accepts all draft cards", async () => {
    const user = userEvent.setup();
    const onReviewScopeItems = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /accept all/i }));

    expect(onReviewScopeItems).toHaveBeenCalledWith("scope-1", [
      { itemId: "scope-item-task", status: "accepted" },
      { itemId: "scope-item-memory", status: "accepted" },
      { itemId: "scope-item-noise", status: "accepted" },
    ]);
  });

  it("bulk rejects source signal cards only", async () => {
    const user = userEvent.setup();
    const onReviewScopeItems = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onReviewScopeItems={onReviewScopeItems}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /reject signals/i }));

    expect(onReviewScopeItems).toHaveBeenCalledWith("scope-1", [
      { itemId: "scope-item-noise", status: "rejected" },
    ]);
  });

  it("disables apply accepted cards until at least one scope card is accepted", async () => {
    const user = userEvent.setup();
    const onApplyScopeVersion = vi.fn();

    const { rerender } = renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onApplyScopeVersion={onApplyScopeVersion}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    const disabledApply = screen.getByRole("button", { name: /apply accepted/i });
    expect(disabledApply).toBeDisabled();

    rerender(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onApplyScopeVersion={onApplyScopeVersion}
        activeScopeVersion={makeScopeVersion({
          items: makeScopeVersion().items.map((item) =>
            item.id === "scope-item-task" ? { ...item, status: "accepted" } : item,
          ),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /apply accepted/i }));

    expect(onApplyScopeVersion).toHaveBeenCalledWith("scope-1");
  });

  it("opens card edit in the viewer instead of rendering an inline editor", async () => {
    const user = userEvent.setup();
    const onScopeVersionItemClick = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onScopeVersionItemClick={onScopeVersionItemClick}
        activeScopeVersion={makeScopeVersion()}
      />,
    );

    await user.click(
      within(screen.getByTestId("scope-version-card-scope-item-task")).getByRole("button", {
        name: /edit in viewer/i,
      }),
    );
    expect(onScopeVersionItemClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scope-item-task", kind: "task_proposal" }),
    );
    expect(screen.queryByLabelText(/title for implement checkout/i)).not.toBeInTheDocument();
  });

  it("renders an accepted scope package as the source of truth", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={{
          id: "scope-2",
          threadId: "thread-1",
          versionNumber: 2,
          status: "accepted",
          sourceStartSeq: 5,
          sourceEndSeq: 8,
          summary: "Second delivery pass.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [
            {
              id: "scope-item-applied",
              kind: "task_proposal",
              status: "applied",
              title: "Follow-up pricing education task",
              description: null,
              payload: {},
              sourceEntryIds: [],
              resultIssueId: "task-1",
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Accepted");
    expect(screen.getByText("Second delivery pass.")).toBeInTheDocument();
    expect(screen.getByText("Follow-up pricing education task")).toBeInTheDocument();
    expect(screen.getByText("Task linked")).toBeInTheDocument();
    expect(screen.getByText(/task-1/i)).toBeInTheDocument();
  });

  it("renders accepted scope as created outputs with version history", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        showCreateScopeDraftCta
        activeScopeVersion={{
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "accepted",
          sourceStartSeq: 1,
          sourceEndSeq: 3,
          summary: "Accepted scope is frozen as a versioned handoff.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [
            {
              id: "scope-item-output-task",
              kind: "task_proposal",
              status: "applied",
              title: "Converge scope proposal and version paths",
              description: "Click opens task content in the right viewer, not a disconnected blob.",
              payload: {},
              sourceEntryIds: ["entry-1", "entry-2", "entry-3"],
              resultIssueId: "QAT-124",
              resultMemoryId: null,
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-output-memory",
              kind: "memory_candidate",
              status: "applied",
              title: "Accepted scope versions are source of truth",
              description: "Created as pending memory with source context thread_scope_version:v1.",
              payload: {},
              sourceEntryIds: ["entry-2"],
              resultIssueId: null,
              resultMemoryId: "memory-1",
              artifactId: null,
              artifactVersionId: null,
            },
            {
              id: "scope-item-output-artifact",
              kind: "artifact_link",
              status: "applied",
              title: "Thread header options mock",
              description: "Available as a reference in scope and task context.",
              payload: { content: "# Decisions\nUse accepted scope as the handoff source of truth." },
              sourceEntryIds: ["entry-3"],
              resultIssueId: null,
              resultMemoryId: null,
              artifactId: "artifact-1",
              artifactVersionId: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Scope v1 accepted")).toBeInTheDocument();
    expect(screen.getByText(/accepted scope is frozen as a versioned handoff/i)).toBeInTheDocument();
    expect(screen.getByTestId("scope-version-history")).toHaveTextContent("v1");
    expect(screen.getByTestId("scope-version-history")).toHaveTextContent("Assigned");
    expect(screen.getByTestId("scope-version-history")).toHaveTextContent("v2");
    expect(screen.getByTestId("scope-version-history")).toHaveTextContent("New messages");
    expect(screen.getByText("Created tasks")).toBeInTheDocument();
    expect(screen.getByText("Memory and artifacts")).toBeInTheDocument();

    expect(screen.getByTestId("scope-version-card-scope-item-output-task")).toHaveTextContent("Task");
    expect(screen.getByTestId("scope-version-card-scope-item-output-task")).toHaveTextContent("Task QAT-124");
    expect(screen.getByTestId("scope-version-card-scope-item-output-task")).toHaveTextContent("scope item linked");
    expect(screen.getByTestId("scope-version-card-scope-item-output-memory")).toHaveTextContent("Memory");
    expect(screen.getByTestId("scope-version-card-scope-item-output-artifact")).toHaveTextContent("Artifact");
    expect(screen.getByTestId("scope-version-card-scope-item-output-artifact")).toHaveTextContent(
      "Use accepted scope as the handoff source of truth.",
    );
    expect(
      within(screen.getByTestId("scope-version-card-scope-item-output-artifact")).getByRole("button", {
        name: /^open artifact$/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows empty state when no pending items", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/nothing to decide yet/i)).toBeInTheDocument();
  });

  it("offers to create a versioned scope draft when no package exists", async () => {
    const user = userEvent.setup();
    const onCreateScopeDraft = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeDraft={onCreateScopeDraft}
      />,
    );

    await user.click(screen.getByRole("button", { name: /create scope draft/i }));

    expect(onCreateScopeDraft).toHaveBeenCalledTimes(1);
  });

  it("uses the re-scope label when new conversation exists after a prior scope", async () => {
    const user = userEvent.setup();
    const onCreateScopeDraft = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        onCreateScopeDraft={onCreateScopeDraft}
        createScopeDraftLabel="Re-scope"
      />,
    );

    await user.click(screen.getByRole("button", { name: /re-scope/i }));

    expect(onCreateScopeDraft).toHaveBeenCalledTimes(1);
  });

  it("offers re-scope next to an accepted package when new conversation exists", async () => {
    const user = userEvent.setup();
    const onCreateScopeDraft = vi.fn();

    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        activeScopeVersion={{
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "accepted",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Accepted first handoff.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          items: [],
        }}
        onCreateScopeDraft={onCreateScopeDraft}
        createScopeDraftLabel="Re-scope"
        showCreateScopeDraftCta
      />,
    );

    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Scope v1");
    await user.click(screen.getByRole("button", { name: /^re-scope$/i }));

    expect(onCreateScopeDraft).toHaveBeenCalledTimes(1);
  });

  it("does not render legacy plan steps as a top-level scope section", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={["Step one", "Step two", "Step three"]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("scope-plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Step one")).not.toBeInTheDocument();
    expect(screen.queryByText("Step two")).not.toBeInTheDocument();
    expect(screen.queryByText("Step three")).not.toBeInTheDocument();
  });

  it("does not render backend plan steps as separate scope content", () => {
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={[]}
        planSteps={["Spec the API", "Build it", "Test it"]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("scope-plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Spec the API")).not.toBeInTheDocument();
    expect(screen.queryByText("Test it")).not.toBeInTheDocument();
  });

  it("shows Needs Decision section with pending items (collapsed by default)", () => {
    const items: ScopeItem[] = [
      makeItem({ id: "p1", status: "pending", title: "Pending task A" }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scope-needs-decision")).toBeInTheDocument();
    // Type accordion button exists but is collapsed
    const accordion = screen.getByRole("button", { name: /tasks/i });
    expect(accordion).toHaveAttribute("aria-expanded", "false");
  });

  it("expands type accordion to reveal pending items", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "p1", status: "pending", title: "Pending task A" }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /tasks/i }));
    expect(screen.getByText("Pending task A")).toBeInTheDocument();
  });

  it("shows Approved section when items are approved", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "a1", status: "approved", title: "Approved task B" }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    // Approved section header should be visible
    expect(screen.getByTestId("scope-approved")).toBeInTheDocument();
    // Expand it
    await user.click(screen.getByRole("button", { name: /approved/i }));
    expect(screen.getByText("Approved task B")).toBeInTheDocument();
  });

  it("shows approved references under type label in Approved section", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "ref1", status: "approved", type: "reference", title: "Ref doc" }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /approved/i }));
    expect(screen.getByText("Ref doc")).toBeInTheDocument();
    expect(screen.getByText("References")).toBeInTheDocument();
  });

  it("shows approved artifacts under type label in Approved section", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "art1", status: "approved", type: "artifact", title: "My artifact" }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /approved/i }));
    expect(screen.getByText("My artifact")).toBeInTheDocument();
    expect(screen.getByText("Artifacts")).toBeInTheDocument();
  });

  it("conflict card has amber styling for conflicted items", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({
        id: "c1",
        status: "pending",
        title: "Conflicted item",
        conflictsWith: "other-item",
      }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        companyId="comp-1"
        discussionId="disc-1"
      />,
    );
    // Expand the Tasks accordion first so item card renders
    await user.click(screen.getByRole("button", { name: /tasks/i }));
    const itemEl = screen.getByTestId("scope-item-c1");
    // Amber conflict border is applied
    expect(itemEl.className).toMatch(/amber/);
  });

  it("shows conflict badge text on conflicted items", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({
        id: "c1",
        status: "pending",
        title: "Conflicted item",
        conflictsWith: "other-item",
      }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /tasks/i }));
    expect(screen.getAllByText(/conflict/i).length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'Spin off' button only for spin_off_thread type items", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "s1", status: "pending", type: "spin_off_thread", title: "Branch Task", dependsOn: [] }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        companyId="comp-1"
        discussionId="disc-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: /branches/i }));
    expect(screen.getByTestId("spin-off-s1")).toBeInTheDocument();
  });

  it("shows dependency badge when item has dependsOn", async () => {
    const user = userEvent.setup();
    const items: ScopeItem[] = [
      makeItem({ id: "d1", status: "pending", title: "Blocked Task", dependsOn: ["item-a", "item-b"] }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        companyId="comp-1"
        discussionId="disc-1"
      />,
    );
    await user.click(screen.getByRole("button", { name: /tasks/i }));
    expect(screen.getByTestId("dep-badge-d1")).toBeInTheDocument();
  });

  it("does not render routing UI (removed in v1.1 redesign)", () => {
    const items: ScopeItem[] = [
      makeItem({ id: "r1", status: "pending", title: "Task", type: "task", dependsOn: [] }),
    ];
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        companyId="comp-1"
        discussionId="disc-1"
        isFounder={true}
        departments={[{ id: "dept-1", name: "Engineering" }]}
      />,
    );
    expect(screen.queryByTestId("routing-dept-r1")).not.toBeInTheDocument();
  });

  it("renders items of all scope types in Approved section", async () => {
    const user = userEvent.setup();
    const items = ALL_SCOPE_TYPES.map((t, i) =>
      makeItem({ id: `t${i}`, type: t, status: "approved", title: `${t} item` }),
    );
    renderWithProviders(
      <ScopeTab
        summaryText={null}
        summaryNext={null}
        items={items}
        planSteps={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onItemClick={vi.fn()}
        showAllTypes
      />,
    );
    await user.click(screen.getByRole("button", { name: /approved/i }));
    for (const t of ALL_SCOPE_TYPES) {
      expect(screen.getByText(`${t} item`)).toBeInTheDocument();
    }
  });
});
