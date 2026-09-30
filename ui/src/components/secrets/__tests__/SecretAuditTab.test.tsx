import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SecretAccessEvent } from "@armyofagents/shared";
import { SecretAuditTab } from "../SecretAuditTab";

describe("SecretAuditTab", () => {
  it("opens readable audit detail for a failed access event", async () => {
    const events: SecretAccessEvent[] = [
      {
        id: "event-1",
        companyId: "company-1",
        secretId: "secret-1",
        version: 2,
        provider: "local_encrypted",
        actorType: "agent",
        actorId: "agent-1",
        consumerType: "agent",
        consumerId: "QA Agent",
        configPath: "env.OPENAI_API_KEY",
        issueId: "VQA-18",
        heartbeatRunId: "run-1",
        pluginId: null,
        outcome: "failure",
        errorCode: "missing_secret",
        createdAt: new Date("2026-05-14T12:00:00Z"),
      },
    ];

    render(<SecretAuditTab events={events} />);

    await userEvent.click(screen.getByText(/qa agent/i));

    expect(screen.getByRole("dialog", { name: /audit event/i })).toBeInTheDocument();
    expect(screen.getAllByText("failure").length).toBeGreaterThan(0);
    expect(screen.getAllByText("agent").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("QA Agent")).toBeInTheDocument();
    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("env.OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("VQA-18")).toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getAllByText(/14 May|May 14/).length).toBeGreaterThan(0);
    expect(screen.getByText("missing_secret")).toBeInTheDocument();
  });

  it("shows audit load errors instead of an empty state", () => {
    render(<SecretAuditTab events={[]} errorMessage="Audit load failed" />);

    expect(screen.getByText("Audit load failed")).toBeInTheDocument();
    expect(screen.queryByText("No access events")).not.toBeInTheDocument();
  });
});
