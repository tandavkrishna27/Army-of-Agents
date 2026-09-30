import { describe, expect, it } from "vitest";
import {
  resolveWorkQuestionCapabilities,
  workQuestionSourcesMatchCompany,
  type WorkQuestionCapabilityContext,
} from "../services/work-question-capabilities.js";

function context(overrides: Partial<WorkQuestionCapabilityContext> = {}): WorkQuestionCapabilityContext {
  return {
    actorKind: "user",
    sameCompany: true,
    companyAccess: true,
    instanceAdmin: false,
    founder: false,
    currentRecipient: false,
    taskReadable: true,
    taskResponsible: false,
    taskReviewer: false,
    scopedLeadForTask: false,
    reassignTargetInLeadScope: false,
    agentIsOrg: false,
    agentHasActiveRun: false,
    taskIsNonterminal: false,
    taskAssignedToActorAgent: false,
    checkoutOwnedByRun: false,
    producerOwnsQuestion: false,
    workIsActive: false,
    ...overrides,
  };
}

describe("work-question capability matrix", () => {
  it("allows creation only for the assigned org agent in its active checked-out run", () => {
    const valid = context({
      actorKind: "agent",
      companyAccess: false,
      taskReadable: false,
      agentIsOrg: true,
      agentHasActiveRun: true,
      taskIsNonterminal: true,
      taskAssignedToActorAgent: true,
      checkoutOwnedByRun: true,
    });
    expect(resolveWorkQuestionCapabilities(valid).create).toBe(true);

    for (const invalid of [
      { sameCompany: false },
      { agentIsOrg: false },
      { agentHasActiveRun: false },
      { taskIsNonterminal: false },
      { taskAssignedToActorAgent: false },
      { checkoutOwnedByRun: false },
    ]) {
      expect(resolveWorkQuestionCapabilities({ ...valid, ...invalid }).create).toBe(false);
    }
  });

  it("allows source-task readers and the current recipient to read without leaking to others", () => {
    expect(resolveWorkQuestionCapabilities(context()).read).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ taskReadable: false, currentRecipient: true })).read).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ taskReadable: false })).read).toBe(false);
    expect(resolveWorkQuestionCapabilities(context({ sameCompany: false, currentRecipient: true })).read).toBe(false);
    expect(resolveWorkQuestionCapabilities(context({ companyAccess: false, currentRecipient: true })).read).toBe(false);
  });

  it("allows an instance administrator to read without an active company membership", () => {
    const capabilities = resolveWorkQuestionCapabilities(context({
      companyAccess: false,
      instanceAdmin: true,
      taskReadable: false,
    }));

    expect(capabilities.read).toBe(true);
    expect(capabilities.answer).toBe(false);
  });

  it("allows answers only from the current recipient", () => {
    expect(resolveWorkQuestionCapabilities(context({ currentRecipient: true })).answer).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ founder: true })).answer).toBe(false);
    expect(resolveWorkQuestionCapabilities(context({ taskResponsible: true })).answer).toBe(false);
  });

  it("implements reassign and takeover scope independently", () => {
    expect(resolveWorkQuestionCapabilities(context({ currentRecipient: true })).reassign).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ founder: true })).reassign).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({
      scopedLeadForTask: true,
      reassignTargetInLeadScope: true,
    })).reassign).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({
      scopedLeadForTask: true,
      reassignTargetInLeadScope: false,
    })).reassign).toBe(false);

    expect(resolveWorkQuestionCapabilities(context({ taskResponsible: true })).takeOver).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ taskReviewer: true })).takeOver).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ scopedLeadForTask: true })).takeOver).toBe(true);
  });

  it("limits continuation retry to accountable humans with source access", () => {
    expect(resolveWorkQuestionCapabilities(context({ founder: true })).retryContinuation).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ taskResponsible: true })).retryContinuation).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ taskReviewer: true })).retryContinuation).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ currentRecipient: true })).retryContinuation).toBe(false);
    expect(resolveWorkQuestionCapabilities(context({ taskReadable: false, taskResponsible: true })).retryContinuation).toBe(false);
  });

  it("allows cancellation only to privileged users or the active owning producer", () => {
    expect(resolveWorkQuestionCapabilities(context({ founder: true })).cancel).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({ instanceAdmin: true })).cancel).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({
      actorKind: "system",
      companyAccess: false,
      taskReadable: false,
      producerOwnsQuestion: true,
      workIsActive: true,
    })).cancel).toBe(true);
    expect(resolveWorkQuestionCapabilities(context({
      actorKind: "system",
      producerOwnsQuestion: true,
      workIsActive: false,
    })).cancel).toBe(false);
  });
});

describe("work-question source company validation", () => {
  it("accepts optional sources only when every resolved source matches", () => {
    expect(workQuestionSourcesMatchCompany("company-a", {
      issue: "company-a",
      askingAgent: "company-a",
      workspace: null,
      discussion: "company-a",
      commanderConversation: undefined,
      recipientMembership: "company-a",
    })).toBe(true);
    expect(workQuestionSourcesMatchCompany("company-a", {
      issue: "company-a",
      askingAgent: "company-b",
    })).toBe(false);
  });
});
