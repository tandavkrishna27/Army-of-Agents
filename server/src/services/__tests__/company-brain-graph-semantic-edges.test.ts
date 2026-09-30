import { describe, expect, it } from "vitest";
import { companyBrainEdges } from "@armyofagents/db";
import { badRequest, conflict } from "../../errors.js";
import {
  __companyBrainGraphTest,
  buildMemoryItemNeighborGraph,
  type GraphActorScope,
  type MemoryItemGraphRow,
} from "../company-brain-graph.js";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const DEPARTMENT_ID = "00000000-0000-0000-0000-000000000101";
const CENTER_ID = "00000000-0000-0000-0000-000000000901";
const RELATED_ID = "00000000-0000-0000-0000-000000000902";
const PRIVATE_ID = "00000000-0000-0000-0000-000000000903";

const founder: GraphActorScope = {
  actorType: "user",
  principalId: "founder@example.com",
  role: "founder",
  departmentIds: [],
  activeCompanyMember: true,
};

const member: GraphActorScope = {
  actorType: "user",
  principalId: "member@example.com",
  role: "team_member",
  departmentIds: [DEPARTMENT_ID],
  activeCompanyMember: true,
};

function memory(overrides: Partial<MemoryItemGraphRow> = {}): MemoryItemGraphRow {
  return {
    id: CENTER_ID,
    companyId: COMPANY_ID,
    title: "Pricing policy",
    content: "Price by seat.",
    status: "approved",
    category: "decision",
    layer: "domain",
    visibility: "scoped",
    departmentId: DEPARTMENT_ID,
    projectId: null,
    goalId: null,
    taskId: null,
    sourceArtifactId: null,
    agentId: null,
    folderPath: "Pricing",
    createdBy: "founder@example.com",
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("company_brain_edges schema", () => {
  it("exports the semantic edge table", () => {
    expect(companyBrainEdges).toBeDefined();
  });
});

describe("semantic edge mutation rules", () => {
  it("accepts related_to with evidence and confidence", () => {
    const edge = __companyBrainGraphTest.prepareSemanticEdgeCreate({
      companyId: COMPANY_ID,
      input: {
        from: { type: "memory_item", id: CENTER_ID },
        to: { type: "memory_item", id: RELATED_ID },
        kind: "related_to",
        confidence: 0.82,
        evidence: "Both items describe billing policy.",
      },
      actor: { actorType: "user", actorId: "founder@example.com" },
      duplicateRows: [],
    });

    expect(edge).toMatchObject({
      companyId: COMPANY_ID,
      fromType: "memory_item",
      fromId: CENTER_ID,
      toType: "memory_item",
      toId: RELATED_ID,
      kind: "related_to",
      confidence: "0.82",
      evidence: "Both items describe billing policy.",
      createdByPrincipalType: "user",
      createdByPrincipalId: "founder@example.com",
      source: "manual",
      status: "active",
    });
  });

  it("rejects duplicate same-direction active edges", () => {
    expect(() =>
      __companyBrainGraphTest.prepareSemanticEdgeCreate({
        companyId: COMPANY_ID,
        input: {
          from: { type: "memory_item", id: CENTER_ID },
          to: { type: "memory_item", id: RELATED_ID },
          kind: "related_to",
        },
        actor: { actorType: "user", actorId: "founder@example.com" },
        duplicateRows: [{ id: "edge-1", status: "active" }],
      }),
    ).toThrow(conflict("Semantic edge already exists").message);
  });

  it("rejects self-loops", () => {
    expect(() =>
      __companyBrainGraphTest.prepareSemanticEdgeCreate({
        companyId: COMPANY_ID,
        input: {
          from: { type: "memory_item", id: CENTER_ID },
          to: { type: "memory_item", id: CENTER_ID },
          kind: "related_to",
        },
        actor: { actorType: "user", actorId: "founder@example.com" },
        duplicateRows: [],
      }),
    ).toThrow(badRequest("Semantic edge cannot point to itself").message);
  });

  it("rejects source-row-only structural edge creation", () => {
    expect(() =>
      __companyBrainGraphTest.prepareSemanticEdgeCreate({
        companyId: COMPANY_ID,
        input: {
          from: { type: "agent", id: "agent-1" },
          to: { type: "task", id: "task-1" },
          kind: "assigned_to",
        },
        actor: { actorType: "user", actorId: "founder@example.com" },
        duplicateRows: [],
      }),
    ).toThrow(badRequest("Edge kind cannot be created manually").message);
  });

  it("rejects applies_to when it duplicates structural source rows", () => {
    expect(() =>
      __companyBrainGraphTest.prepareSemanticEdgeCreate({
        companyId: COMPANY_ID,
        input: {
          from: { type: "memory_item", id: CENTER_ID },
          to: { type: "task", id: "task-1" },
          kind: "applies_to",
        },
        actor: { actorType: "user", actorId: "founder@example.com" },
        duplicateRows: [],
      }),
    ).toThrow(badRequest("applies_to cannot target structural nodes manually").message);
  });
});

describe("semantic edge graph reads", () => {
  it("renders active company brain edges and drops archived edges", () => {
    const graph = buildMemoryItemNeighborGraph({
      companyId: COMPANY_ID,
      center: memory(),
      actor: founder,
      relatedItems: [memory({ id: RELATED_ID, title: "Seat billing" })],
      semanticEdges: [
        {
          id: "edge-active",
          fromType: "memory_item",
          fromId: CENTER_ID,
          toType: "memory_item",
          toId: RELATED_ID,
          kind: "supports",
          confidence: "0.9",
          evidence: "Human linked.",
          createdByPrincipalType: "user",
          createdByPrincipalId: "founder@example.com",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
        {
          id: "edge-archived",
          fromType: "memory_item",
          fromId: CENTER_ID,
          toType: "memory_item",
          toId: RELATED_ID,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "user",
          createdByPrincipalId: "founder@example.com",
          source: "manual",
          status: "archived",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      linked: {},
    });

    expect(graph.edges.map((edge) => edge.id)).toEqual(["edge-active"]);
    expect(graph.edges[0]).toMatchObject({
      kind: "supports",
      sourceClass: "semantic",
      editability: "editable",
      confidence: 0.9,
      evidence: "Human linked.",
    });
  });

  it("hides semantic edges when an endpoint is not visible", () => {
    const graph = buildMemoryItemNeighborGraph({
      companyId: COMPANY_ID,
      center: memory(),
      actor: member,
      relatedItems: [
        memory({ id: RELATED_ID, title: "Seat billing" }),
        memory({ id: PRIVATE_ID, title: "Private note", agentId: "agent-1" }),
      ],
      semanticEdges: [
        {
          id: "edge-visible",
          fromType: "memory_item",
          fromId: CENTER_ID,
          toType: "memory_item",
          toId: RELATED_ID,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "system",
          createdByPrincipalId: "system",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
        {
          id: "edge-private",
          fromType: "memory_item",
          fromId: CENTER_ID,
          toType: "memory_item",
          toId: PRIVATE_ID,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "system",
          createdByPrincipalId: "system",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      linked: {},
    });

    expect(graph.edges.map((edge) => edge.id)).toEqual(["edge-visible"]);
    expect(graph.nodes.map((node) => node.id)).not.toContain(PRIVATE_ID);
  });
});
