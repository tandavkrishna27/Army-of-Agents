import { describe, expect, it } from "vitest";
import { computeTeamBoxes, type LaidOutCard } from "../teamBoundingBox";

const CARD_W = 200;
const CARD_H = 100;
const PADDING = 16;

describe("computeTeamBoxes", () => {
  it("returns a single box around members of a team", () => {
    const cards: LaidOutCard[] = [
      { agentId: "a1", x: 100, y: 100, w: CARD_W, h: CARD_H },
      { agentId: "a2", x: 350, y: 100, w: CARD_W, h: CARD_H },
    ];
    const memberships = new Map([["a1", "team1"], ["a2", "team1"]]);
    const teams = [{ id: "team1", name: "Frontend", color: "#6366f1" }];

    const boxes = computeTeamBoxes(cards, memberships, teams);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      teamId: "team1",
      name: "Frontend",
      color: "#6366f1",
      x: 100 - PADDING,
      y: 100 - PADDING,
      width: 350 + CARD_W - 100 + PADDING * 2,
      height: CARD_H + PADDING * 2,
    });
  });

  it("returns empty array when no team memberships", () => {
    const cards: LaidOutCard[] = [{ agentId: "a1", x: 0, y: 0, w: CARD_W, h: CARD_H }];
    expect(computeTeamBoxes(cards, new Map(), [])).toEqual([]);
  });

  it("returns one box per team", () => {
    const cards: LaidOutCard[] = [
      { agentId: "a1", x: 0, y: 0, w: CARD_W, h: CARD_H },
      { agentId: "a2", x: 0, y: 200, w: CARD_W, h: CARD_H },
    ];
    const memberships = new Map([["a1", "t1"], ["a2", "t2"]]);
    const teams = [
      { id: "t1", name: "T1", color: "#a" },
      { id: "t2", name: "T2", color: "#b" },
    ];
    const boxes = computeTeamBoxes(cards, memberships, teams);
    expect(boxes).toHaveLength(2);
  });

  it("ignores teams with no laid-out members", () => {
    const cards: LaidOutCard[] = [{ agentId: "a1", x: 0, y: 0, w: CARD_W, h: CARD_H }];
    const memberships = new Map([["a99", "t1"]]); // a99 isn't in cards
    const teams = [{ id: "t1", name: "T1", color: "#a" }];
    expect(computeTeamBoxes(cards, memberships, teams)).toEqual([]);
  });

  it("computes correct box for team with members spanning rows", () => {
    const cards: LaidOutCard[] = [
      { agentId: "a1", x: 0, y: 0, w: CARD_W, h: CARD_H },
      { agentId: "a2", x: 250, y: 250, w: CARD_W, h: CARD_H },
    ];
    const memberships = new Map([["a1", "t1"], ["a2", "t1"]]);
    const teams = [{ id: "t1", name: "T1", color: "#a" }];
    const boxes = computeTeamBoxes(cards, memberships, teams);
    expect(boxes[0]).toMatchObject({
      x: 0 - PADDING,
      y: 0 - PADDING,
      width: 250 + CARD_W - 0 + PADDING * 2,  // 466
      height: 250 + CARD_H - 0 + PADDING * 2,  // 366
    });
  });
});
