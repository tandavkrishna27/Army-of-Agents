import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { LobbyEmptyState } from "../components/LobbyEmptyState";

describe("LobbyEmptyState", () => {
  it("shows the crew-hero headline", () => {
    renderWithProviders(<LobbyEmptyState onCreate={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByText(/bigger than your headcount/i)).toBeInTheDocument();
  });

  it("shows a Create company CTA", () => {
    renderWithProviders(<LobbyEmptyState onCreate={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByRole("button", { name: /create organization/i })).toBeInTheDocument();
  });

  it("shows an Import company CTA", () => {
    renderWithProviders(<LobbyEmptyState onCreate={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByRole("button", { name: /import organization/i })).toBeInTheDocument();
  });

  it("invokes onCreate when the create button is clicked", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    renderWithProviders(<LobbyEmptyState onCreate={onCreate} onImport={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /create organization/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("invokes onImport when the import button is clicked", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    renderWithProviders(<LobbyEmptyState onCreate={vi.fn()} onImport={onImport} />);
    await user.click(screen.getByRole("button", { name: /import organization/i }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-trigger any callbacks on mount", () => {
    const onCreate = vi.fn();
    const onImport = vi.fn();
    renderWithProviders(<LobbyEmptyState onCreate={onCreate} onImport={onImport} />);
    expect(onCreate).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });
});
