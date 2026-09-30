import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExpiresAtChip, expiresAtTier } from "../components/memory/ExpiresAtChip";

const NOW = new Date("2026-05-03T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("expiresAtTier", () => {
  it("returns null for null/undefined", () => {
    expect(expiresAtTier(null)).toBe(null);
    expect(expiresAtTier(undefined)).toBe(null);
  });

  it("returns 'expired' for dates in the past", () => {
    expect(expiresAtTier(new Date("2026-05-01T00:00:00Z"))).toBe("expired");
  });

  it("returns 'today' for dates within the next 24 hours", () => {
    expect(expiresAtTier(new Date("2026-05-03T18:00:00Z"))).toBe("today");
    expect(expiresAtTier(new Date("2026-05-04T11:59:00Z"))).toBe("today");
  });

  it("returns 'soon' for dates within 2-7 days", () => {
    expect(expiresAtTier(new Date("2026-05-05T12:00:00Z"))).toBe("soon");
    expect(expiresAtTier(new Date("2026-05-10T11:00:00Z"))).toBe("soon");
  });

  it("returns 'distant' for dates beyond 7 days", () => {
    expect(expiresAtTier(new Date("2026-05-11T12:00:00Z"))).toBe("distant");
    expect(expiresAtTier(new Date("2026-06-15T12:00:00Z"))).toBe("distant");
  });
});

describe("ExpiresAtChip", () => {
  it("renders nothing when expiresAt is null", () => {
    const { container } = render(<ExpiresAtChip expiresAt={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'expired' tier as red when past", () => {
    render(<ExpiresAtChip expiresAt={new Date("2026-05-01T00:00:00Z")} />);
    const chip = screen.getByText(/expired/i);
    expect(chip).toBeInTheDocument();
    expect(chip.className).toMatch(/text-red/);
  });

  it("renders 'today' tier as red", () => {
    render(<ExpiresAtChip expiresAt={new Date("2026-05-03T18:00:00Z")} />);
    const chip = screen.getByText(/expires today/i);
    expect(chip.className).toMatch(/text-red/);
  });

  it("renders 'soon' tier as amber with 'in Nd' format", () => {
    render(<ExpiresAtChip expiresAt={new Date("2026-05-08T12:00:00Z")} />);
    const chip = screen.getByText(/expires in 5d/i);
    expect(chip.className).toMatch(/text-amber/);
  });

  it("renders 'distant' tier as muted with date format", () => {
    render(<ExpiresAtChip expiresAt={new Date("2026-06-14T12:00:00Z")} />);
    const chip = screen.getByText(/expires Jun 14/i);
    expect(chip.className).toMatch(/text-muted/);
  });
});
