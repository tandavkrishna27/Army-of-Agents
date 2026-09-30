import { describe, expect, it, vi } from "vitest";
import { guardPluginHostHandlers } from "../services/plugin-availability.js";

function dbWith(
  pluginRows: Array<{ companyId: string; status: string }>,
  settingsRows: Array<{ enabled: boolean }>
) {
  const results = [pluginRows, settingsRows];
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(results[call++] ?? []),
      }),
    }),
  } as any;
}

describe("plugin host RPC availability guard", () => {
  it("allows a ready plugin when no company settings row exists", async () => {
    const handler = vi.fn(async () => "ok");
    const guarded = guardPluginHostHandlers(
      dbWith([{ companyId: "company-a", status: "ready" }], []),
      "plugin-a",
      { "config.get": handler } as any
    );

    await expect(guarded["config.get"]!({})).resolves.toBe("ok");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects an explicitly disabled plugin before invoking a host service", async () => {
    const handler = vi.fn(async () => "secret");
    const guarded = guardPluginHostHandlers(
      dbWith(
        [{ companyId: "company-a", status: "ready" }],
        [{ enabled: false }]
      ),
      "plugin-a",
      { "secrets.resolve": handler } as any
    );

    await expect(guarded["secrets.resolve"]!({})).rejects.toThrow(/disabled/);
    expect(handler).not.toHaveBeenCalled();
  });
});
