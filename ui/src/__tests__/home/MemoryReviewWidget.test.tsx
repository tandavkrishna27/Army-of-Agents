import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { MemoryReviewWidget } from "../../components/home/widgets/MemoryReviewWidget";

const { memoryApiMock } = vi.hoisted(() => ({ memoryApiMock: { listPending: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/memory", () => ({ memoryApi: memoryApiMock }));

describe("MemoryReviewWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryApiMock.listPending.mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 });
  });

  it("renders the 'Memory review' title and queries pending memory", async () => {
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("Memory review")).toBeInTheDocument();
    expect(memoryApiMock.listPending).toHaveBeenCalledWith("co-1");
  });

  it("shows the shell + loading placeholder while the query is in flight", () => {
    memoryApiMock.listPending.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText("Memory review")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the query errors — e.g. a member's 403", async () => {
    memoryApiMock.listPending.mockRejectedValue(new Error("403 Forbidden"));
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="team_member" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText(/Couldn't load/)).toBeInTheDocument();
  });

  it("shows 'No memory to review' with no CTA when there are no pending items", async () => {
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("No memory to review")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders data.items with a title + layer chip, linking to /memory/explore?item=:id&type=memory_item", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: [
        { id: "m1", title: "Prefer async standups", content: "...", layer: "domain", status: "pending" },
      ],
      versions: [],
      archives: [],
      totalCount: 1,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    const link = await screen.findByRole("link", { name: /Prefer async standups/i });
    expect(link).toHaveAttribute("href", "/memory/explore?item=m1&type=memory_item");
    expect(screen.getByText("Domain")).toBeInTheDocument();
  });

  it("omits the layer chip when layer is null", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: [{ id: "m1", title: "No layer yet", content: "...", layer: null, status: "pending" }],
      versions: [],
      archives: [],
      totalCount: 1,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    await screen.findByText("No layer yet");
    expect(screen.queryByText("Identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Domain")).not.toBeInTheDocument();
    expect(screen.queryByText("Active context")).not.toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("caps the list at 6 rows + a '+N more' tail for a tall (h=2) tile", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, title: `Item ${i}`, content: "", layer: "working", status: "pending" })),
      versions: [],
      archives: [],
      totalCount: 8,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(await screen.findByText("Item 0")).toBeInTheDocument();
    expect(screen.getByText("Item 5")).toBeInTheDocument();
    expect(screen.queryByText("Item 6")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("caps the list at 2 rows + a '+N more' tail for a short (h=1) tile", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, title: `Item ${i}`, content: "", layer: "working", status: "pending" })),
      versions: [],
      archives: [],
      totalCount: 8,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Item 0")).toBeInTheDocument();
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.queryByText("Item 2")).not.toBeInTheDocument();
    expect(screen.getByText("+6 more")).toBeInTheDocument();
  });

  it("shows no '+N more' tail when every item fits inside the current row cap", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: [{ id: "m1", title: "Prefer async standups", content: "...", layer: "domain", status: "pending" }],
      versions: [],
      archives: [],
      totalCount: 1,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Prefer async standups")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("does not render rows as links while editing", async () => {
    memoryApiMock.listPending.mockResolvedValue({
      items: [{ id: "m1", title: "Prefer async standups", content: "...", layer: "domain", status: "pending" }],
      versions: [],
      archives: [],
      totalCount: 1,
    });
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);

    expect(await screen.findByText("Prefer async standups")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Prefer async standups/i })).not.toBeInTheDocument();
  });

  it("the title links to /memory", async () => {
    renderWithProviders(<MemoryReviewWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    const titleLink = await screen.findByRole("link", { name: "Open Memory review" });
    expect(titleLink).toHaveAttribute("href", "/memory");
  });
});
