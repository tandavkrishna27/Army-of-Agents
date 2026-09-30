import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_DRAFT_VERSION,
  composerDraftStorageKey,
  deserializeComposerDraft,
  serializeComposerDraft,
  useComposerDraft,
  type ComposerDraftStorage,
} from "../composerDraft";

function memoryStorage(): ComposerDraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const key = { companyId: "co:1", userId: "u/2", surface: "discussion" as const, entityId: "d:3", replyTargetId: null };

describe("composer draft contract", () => {
  it("keys drafts by company, user, surface, entity, and reply target", () => {
    expect(composerDraftStorageKey(key)).not.toBe(composerDraftStorageKey({ ...key, replyTargetId: "entry-4" }));
    expect(composerDraftStorageKey(key)).toContain("co%3A1");
    expect(composerDraftStorageKey(key)).toContain("u%2F2");
  });

  it("round-trips text, tokens, and attachment refs without byte-bearing fields", () => {
    const raw = serializeComposerDraft({
      text: "hello",
      tokens: [{ type: "mention", id: "agent-1", label: "Ada" }],
      attachments: [{ id: "asset-1", name: "brief.pdf", mimeType: "application/pdf", artifactId: "artifact-1", bytes: "must-not-persist" } as never],
    }, 100, 1_000);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(COMPOSER_DRAFT_VERSION);
    expect(parsed.draft.attachments[0]).not.toHaveProperty("bytes");
    expect(deserializeComposerDraft(raw, 500)).toEqual({
      text: "hello",
      tokens: [{ type: "mention", id: "agent-1", label: "Ada" }],
      attachments: [{ id: "asset-1", name: "brief.pdf", mimeType: "application/pdf", artifactId: "artifact-1" }],
    });
  });

  it("rejects malformed, future-version, and expired records", () => {
    expect(deserializeComposerDraft("not-json", 100)).toBeNull();
    expect(deserializeComposerDraft(JSON.stringify({ version: COMPOSER_DRAFT_VERSION + 1, expiresAt: 1000, draft: {} }), 100)).toBeNull();
    expect(deserializeComposerDraft(JSON.stringify({ version: COMPOSER_DRAFT_VERSION, expiresAt: 100, draft: {} }), 100)).toBeNull();
  });

  it("recovers the scoped draft and persists updates", () => {
    const storage = memoryStorage();
    const first = renderHook(() => useComposerDraft(key, {}, { storage, now: () => 100 }));
    act(() => first.result.current.setDraft({ text: "recover me" }));
    first.unmount();
    const second = renderHook(() => useComposerDraft(key, {}, { storage, now: () => 101 }));
    expect(second.result.current.draft.text).toBe("recover me");
    act(() => second.result.current.clearDraft());
    expect(second.result.current.draft.text).toBe("");
  });

  it("does not copy the previous entity draft during a host transition", () => {
    const storage = memoryStorage();
    const first = renderHook(({ entityId }) => useComposerDraft({ ...key, entityId }, {}, { storage, now: () => 100 }), {
      initialProps: { entityId: "first" },
    });
    act(() => first.result.current.setDraft({ text: "first only" }));
    act(() => first.rerender({ entityId: "second" }));
    expect(first.result.current.draft.text).toBe("");
  });

  it("never exposes the new storageKey paired with the previous entity's draft (PR #291)", () => {
    // WorkspaceTimeline mirrors draft.text into local state via
    // useEffect(..., [storageKey]); InternalAgentPanel marks a key hydrated the
    // first time it sees it. If the hook returns { new key, old draft } for
    // even one committed render, the old task's text is copied into the new
    // task and the new entity's real saved draft is lost.
    const storage = memoryStorage();
    // The second entity already has a saved draft to restore.
    storage.setItem(
      composerDraftStorageKey({ ...key, entityId: "second" }),
      serializeComposerDraft({ text: "second saved", tokens: [], attachments: [] }, 100, 1_000),
    );

    const hook = renderHook(
      ({ entityId }) => {
        const res = useComposerDraft({ ...key, entityId }, {}, { storage, now: () => 100 });
        // The exact consumer pattern from WorkspaceTimeline.
        const [chatInput, setChatInput] = useState("");
        useEffect(() => {
          setChatInput(res.draft.text);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [res.storageKey]);
        return { res, chatInput };
      },
      { initialProps: { entityId: "first" } },
    );
    act(() => hook.result.current.res.setDraft({ text: "first only" }));
    expect(hook.result.current.chatInput).toBe("");

    act(() => hook.rerender({ entityId: "second" }));

    // The consumer's storageKey-driven mirror observed the SECOND entity's
    // draft — never the first entity's text.
    expect(hook.result.current.chatInput).toBe("second saved");
    expect(hook.result.current.res.draft.text).toBe("second saved");
    // And the first entity's draft was not overwritten or leaked into storage
    // under the second key.
    const persistedSecond = deserializeComposerDraft(
      storage.getItem(composerDraftStorageKey({ ...key, entityId: "second" })),
      100,
    );
    expect(persistedSecond?.text).toBe("second saved");
  });

  it("remains usable when storage is unavailable or throws", () => {
    const broken: ComposerDraftStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const result = renderHook(() => useComposerDraft(key, {}, { storage: broken })).result;
    expect(result.current.storageAvailable).toBe(true);
    act(() => result.current.setDraft({ text: "still works" }));
    expect(result.current.draft.text).toBe("still works");
  });
});
