import { renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { expect, it } from "vitest";

// Test the populate effect logic in isolation.
// Key invariant: when conversationId changes AND historyData is the SAME object reference
// (cache hit), messages must still be re-populated (not stay blank).
it("repopulates messages when conversationId changes even if historyData reference is stable", () => {
  // Shared historyData object — same reference throughout (simulates TanStack Query cache hit)
  const historyData = {
    messages: [{ id: "m1", role: "assistant" as const, content: "Hello" }],
  };

  let setMessagesCalls = 0;

  const { result, rerender } = renderHook(
    ({ conversationId }: { conversationId: string }) => {
      const [messages, setMessages] = useState<typeof historyData.messages>([]);

      // Reset effect — clears messages when switching conversations
      useEffect(() => {
        setMessages([]);
      }, [conversationId]);

      // Populate effect — AFTER the fix: dep array includes conversationId
      useEffect(() => {
        if (!historyData?.messages?.length) return;
        setMessages(historyData.messages);
        setMessagesCalls++;
      }, [historyData, conversationId]); // ← FIXED: includes conversationId

      return messages;
    },
    { initialProps: { conversationId: "conv-a" } }
  );

  // Initial render: messages populated for conv-a
  expect(result.current).toHaveLength(1);
  const callsAfterFirstRender = setMessagesCalls;

  // Switch to conv-b with SAME historyData reference (cache hit)
  rerender({ conversationId: "conv-b" });

  // AFTER fix: setMessagesCalls increased → messages populated
  expect(setMessagesCalls).toBeGreaterThan(callsAfterFirstRender);
  expect(result.current).toHaveLength(1);
});
