import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { OnboardingFlowPage } from "../OnboardingFlow";

const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  selectedCompanyId: null as string | null,
  session: { user: { id: "u1" } } as unknown,
  flowProps: null as unknown as { companyId: string | null; onFinished?: () => void },
  newCompanyProps: null as unknown as {
    userId: string;
    journey: string;
    onCompleteCompany: () => void;
    onBack: () => void;
  },
  firstRunProps: null as unknown as { companyId: string; onComplete: () => void },
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockRemoveQueries = vi.hoisted(() => vi.fn());
const mockGetOnboardingProgress = vi.hoisted(() => vi.fn());
const mockAdvanceOnboarding = vi.hoisted(() => vi.fn());
const mockGetHealth = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ removeQueries: mockRemoveQueries }),
  };
});

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [state.searchParams],
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: state.selectedCompanyId }),
}));
vi.mock("../../api/auth", () => ({
  authApi: { getSession: () => Promise.resolve(state.session) },
}));
vi.mock("../../api/onboarding", () => ({
  onboardingApi: { getProgress: vi.fn(), advance: vi.fn() },
  getOnboardingProgress: mockGetOnboardingProgress,
  advanceOnboarding: mockAdvanceOnboarding,
}));
vi.mock("../../api/health", () => ({
  healthApi: { get: mockGetHealth },
}));
vi.mock("../../onboarding/FlowEngine", () => ({
  FlowEngine: (props: { companyId: string | null; onFinished?: () => void }) => {
    state.flowProps = props;
    return (
      <button type="button" onClick={() => props.onFinished?.()}>
        finish-flow
      </button>
    );
  },
  // DRY dark-shell fix: OnboardingFlow.tsx now reuses FlowEngine's exported
  // DarkShell instead of hand-duplicating the `.onboarding-dark` +
  // ConstellationBg wrapper — a passthrough stand-in is enough for this suite.
  DarkShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../onboarding/CreateAnotherCompany", () => ({
  CreateAnotherCompany: (props: {
    userId: string;
    journey: string;
    onCompleteCompany: () => void;
    onBack: () => void;
  }) => {
    state.newCompanyProps = props;
    return <div>create-another-company</div>;
  },
}));
vi.mock("../../onboarding/InvitedJoinTerminal", () => ({
  InvitedJoinTerminal: () => <div>invited-join-terminal</div>,
}));
// The founder's post-spine tail (persona fork + in-flight) now renders INLINE in
// OnboardingFlow via FirstRunHome. Stub it to a button that fires onComplete so
// this suite can assert the orchestration (spine → tail → Lobby) without pulling
// in the whole in-flight sequencer + its API calls.
vi.mock("../../onboarding/FirstRunHome", () => ({
  FirstRunHome: (props: { companyId: string; onComplete: () => void }) => {
    state.firstRunProps = props;
    return (
      <button type="button" onClick={() => props.onComplete()}>
        finish-tail
      </button>
    );
  },
}));

describe("OnboardingFlowPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.searchParams = new URLSearchParams();
    state.selectedCompanyId = null;
    state.session = { user: { id: "u1" } };
    state.flowProps = null as never;
    state.newCompanyProps = null as never;
    mockGetOnboardingProgress.mockResolvedValue({
      completedStates: ["AUTHENTICATED", "PROFILE_SET"],
    });
    mockAdvanceOnboarding.mockResolvedValue({
      completedStates: ["AUTHENTICATED", "PROFILE_SET"],
    });
    mockGetHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
    });
  });

  it("founder: runs the FlowEngine on the selected company's org layer", async () => {
    state.selectedCompanyId = "existing-co";
    renderWithProviders(<OnboardingFlowPage journey="founder" />);
    await screen.findByText("finish-flow");
    expect(state.flowProps.companyId).toBe("existing-co");
    expect(state.newCompanyProps).toBeNull();
  });

  it("founder: after the spine, runs the inline tail, then evicts the journey cache and hands off to the Lobby", async () => {
    state.selectedCompanyId = "completed-co";
    renderWithProviders(<OnboardingFlowPage journey="founder" />);

    // Finishing the spine hands off to the INLINE tail (not the dashboard),
    // scoped to the selected company.
    fireEvent.click(await screen.findByText("finish-flow"));
    const finishTail = await screen.findByText("finish-tail");
    expect(state.firstRunProps.companyId).toBe("completed-co");
    // No premature navigation — the spine finishing must NOT go anywhere yet.
    expect(mockNavigate).not.toHaveBeenCalled();

    // Completing the tail evicts the cached journey BEFORE navigating to the Lobby.
    fireEvent.click(finishTail);
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ["onboarding", "journey"],
      exact: true,
    });
    expect(mockRemoveQueries.mock.invocationCallOrder[0]).toBeLessThan(
      mockNavigate.mock.invocationCallOrder[0]!,
    );
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("founder + ?new=1: renders the create-another-company resolver on the user layer, then resumes clean", async () => {
    state.selectedCompanyId = "existing-co"; // already-complete company must be ignored
    state.searchParams = new URLSearchParams("new=1");
    renderWithProviders(<OnboardingFlowPage journey="founder" />);
    await screen.findByText("create-another-company");
    expect(state.newCompanyProps.userId).toBe("u1");
    expect(state.newCompanyProps.journey).toBe("founder");
    // finishing the company step resumes the NEW company via a clean /onboarding
    state.newCompanyProps.onCompleteCompany();
    expect(mockNavigate).toHaveBeenCalledWith("/onboarding", { replace: true });
  });

  it("founder + ?new=1: persists PROFILE_SET before rendering the resolver for a legacy user", async () => {
    state.searchParams = new URLSearchParams("new=1");
    mockGetOnboardingProgress.mockResolvedValue(null);

    renderWithProviders(<OnboardingFlowPage journey="founder" />);

    await screen.findByText("create-another-company");
    expect(mockGetOnboardingProgress).toHaveBeenCalledWith(null);
    expect(mockAdvanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "founder",
      requestedState: "PROFILE_SET",
    });
  });

  it("invited: renders the join terminal on finish instead of looping to /", async () => {
    renderWithProviders(<OnboardingFlowPage journey="invited" />);
    const finish = await screen.findByText("finish-flow");
    expect(state.flowProps.companyId).toBeNull(); // user layer
    fireEvent.click(finish);
    expect(await screen.findByText("invited-join-terminal")).toBeTruthy();
    // must NOT navigate to "/" — that is exactly what re-triggers the invited loop
    expect(mockNavigate).not.toHaveBeenCalledWith("/", { replace: true });
  });
});
