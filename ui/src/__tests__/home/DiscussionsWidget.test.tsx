import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "../test-utils";
import { DiscussionsWidget } from "../../components/home/widgets/DiscussionsWidget";

const { discussionsApiMock } = vi.hoisted(() => ({ discussionsApiMock: { list: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => mockDialogContext }));
vi.mock("../../api/discussions", () => ({ discussionsApi: discussionsApiMock }));

describe("DiscussionsWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discussionsApiMock.list.mockResolvedValue({ discussions: [], total: 0, limit: 50, offset: 0 });
  });

  it("renders the 'Discussions' title and queries active discussions", async () => {
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("Discussions")).toBeInTheDocument();
    expect(discussionsApiMock.list).toHaveBeenCalledWith("co-1", { status: "active" });
  });

  it("shows the shell + loading placeholder while the query is in flight", () => {
    discussionsApiMock.list.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText("Discussions")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the query errors", async () => {
    discussionsApiMock.list.mockRejectedValue(new Error("network error"));
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText(/Couldn't load/)).toBeInTheDocument();
  });

  it("shows 'No discussions yet' with a New discussion CTA when there are none", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(await screen.findByText("No discussions yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ New discussion" }));
    expect(mockDialogContext.openDiscussionCapture).toHaveBeenCalledTimes(1);
  });

  it("hides the New discussion CTA while the board is in edit mode", async () => {
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);
    expect(await screen.findByText("No discussions yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New discussion" })).not.toBeInTheDocument();
  });

  it("reads res.discussions (not a bare array) and renders title + entry/pending meta, linking to /discussions/:id", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [
        { id: "d1", title: "Launch retro", status: "active", entryCount: 3, pendingItemCount: 2, lastEntryAt: new Date().toISOString(), createdAt: new Date().toISOString() },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    const link = await screen.findByRole("link", { name: /Launch retro/i });
    expect(link).toHaveAttribute("href", "/discussions/d1");
    expect(screen.getByText(/3 entries/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
  });

  it("omits the pending suffix when pendingItemCount is 0", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [
        { id: "d1", title: "Quiet thread", status: "active", entryCount: 1, pendingItemCount: 0, lastEntryAt: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    await screen.findByText("Quiet thread");
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
  });

  it("sorts by lastEntryAt (falling back to createdAt) descending, and caps at 6 rows + a '+N more' tail for a tall (h=2) tile", async () => {
    const now = Date.now();
    discussionsApiMock.list.mockResolvedValue({
      discussions: [
        { id: "old", title: "Oldest activity", status: "active", entryCount: 1, pendingItemCount: 0, lastEntryAt: new Date(now - 30_000).toISOString(), createdAt: new Date(now - 30_000).toISOString() },
        { id: "newest", title: "Newest activity", status: "active", entryCount: 1, pendingItemCount: 0, lastEntryAt: new Date(now).toISOString(), createdAt: new Date(now - 100_000).toISOString() },
        { id: "no-entries", title: "No entries yet", status: "active", entryCount: 0, pendingItemCount: 0, lastEntryAt: null, createdAt: new Date(now - 10_000).toISOString() },
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `extra-${i}`,
          title: `Extra ${i}`,
          status: "active" as const,
          entryCount: 1,
          pendingItemCount: 0,
          lastEntryAt: null,
          createdAt: new Date(now - 200_000 - i).toISOString(),
        })),
      ],
      total: 7,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    await screen.findByText("Newest activity");
    const links = screen.getAllByRole("link", { name: /activity|entries|Extra/i });
    // Newest (lastEntryAt = now) first, then No-entries (createdAt = now-10s,
    // falls back since lastEntryAt is null), then Oldest activity (now-30s).
    // h=2 -> rowsForSize = 6, so all but the last (oldest) extra fit.
    expect(links.map((l) => l.textContent)).toEqual([
      expect.stringContaining("Newest activity"),
      expect.stringContaining("No entries yet"),
      expect.stringContaining("Oldest activity"),
      expect.stringContaining("Extra 0"),
      expect.stringContaining("Extra 1"),
      expect.stringContaining("Extra 2"),
    ]);
    expect(screen.queryByText("Extra 3")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("caps at 2 rows + a '+N more' tail for a short (h=1) tile", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        title: `Thread ${i}`,
        status: "active" as const,
        entryCount: 1,
        pendingItemCount: 0,
        lastEntryAt: new Date(Date.now() - i * 1_000).toISOString(),
        createdAt: new Date(Date.now() - i * 1_000).toISOString(),
      })),
      total: 5,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Thread 0")).toBeInTheDocument();
    expect(screen.getByText("Thread 1")).toBeInTheDocument();
    expect(screen.queryByText("Thread 2")).not.toBeInTheDocument();
    expect(screen.getByText("+3 more")).toBeInTheDocument();
  });

  it("shows no '+N more' tail when every discussion fits inside the current row cap", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [
        { id: "d1", title: "Only thread", status: "active", entryCount: 1, pendingItemCount: 0, lastEntryAt: null, createdAt: new Date().toISOString() },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Only thread")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("does not render rows as links while editing", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [{ id: "d1", title: "Launch retro", status: "active", entryCount: 3, pendingItemCount: 0, lastEntryAt: null, createdAt: new Date().toISOString() }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);

    expect(await screen.findByText("Launch retro")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Launch retro/i })).not.toBeInTheDocument();
  });

  it("the title links to /discussions", async () => {
    renderWithProviders(<DiscussionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    const titleLink = await screen.findByRole("link", { name: "Open Discussions" });
    expect(titleLink).toHaveAttribute("href", "/discussions");
  });
});
