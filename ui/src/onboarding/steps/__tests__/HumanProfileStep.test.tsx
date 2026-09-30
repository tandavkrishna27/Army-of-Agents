import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HumanProfileStep } from "../HumanProfileStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const saveUserProfile = vi.hoisted(() => vi.fn(async (input: unknown) => input));
const getUserProfile = vi.hoisted(() =>
  vi.fn(async () => ({
    userId: "u1", displayName: "Ada", avatarUrl: null, title: null,
    bio: null, timezone: null, socialLinks: [],
  })),
);
const updateProfile = vi.hoisted(() => vi.fn(async () => ({ profile: {} })));
vi.mock("../../../api/userProfile", () => ({ saveUserProfile, getUserProfile }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: ["AUTHENTICATED", "PROFILE_SET"] })),
}));
vi.mock("../../../api/team", () => ({ teamApi: { updateProfile } }));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: null, // invited runs on the user layer
  journey: "invited",
  completedStates: ["AUTHENTICATED"],
};

describe("HumanProfileStep (shared; wired invited)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefills Name from the global profile; submit blocked until Title is chosen", async () => {
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada"),
    );
    const btn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // title still missing (timezone auto-detects)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    expect(btn.disabled).toBe(false);
  });

  it("requires a name when no global profile exists yet", async () => {
    getUserProfile.mockResolvedValueOnce(null as never);
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).not.toBe(""),
    );
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the full global profile (incl timezone) then advances PROFILE_SET", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Asia/Kolkata" } });
    fireEvent.change(screen.getByLabelText("Short bio (optional)"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Ada",
        title: "Engineer",
        timezone: "Asia/Kolkata",
        bio: "hi",
      }),
    );
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "invited",
      requestedState: "PROFILE_SET",
    });
  });

  it("surfaces a save failure and re-enables the button", async () => {
    saveUserProfile.mockRejectedValueOnce(new Error("save blew up"));
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).not.toBe(""),
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("save blew up")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saved timezone wins over the browser-detected zone", async () => {
    getUserProfile.mockResolvedValueOnce({
      userId: "u1", displayName: "Ada", avatarUrl: null, title: null,
      bio: null, timezone: "America/New_York", socialLinks: [],
    });
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("America/New_York"),
    );
  });

  it("detected timezone applies when the profile has none", async () => {
    const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe(expected),
    );
  });

  it("typed input wins over the async prefill", async () => {
    let resolveProfile!: (p: unknown) => void;
    getUserProfile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grace" } });
    resolveProfile({
      userId: "u1", displayName: "Ada", avatarUrl: null, title: null,
      bio: null, timezone: null, socialLinks: [],
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).not.toBe(""),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grace");
  });

  it("founder journey: runs on the user layer (companyId null) — global profile write + user-layer advance only", async () => {
    const founderCtx: StepContext = { ...ctx, journey: "founder" };
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={founderCtx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Founder" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // No company exists yet at the founder-journey position; the step must
    // stay user-layer only (the mocked modules are the step's ONLY api deps).
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada", title: "Founder", timezone: "UTC" }),
    );
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "founder",
      requestedState: "PROFILE_SET",
    });
  });

  it("social links are trimmed, filtered, scheme-defaulted, and mapped to type website", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Asia/Kolkata" } });
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "https://ada.dev" } });
    fireEvent.change(screen.getByLabelText("Social link 2"), { target: { value: "   " } });
    // Schemeless paste — the approval-time z.string().url() filter would
    // silently drop it; the step must default to https.
    fireEvent.change(screen.getByLabelText("Social link 3"), { target: { value: "linkedin.com/in/ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        socialLinks: [
          { type: "website", label: null, url: "https://ada.dev" },
          { type: "website", label: null, url: "https://linkedin.com/in/ada" },
        ],
      }),
    );
  });

  it("C3: prefills social link rows from the saved profile and resubmits them (not [])", async () => {
    getUserProfile.mockResolvedValueOnce({
      userId: "u1", displayName: "Ada", avatarUrl: null, title: "Engineer",
      bio: null, timezone: "UTC",
      socialLinks: [
        { type: "website", label: null, url: "https://ada.dev" },
        { type: "linkedin", label: null, url: "https://linkedin.com/in/ada" },
      ],
    });
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    // Saved URLs prefill the link rows.
    await waitFor(() =>
      expect((screen.getByLabelText("Social link 1") as HTMLInputElement).value).toBe("https://ada.dev"),
    );
    expect((screen.getByLabelText("Social link 2") as HTMLInputElement).value).toBe("https://linkedin.com/in/ada");
    // Continue WITHOUT touching them → resubmit the same URLs, never [] (data loss).
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        socialLinks: [
          { type: "website", label: null, url: "https://ada.dev" },
          { type: "website", label: null, url: "https://linkedin.com/in/ada" },
        ],
      }),
    );
  });

  it("C3: a social link typed during the async load survives the prefill", async () => {
    let resolveProfile!: (p: unknown) => void;
    getUserProfile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "https://typed.dev" } });
    resolveProfile({
      userId: "u1", displayName: "Ada", avatarUrl: null, title: "Engineer",
      bio: null, timezone: "UTC",
      socialLinks: [{ type: "website", label: null, url: "https://prefill.dev" }],
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("UTC"),
    );
    // The user's row is untouched; the prefill neither replaced nor appended.
    expect((screen.getByLabelText("Social link 1") as HTMLInputElement).value).toBe("https://typed.dev");
    expect(screen.queryByLabelText("Social link 2")).toBeNull();
  });

  it("C2: revisit with companyId set syncs the edited fields to the company profile", async () => {
    const onComplete = vi.fn();
    const revisitCtx: StepContext = { ...ctx, companyId: "co-1", journey: "founder" };
    render(<HumanProfileStep ctx={revisitCtx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Founder" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.change(screen.getByLabelText("Short bio (optional)"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // Same current user (ctx.userId) editing their OWN company profile.
    expect(updateProfile).toHaveBeenCalledWith(
      "co-1",
      "u1",
      expect.objectContaining({ displayName: "Ada", title: "Founder", timezone: "UTC", bio: "hi" }),
    );
    // saveUserProfile + updateProfile share the SAME normalized socialLinks payload.
    const globalArg = saveUserProfile.mock.calls[0][0] as { socialLinks: unknown };
    const companyArg = updateProfile.mock.calls[0][2] as { socialLinks: unknown };
    expect(companyArg.socialLinks).toEqual(globalArg.socialLinks);
  });

  it("C2: first pass with companyId null does NOT touch the company profile", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("C2: a company-profile sync failure is surfaced and blocks the advance", async () => {
    updateProfile.mockRejectedValueOnce(new Error("company sync failed"));
    const onComplete = vi.fn();
    const revisitCtx: StepContext = { ...ctx, companyId: "co-1", journey: "founder" };
    render(<HumanProfileStep ctx={revisitCtx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Founder" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("company sync failed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(advanceOnboarding).not.toHaveBeenCalled();
  });

  it("social link rows can be removed (X button drops the row and its value)", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "https://drop.me" } });
    fireEvent.change(screen.getByLabelText("Social link 2"), { target: { value: "https://ada.dev" } });
    fireEvent.click(screen.getByLabelText("Remove social link 1"));
    // The remaining row shifted up to slot 1 and kept its value.
    expect((screen.getByLabelText("Social link 1") as HTMLInputElement).value).toBe("https://ada.dev");
    expect(screen.queryByLabelText("Social link 2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        socialLinks: [{ type: "website", label: null, url: "https://ada.dev" }],
      }),
    );
  });

  it("Codex P2: a malformed social link blocks submit and is surfaced (not silently dropped)", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByText("+ Add link"));
    // "not a url" → normalized to "https://not a url" → fails z.string().url().
    // The old code saved it, advanced, then materialization dropped it — so the
    // user was told "saved" while the link vanished. It must be surfaced instead.
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/valid link/i)).toBeTruthy();
    expect(saveUserProfile).not.toHaveBeenCalled();
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // Button re-enabled so the user can fix it.
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Codex P2: fixing the invalid link clears the error and proceeds (recoverable)", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/valid link/i)).toBeTruthy();
    // Correct it to a schemeless-but-valid link — still normalized to https and accepted.
    fireEvent.change(screen.getByLabelText("Social link 1"), { target: { value: "linkedin.com/in/ada" } });
    expect(screen.queryByText(/valid link/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        socialLinks: [{ type: "website", label: null, url: "https://linkedin.com/in/ada" }],
      }),
    );
  });
});

describe("registry rewire", () => {
  it("still passes the guard", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
  });
  it("both journeys use human-profile; the bare profile step is gone", () => {
    const bare = ONBOARDING_STEPS.find((s) => s.id === "profile");
    const rich = ONBOARDING_STEPS.find((s) => s.id === "human-profile");
    expect(bare).toBeUndefined();
    expect(rich?.journeys).toEqual(["founder", "invited"]);
    expect(rich?.state).toBe("PROFILE_SET");
    expect(rich?.order).toBe(1);
  });
});
