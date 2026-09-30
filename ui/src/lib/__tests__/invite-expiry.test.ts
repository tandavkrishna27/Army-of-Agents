import { describe, expect, it } from "vitest";
import { formatInviteExpiry, toAbsoluteInviteUrl } from "../invite-expiry";

const NOW = new Date("2026-07-16T12:00:00.000Z");

describe("formatInviteExpiry", () => {
  it("shows minutes under an hour", () => {
    expect(formatInviteExpiry(new Date("2026-07-16T12:04:00.000Z"), NOW)).toBe("expires in 4 min");
    expect(formatInviteExpiry(new Date("2026-07-16T12:10:00.000Z"), NOW)).toBe("expires in 10 min");
  });

  it("shows hours under two days", () => {
    expect(formatInviteExpiry(new Date("2026-07-16T15:00:00.000Z"), NOW)).toBe("expires in 3 hours");
    expect(formatInviteExpiry(new Date("2026-07-16T13:00:00.000Z"), NOW)).toBe("expires in 1 hour");
  });

  it("shows days from two days out", () => {
    expect(formatInviteExpiry(new Date("2026-07-22T12:00:00.000Z"), NOW)).toBe("expires in 6 days");
    expect(formatInviteExpiry(new Date("2026-07-23T12:00:00.000Z"), NOW)).toBe("expires in 7 days");
  });

  it("shows expired for past timestamps", () => {
    expect(formatInviteExpiry(new Date("2026-07-16T11:59:00.000Z"), NOW)).toBe("expired");
  });

  it("accepts ISO strings and rejects garbage", () => {
    expect(formatInviteExpiry("2026-07-22T12:00:00.000Z", NOW)).toBe("expires in 6 days");
    expect(formatInviteExpiry("not-a-date", NOW)).toBe("");
  });
});

describe("toAbsoluteInviteUrl", () => {
  it("passes absolute URLs through untouched", () => {
    expect(toAbsoluteInviteUrl("https://aoa.example.com/invite/tok")).toBe(
      "https://aoa.example.com/invite/tok",
    );
    expect(toAbsoluteInviteUrl("http://localhost:3100/invite/tok")).toBe(
      "http://localhost:3100/invite/tok",
    );
  });

  it("prefixes the current origin for relative paths", () => {
    expect(toAbsoluteInviteUrl("/invite/tok")).toBe(`${window.location.origin}/invite/tok`);
    expect(toAbsoluteInviteUrl("invite/tok")).toBe(`${window.location.origin}/invite/tok`);
  });
});
