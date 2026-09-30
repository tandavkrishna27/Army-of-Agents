import { describe, it, expect } from "vitest";
import {
  SKILL_TOKEN_KIND,
  createSkillToken,
  createMentionToken,
  isRootEmpty,
  isSkillToken,
  serializeRoot,
} from "./commanderInputModel";

const SKILL = {
  name: "brainstorming",
  key: "skill:github-skills/obra/superpowers/brainstorming",
};

function root(): HTMLDivElement { return document.createElement("div"); }

describe("createSkillToken", () => {
  it("renders only the name but carries name + key in data attrs", () => {
    const token = createSkillToken(document, SKILL);
    expect(token.textContent).toBe("brainstorming");
    expect(token.dataset.token).toBe(SKILL_TOKEN_KIND);
    expect(token.dataset.name).toBe(SKILL.name);
    expect(token.dataset.key).toBe(SKILL.key);
    expect(token.getAttribute("contenteditable")).toBe("false");
  });
  it("stashes the description in data-desc for the hover card", () => {
    const token = createSkillToken(document, { ...SKILL, description: "Explore intent first" });
    expect(token.dataset.desc).toBe("Explore intent first");
    const r = root(); r.appendChild(token);
    expect(serializeRoot(r)).toBe(`Use the "brainstorming" skill (skill:github-skills/obra/superpowers/brainstorming).`);
  });
  it("omits data-desc when no description is provided", () => {
    expect(createSkillToken(document, SKILL).dataset.desc).toBeUndefined();
  });
  it("is recognized by isSkillToken", () => {
    expect(isSkillToken(createSkillToken(document, SKILL))).toBe(true);
    expect(isSkillToken(document.createTextNode("hi"))).toBe(false);
    expect(isSkillToken(document.createElement("span"))).toBe(false);
    expect(isSkillToken(null)).toBe(false);
  });
});

describe("serializeRoot", () => {
  it("returns plain text unchanged", () => { const r = root(); r.appendChild(document.createTextNode("hello there")); expect(serializeRoot(r)).toBe("hello there"); });
  it("expands a skill token to its full use_skill directive", () => { const r = root(); r.appendChild(createSkillToken(document, SKILL)); expect(serializeRoot(r)).toContain("Use the \"brainstorming\" skill"); });
  it("mixes text and tokens in document order, normalizing NBSP padding", () => { const r = root(); r.append(document.createTextNode("please "), createSkillToken(document, SKILL), document.createTextNode(" now")); expect(serializeRoot(r)).toContain("please Use the \"brainstorming\" skill"); });
  it("expands multiple tokens", () => { const r = root(); r.append(createSkillToken(document, { name: "a", key: "skill:x/a" }), document.createTextNode(" and "), createSkillToken(document, { name: "b", key: "skill:x/b" })); expect(serializeRoot(r)).toContain("skill:x/a"); expect(serializeRoot(r)).toContain("skill:x/b"); });
  it("treats <br> as a newline", () => { const r = root(); r.append(document.createTextNode("line1"), document.createElement("br"), document.createTextNode("line2")); expect(serializeRoot(r)).toBe("line1\nline2"); });
  it("serializes structured mentions to their display form", () => { const r = root(); r.appendChild(createMentionToken(document, { id: "agent-1", name: "alice" })); expect(r.firstElementChild?.getAttribute("data-id")).toBe("agent-1"); expect(serializeRoot(r)).toBe("@alice"); });
});

describe("isRootEmpty", () => {
  it("is true for empty, leftover br, and whitespace-only editors", () => {
    expect(isRootEmpty(root())).toBe(true);
    const br = root(); br.appendChild(document.createElement("br")); expect(isRootEmpty(br)).toBe(true);
    const ws = root(); ws.appendChild(document.createTextNode("   \n  ")); expect(isRootEmpty(ws)).toBe(true);
  });
  it("is false once real text or a token is present", () => {
    const text = root(); text.appendChild(document.createTextNode("x")); expect(isRootEmpty(text)).toBe(false);
    const token = root(); token.appendChild(createSkillToken(document, SKILL)); expect(isRootEmpty(token)).toBe(false);
  });
});
