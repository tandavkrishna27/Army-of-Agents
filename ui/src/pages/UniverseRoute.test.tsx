import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { UniverseRoute } from "./UniverseRoute";
import { useAgentPanel } from "../context/AgentPanelContext";
const state = vi.hoisted(() => ({ companies: [{id: "a", issuePrefix: "ACME"}], selectedCompanyId: "a", loading: false, error: null as Error | null, setSelectedCompanyId: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({useCompany: () => state}));
vi.mock("../context/SidebarContext", () => ({useSidebar: () => ({isMobile: false})}));
vi.mock("./Universe", () => ({Universe: () => { useAgentPanel(); return <div>Universe content</div>; }}));
vi.mock("./AccessRequired", () => ({AccessRequired: () => <div>Access required</div>}));
afterEach(cleanup);
beforeEach(() => { state.companies = [{id:"a",issuePrefix:"ACME"}]; state.selectedCompanyId="a"; state.loading=false; state.error=null; state.setSelectedCompanyId.mockClear(); });
function mount(prefix="ACME") { return render(<MemoryRouter initialEntries={[`/${prefix}/universe?conversation=c1`]}><Routes><Route path="/:companyPrefix/universe" element={<UniverseRoute/>}/></Routes></MemoryRouter>); }
it("renders the accessible selected company", () => {mount(); expect(screen.getByText("Universe content")).toBeTruthy();});
it("syncs route company before rendering", () => {state.selectedCompanyId="b"; mount(); expect(screen.queryByText("Universe content")).toBeNull(); expect(state.setSelectedCompanyId).toHaveBeenCalledWith("a", {source:"route_sync"});});
it("accepts prefix casing", () => {mount("acme"); expect(screen.getByText("Universe content")).toBeTruthy();});
it("fails closed on unknown company", () => {mount("OTHER"); expect(screen.getByText("Access required")).toBeTruthy(); expect(screen.queryByText("Universe content")).toBeNull();});
it("fails closed after membership revocation", () => {state.companies=[]; mount(); expect(screen.getByText("Access required")).toBeTruthy();});
it("waits for companies", () => {state.loading=true; mount(); expect(screen.queryByText("Universe content")).toBeNull(); expect(state.setSelectedCompanyId).not.toHaveBeenCalled();});
it("fails closed on company fetch error", () => {state.error=new Error("offline"); mount(); expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByText("Universe content")).toBeNull();});
it("removes mounted content immediately when access is revoked", () => {
  const view = mount();
  expect(screen.getByText("Universe content")).toBeTruthy();
  state.companies = [];
  view.rerender(<MemoryRouter><Routes><Route path="/:companyPrefix/universe" element={<UniverseRoute/>}/></Routes></MemoryRouter>);
  expect(screen.queryByText("Universe content")).toBeNull();
  expect(screen.getByText("Access required")).toBeTruthy();
});
