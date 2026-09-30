import { describe, expect, it } from "vitest";
import { hashCommanderSubmission } from "../services/internal-agent/submission-identity.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

describe("Commander submission identity", () => {
  it("ignores ambient page context by construction and is object-key stable", () => {
    const first = hashCommanderSubmission({conversationId: CONVERSATION, message: "Do it", contextScope: {surface: "universe", route: "/universe"}});
    const second = hashCommanderSubmission({message: "Do it", conversationId: CONVERSATION, contextScope: {route: "/universe", surface: "universe"}});
    expect(first).toBe(second);
  });

  it("changes for message, ordered attachments, or frozen Universe selection", () => {
    const base = {conversationId: CONVERSATION, message: "Use this", attachmentAssetIds: [TASK], universeContext: {schemaVersion: 1 as const, conversationId: CONVERSATION, selected: {kind: "task" as const, id: TASK}, visible: [{kind: "task" as const, id: TASK}], viewport: {width: 1000, height: 700, x: 0, y: 0, zoom: 1}}};
    const hash = hashCommanderSubmission(base);
    expect(hashCommanderSubmission({...base, message: "Use that"})).not.toBe(hash);
    expect(hashCommanderSubmission({...base, attachmentAssetIds: [CONVERSATION, TASK]})).not.toBe(hash);
    expect(hashCommanderSubmission({...base, universeContext: {...base.universeContext, selected: null}})).not.toBe(hash);
  });
});
