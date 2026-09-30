import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { getProviderById } from "@armyofagents/shared";
import type { ProviderStatusRow, ScopedReadiness } from "@/api/providers";
import { deriveProviderBadge, TONE_DOT } from "../ProviderReadinessCard";
import { ProviderList } from "../ProviderList";

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return { scopeType: "company_default", scopeId: null, outcome: "verified", testedAt: null, checks: [], ...over };
}
function agentScope(name: string): ScopedReadiness {
  return { scopeType: "agent", scopeId: name, agentName: name, outcome: "verified", testedAt: null, checks: [] };
}
function row(id: string, over: Partial<ProviderStatusRow> = {}): ProviderStatusRow {
  const d = getProviderById(id)!;
  return {
    descriptor: d,
    companyDefault: scope(),
    agents: [],
    existingKey: { configured: false, source: null, secretName: null, envVar: d.credential.apiKey?.envVar ?? null },
    ...over,
  };
}
function item(id: string) {
  return screen
    .getAllByTestId("provider-list-item")
    .find((el) => el.getAttribute("data-provider") === id);
}

describe("ProviderList", () => {
  it("renders one item per provider, labelled", () => {
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getAllByTestId("provider-list-item")).toHaveLength(2);
    expect(item("anthropic")?.textContent).toMatch(/Claude/);
  });

  it("splits In use (has agents) from Available, and hides an empty group", () => {
    render(
      <ProviderList
        rows={[row("anthropic", { agents: [agentScope("Scout")] }), row("openai")]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
  });

  it("hides the In use header when nothing is in use", () => {
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText("In use")).toBeNull();
  });

  it("marks the selected item and fires onSelect with the provider id", () => {
    const onSelect = vi.fn();
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId="anthropic" onSelect={onSelect} />);
    expect(item("anthropic")?.getAttribute("aria-selected")).toBe("true");
    expect(item("openai")?.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(item("openai")!);
    expect(onSelect).toHaveBeenCalledWith("openai");
  });

  it("paints the status dot with the same tone the card badge would show", () => {
    // A verified default with a needs_auth agent -> warn tone.
    const r = row("anthropic", { agents: [{ scopeType: "agent", scopeId: "A", agentName: "A", outcome: "needs_auth", testedAt: null, checks: [] }] });
    render(<ProviderList rows={[r]} selectedId={null} onSelect={() => {}} />);
    const dot = item("anthropic")!.querySelector("[data-testid='provider-list-dot']")!;
    expect(deriveProviderBadge(r).tone).toBe("warn");
    expect(dot.className).toContain(TONE_DOT.warn);
  });
});
