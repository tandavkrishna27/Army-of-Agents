import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Commander } from "./Commander";
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({selectedCompanyId: "a", selectedCompany: {id: "a", issuePrefix: "ACME"}}) }));
vi.mock("../context/BreadcrumbContext", () => ({useBreadcrumbs: () => ({setBreadcrumbs: vi.fn()})}));
vi.mock("@tanstack/react-query", () => ({useQuery: () => ({data: undefined}), useQueryClient: () => ({invalidateQueries: vi.fn()})}));
vi.mock("../components/InternalAgentPanel", () => ({AgentPanelContent: ({conversationId}: {conversationId: string | null}) => <div data-testid="conversation">{conversationId ?? "new"}</div>}));
vi.mock("../components/commander", () => ({SessionsSidebar: () => null}));
vi.mock("../components/commander/useCommanderSessionsCollapsed", () => ({useCommanderSessionsCollapsed: () => [false, vi.fn()]}));
vi.mock("../lib/useBreakpoint", () => ({useBreakpoint: () => ({useDrawerSessions: false})}));
afterEach(cleanup);
it("restores the conversation passed back by Universe", () => {
  render(<MemoryRouter initialEntries={["/ACME/commander?conversation=c-123"]}><Commander /></MemoryRouter>);
  expect(screen.getByTestId("conversation").textContent).toBe("c-123");
  expect(screen.getByRole("link", {name: "Open Universe"}).getAttribute("href")).toBe("/ACME/universe?conversation=c-123");
});
it("opens a new session without a conversation parameter", () => {
  render(<MemoryRouter initialEntries={["/ACME/commander"]}><Commander /></MemoryRouter>);
  expect(screen.getByTestId("conversation").textContent).toBe("new");
  expect(screen.getByRole("link", {name: "Open Universe"}).getAttribute("href")).toBe("/ACME/universe");
});
