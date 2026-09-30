import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agentProjects,
  agents,
  artifacts,
  companyBrainEdges,
  companyMemberships,
  goals,
  issues,
  memoryFolders,
  memoryItems,
  memoryRelations,
  memoryRetrievals,
  projects,
  userRoles,
} from "@armyofagents/db";
import {
  COMPANY_BRAIN_EDGE_EDITABILITY_BY_KIND,
  COMPANY_BRAIN_EDITABLE_EDGE_KINDS,
  roleAtLeast,
  type CompanyBrainNodeType,
  type CompanyBrainEdge,
  type CompanyBrainEdgeKind,
  type CompanyBrainMemoryUsageResponse,
  type CompanyBrainNeighborsResponse,
  type CompanyBrainOverviewQuery,
  type CompanyBrainOverviewResponse,
  type CompanyBrainNode,
  type CompanyBrainNodeRef,
  type CreateCompanyBrainSemanticEdge,
  type UpdateCompanyBrainSemanticEdge,
} from "@armyofagents/shared";
import { badRequest, conflict, notFound } from "../errors.js";

export interface GraphActorScope {
  actorType: "user" | "agent";
  principalId: string;
  role: string;
  departmentIds: string[];
  activeCompanyMember: boolean;
}

export interface MemoryItemGraphRow {
  id: string;
  companyId: string;
  title: string;
  content?: string | null;
  status: string;
  category?: string | null;
  layer: string | null;
  visibility: string;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  taskId: string | null;
  sourceArtifactId: string | null;
  agentId: string | null;
  folderPath?: string | null;
  createdBy: string;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function memoryItemGraphSelectColumns() {
  return {
    id: memoryItems.id,
    companyId: memoryItems.companyId,
    title: memoryItems.title,
    content: memoryItems.content,
    status: memoryItems.status,
    category: memoryItems.category,
    layer: memoryItems.layer,
    visibility: memoryItems.visibility,
    departmentId: memoryItems.departmentId,
    projectId: memoryItems.projectId,
    goalId: memoryItems.goalId,
    taskId: memoryItems.taskId,
    sourceArtifactId: memoryItems.sourceArtifactId,
    agentId: memoryItems.agentId,
    folderPath: memoryItems.folderPath,
    createdBy: memoryItems.createdBy,
    createdAt: memoryItems.createdAt,
    updatedAt: memoryItems.updatedAt,
  };
}

function memoryItemGraphSelectColumnNames() {
  return Object.keys(memoryItemGraphSelectColumns());
}

export interface CompanyBrainSemanticEdgeGraphRow {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  kind: string;
  confidence?: string | number | null;
  evidence?: string | null;
  createdByPrincipalType: string;
  createdByPrincipalId: string;
  source: string;
  status: string;
  createdAt?: Date | string | null;
}

interface LinkedProjectRow {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface LinkedGoalRow {
  id: string;
  title: string;
  status: string;
}

interface LinkedTaskRow {
  id: string;
  title: string;
  status: string;
}

interface LinkedArtifactRow {
  id: string;
  title: string;
  status: string;
}

interface LinkedAgentRow {
  id: string;
  name: string;
  status: string;
}

interface LinkedMemoryFolderRow {
  id: string;
  displayName: string;
  path: string;
  departmentId: string | null;
  seedKey?: string | null;
  sortOrder?: number | null;
}

export interface MemoryItemNeighborGraphInput {
  companyId: string;
  center: MemoryItemGraphRow;
  actor: GraphActorScope;
  relatedItems: MemoryItemGraphRow[];
  semanticEdges: CompanyBrainSemanticEdgeGraphRow[];
  linked: {
    departments?: LinkedProjectRow[];
    projects?: LinkedProjectRow[];
    goals?: LinkedGoalRow[];
    tasks?: LinkedTaskRow[];
    artifacts?: LinkedArtifactRow[];
    agents?: LinkedAgentRow[];
    memoryFolders?: LinkedMemoryFolderRow[];
  };
}

export interface CompanyGraphOverviewInput {
  companyId: string;
  actor: GraphActorScope;
  memoryItems: MemoryItemGraphRow[];
  semanticEdges: CompanyBrainSemanticEdgeGraphRow[];
  linked: MemoryItemNeighborGraphInput["linked"];
  includeStructural: boolean;
  limit: number;
  kinds?: CompanyBrainEdgeKind[];
}

interface SemanticEdgeDuplicateRow {
  id: string;
  status: string;
}

interface PreparedSemanticEdgeInsert {
  companyId: string;
  fromType: CompanyBrainNodeType;
  fromId: string;
  toType: CompanyBrainNodeType;
  toId: string;
  kind: CompanyBrainEdgeKind;
  confidence: string | null;
  evidence: string | null;
  createdByPrincipalType: "agent" | "user" | "system";
  createdByPrincipalId: string;
  source: string;
  status: string;
  metadata: Record<string, unknown>;
}

interface MemoryUsageRow {
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  createdAt: Date | string | null;
}

function dateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function nodeKey(ref: CompanyBrainNodeRef): string {
  return `${ref.type}:${ref.id}`;
}

function edgeKey(edge: CompanyBrainEdge): string {
  return `${edge.kind}:${nodeKey(edge.from)}:${nodeKey(edge.to)}:${edge.id}`;
}

function isValidEdgeKind(kind: string): kind is CompanyBrainEdgeKind {
  return Object.prototype.hasOwnProperty.call(COMPANY_BRAIN_EDGE_EDITABILITY_BY_KIND, kind);
}

function isEditableEdgeKind(kind: string): kind is CompanyBrainEdgeKind {
  return (COMPANY_BRAIN_EDITABLE_EDGE_KINDS as readonly string[]).includes(kind);
}

function isBoardOperatorScope(actor: GraphActorScope): boolean {
  return actor.actorType === "user" && actor.principalId === "local-board";
}

function addNode(nodes: Map<string, CompanyBrainNode>, node: CompanyBrainNode): void {
  nodes.set(nodeKey(node), node);
}

function addEdge(edges: Map<string, CompanyBrainEdge>, edge: CompanyBrainEdge): void {
  edges.set(edgeKey(edge), edge);
}

function derivedEdge(input: {
  companyId: string;
  from: CompanyBrainNodeRef;
  to: CompanyBrainNodeRef;
  kind: CompanyBrainEdgeKind;
  id?: string;
  evidence?: string | null;
  metadata?: Record<string, unknown>;
}): CompanyBrainEdge {
  return {
    id: input.id ?? `derived:${nodeKey(input.from)}:${input.kind}:${nodeKey(input.to)}`,
    companyId: input.companyId,
    from: input.from,
    to: input.to,
    kind: input.kind,
    sourceClass: "derived",
    editability: COMPANY_BRAIN_EDGE_EDITABILITY_BY_KIND[input.kind],
    evidence: input.evidence ?? null,
    metadata: input.metadata,
  };
}

const STRUCTURAL_APPLIES_TO_TARGET_TYPES = new Set<CompanyBrainNodeType>([
  "department",
  "project",
  "goal",
  "task",
  "artifact",
  "agent",
  "memory_folder",
]);

function parseConfidence(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || Number.isNaN(numeric) || numeric < 0 || numeric > 1) {
    throw badRequest("confidence must be between 0 and 1");
  }
  return String(numeric);
}

function prepareSemanticEdgeCreate(input: {
  companyId: string;
  input: CreateCompanyBrainSemanticEdge | {
    from: CompanyBrainNodeRef;
    to: CompanyBrainNodeRef;
    kind: string;
    confidence?: number | null;
    evidence?: string | null;
    metadata?: Record<string, unknown>;
  };
  actor: { actorType: "agent" | "user" | "system"; actorId: string };
  duplicateRows: SemanticEdgeDuplicateRow[];
}): PreparedSemanticEdgeInsert {
  const kind = input.input.kind;
  if (!isEditableEdgeKind(kind)) {
    throw badRequest("Edge kind cannot be created manually");
  }
  if (
    input.input.from.type === input.input.to.type &&
    input.input.from.id === input.input.to.id
  ) {
    throw badRequest("Semantic edge cannot point to itself");
  }
  if (kind === "applies_to" && STRUCTURAL_APPLIES_TO_TARGET_TYPES.has(input.input.to.type)) {
    throw badRequest("applies_to cannot target structural nodes manually");
  }
  if (input.duplicateRows.some((row) => row.status === "active")) {
    throw conflict("Semantic edge already exists");
  }

  return {
    companyId: input.companyId,
    fromType: input.input.from.type,
    fromId: input.input.from.id,
    toType: input.input.to.type,
    toId: input.input.to.id,
    kind,
    confidence: parseConfidence(input.input.confidence),
    evidence: input.input.evidence ?? null,
    createdByPrincipalType: input.actor.actorType,
    createdByPrincipalId: input.actor.actorId,
    source: "manual",
    status: "active",
    metadata: input.input.metadata ?? {},
  };
}

function semanticEdgeToDto(
  companyId: string,
  edge: CompanyBrainSemanticEdgeGraphRow,
): CompanyBrainEdge | null {
  if (edge.status !== "active") return null;
  if (!isValidEdgeKind(edge.kind)) return null;
  return {
    id: edge.id,
    companyId,
    from: { type: edge.fromType as CompanyBrainNodeType, id: edge.fromId },
    to: { type: edge.toType as CompanyBrainNodeType, id: edge.toId },
    kind: edge.kind,
    sourceClass: "semantic",
    editability: COMPANY_BRAIN_EDGE_EDITABILITY_BY_KIND[edge.kind],
    confidence: edge.confidence === null || edge.confidence === undefined
      ? null
      : Number(edge.confidence),
    evidence: edge.evidence ?? null,
    createdBy: edge.createdByPrincipalId,
    createdAt: dateToIso(edge.createdAt),
    metadata: {
      createdByPrincipalType: edge.createdByPrincipalType,
      source: edge.source,
    },
  };
}

export function canSeeMemoryItemForGraph(
  item: MemoryItemGraphRow,
  actor: GraphActorScope,
): boolean {
  if (!actor.activeCompanyMember) return false;
  if (item.status === "archived" || item.status === "rejected") return false;

  const privileged = roleAtLeast(actor.role, "team_lead");
  if (privileged) return true;

  if (item.agentId) {
    return actor.actorType === "agent" && actor.principalId === item.agentId;
  }

  const isCompanyWideIdentity =
    item.layer === "identity" &&
    item.visibility === "shared" &&
    !item.departmentId &&
    !item.projectId &&
    !item.goalId &&
    !item.taskId;
  if (isCompanyWideIdentity) return true;

  if (item.visibility === "shared") return true;

  if (item.departmentId) {
    return actor.departmentIds.includes(item.departmentId);
  }
  if (item.projectId) {
    return actor.departmentIds.includes(item.projectId);
  }

  return false;
}

function memoryNode(item: MemoryItemGraphRow): CompanyBrainNode {
  const isCompanyWide =
    item.layer === "identity" &&
    item.visibility === "shared" &&
    !item.departmentId &&
    !item.projectId &&
    !item.goalId &&
    !item.taskId;

  return {
    type: "memory_item",
    id: item.id,
    companyId: item.companyId,
    label: item.title,
    subtitle: item.category ?? item.layer ?? null,
    status: item.status,
    scope: {
      departmentId: item.departmentId,
      projectId: item.projectId,
      goalId: item.goalId,
      visibility: item.visibility,
      isCompanyWide,
    },
    href: `/memory/explore?item=${item.id}`,
    metadata: {
      layer: item.layer,
      folderPath: item.folderPath ?? "",
      createdBy: item.createdBy,
      createdAt: dateToIso(item.createdAt),
      updatedAt: dateToIso(item.updatedAt),
    },
  };
}

function canSeeStructuralDepartment(departmentId: string, actor: GraphActorScope): boolean {
  if (!actor.activeCompanyMember) return false;
  if (isBoardOperatorScope(actor)) return true;
  if (roleAtLeast(actor.role, "team_lead")) return true;
  return actor.departmentIds.includes(departmentId);
}

function canSeeMemoryFolderForGraph(
  folder: LinkedMemoryFolderRow,
  actor: GraphActorScope,
): boolean {
  if (!actor.activeCompanyMember) return false;
  if (!folder.departmentId) return true;
  return canSeeStructuralDepartment(folder.departmentId, actor);
}

function departmentNode(
  companyId: string,
  department: LinkedProjectRow,
): CompanyBrainNode {
  return {
    type: "department",
    id: department.id,
    companyId,
    label: department.name,
    status: department.status,
    scope: { departmentId: department.id, isCompanyWide: false },
    href: `/memory/explore?dept=${department.id}`,
    metadata: { projectType: department.type },
  };
}

function memoryFolderNode(
  companyId: string,
  folder: LinkedMemoryFolderRow,
): CompanyBrainNode {
  return {
    type: "memory_folder",
    id: folder.id,
    companyId,
    label: folder.displayName,
    scope: {
      departmentId: folder.departmentId,
      isCompanyWide: !folder.departmentId,
      visibility: "shared",
    },
    href: `/memory/explore?folder=${encodeURIComponent(folder.path)}`,
    metadata: {
      path: folder.path,
      seedKey: folder.seedKey ?? null,
      sortOrder: folder.sortOrder ?? 0,
      layer: folder.departmentId ? "domain" : "identity",
    },
  };
}

function memoryFolderMapKey(folder: Pick<LinkedMemoryFolderRow, "departmentId" | "path">): string {
  return `${folder.departmentId ?? "company"}:${folder.path}`;
}

export function buildMemoryItemNeighborGraph(
  input: MemoryItemNeighborGraphInput,
): CompanyBrainNeighborsResponse {
  if (!canSeeMemoryItemForGraph(input.center, input.actor)) {
    throw notFound("Memory item not found");
  }

  const nodes = new Map<string, CompanyBrainNode>();
  const edges = new Map<string, CompanyBrainEdge>();
  const center = memoryNode(input.center);
  const centerRef: CompanyBrainNodeRef = { type: "memory_item", id: input.center.id };
  addNode(nodes, center);

  const visibleItems = new Map<string, MemoryItemGraphRow>([[input.center.id, input.center]]);
  for (const item of input.relatedItems) {
    if (canSeeMemoryItemForGraph(item, input.actor)) {
      visibleItems.set(item.id, item);
      addNode(nodes, memoryNode(item));
    }
  }

  for (const department of input.linked.departments ?? []) {
    const ref: CompanyBrainNodeRef = { type: "department", id: department.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: department.name,
      status: department.status,
      scope: { departmentId: department.id, isCompanyWide: false },
      href: `/memory/explore?dept=${department.id}`,
      metadata: { projectType: department.type },
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "belongs_to",
    }));
  }

  for (const project of input.linked.projects ?? []) {
    const ref: CompanyBrainNodeRef = { type: "project", id: project.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: project.name,
      status: project.status,
      scope: { projectId: project.id, isCompanyWide: false },
      href: `/projects/${project.id}`,
      metadata: { projectType: project.type },
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "belongs_to",
    }));
  }

  for (const goal of input.linked.goals ?? []) {
    const ref: CompanyBrainNodeRef = { type: "goal", id: goal.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: goal.title,
      status: goal.status,
      scope: { goalId: goal.id, isCompanyWide: false },
      href: `/goals/${goal.id}`,
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "applies_to",
    }));
  }

  for (const task of input.linked.tasks ?? []) {
    const ref: CompanyBrainNodeRef = { type: "task", id: task.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: task.title,
      status: task.status,
      scope: { isCompanyWide: false },
      href: `/issues/${task.id}`,
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "applies_to",
    }));
  }

  for (const artifact of input.linked.artifacts ?? []) {
    const ref: CompanyBrainNodeRef = { type: "artifact", id: artifact.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: artifact.title,
      status: artifact.status,
      href: `/artifacts/${artifact.id}`,
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "derived_from",
    }));
  }

  for (const agent of input.linked.agents ?? []) {
    const ref: CompanyBrainNodeRef = { type: "agent", id: agent.id };
    addNode(nodes, {
      ...ref,
      companyId: input.companyId,
      label: agent.name,
      status: agent.status,
      href: `/agents/${agent.id}`,
    });
    addEdge(edges, derivedEdge({
      companyId: input.companyId,
      from: centerRef,
      to: ref,
      kind: "created_by",
    }));
  }

  for (const edge of input.semanticEdges) {
    const fromVisible =
      edge.fromType === "memory_item" ? visibleItems.has(edge.fromId) : nodes.has(`${edge.fromType}:${edge.fromId}`);
    const toVisible =
      edge.toType === "memory_item" ? visibleItems.has(edge.toId) : nodes.has(`${edge.toType}:${edge.toId}`);
    if (!fromVisible || !toVisible) continue;

    const dto = semanticEdgeToDto(input.companyId, edge);
    if (dto) addEdge(edges, dto);
  }

  return {
    center,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}

export function buildCompanyGraphOverview(
  input: CompanyGraphOverviewInput,
): CompanyBrainOverviewResponse {
  const visibleItems = input.memoryItems.filter(
    (item) => item.status === "approved" && canSeeMemoryItemForGraph(item, input.actor),
  );
  const boundedItems = visibleItems.slice(0, input.limit);
  const visibleItemIds = new Set(boundedItems.map((item) => item.id));
  const nodes = new Map<string, CompanyBrainNode>();
  const edges = new Map<string, CompanyBrainEdge>();
  const kinds = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;

  for (const item of boundedItems) {
    addNode(nodes, memoryNode(item));
  }

  if (input.includeStructural) {
    const departments = new Map((input.linked.departments ?? []).map((row) => [row.id, row]));
    const projectsById = new Map((input.linked.projects ?? []).map((row) => [row.id, row]));
    const goalsById = new Map((input.linked.goals ?? []).map((row) => [row.id, row]));
    const tasksById = new Map((input.linked.tasks ?? []).map((row) => [row.id, row]));
    const artifactsById = new Map((input.linked.artifacts ?? []).map((row) => [row.id, row]));
    const agentsById = new Map((input.linked.agents ?? []).map((row) => [row.id, row]));
    const visibleFolders = (input.linked.memoryFolders ?? [])
      .filter((folder) => canSeeMemoryFolderForGraph(folder, input.actor));
    const foldersByPath = new Map(visibleFolders.map((folder) => [memoryFolderMapKey(folder), folder]));

    for (const department of departments.values()) {
      if (!canSeeStructuralDepartment(department.id, input.actor)) continue;
      addNode(nodes, departmentNode(input.companyId, department));
    }

    for (const folder of visibleFolders) {
      addNode(nodes, memoryFolderNode(input.companyId, folder));
    }

    for (const folder of visibleFolders) {
      const folderRef: CompanyBrainNodeRef = { type: "memory_folder", id: folder.id };
      const parentPath = folder.path.includes("/")
        ? folder.path.slice(0, folder.path.lastIndexOf("/"))
        : "";
      const parentFolder = parentPath
        ? foldersByPath.get(memoryFolderMapKey({ departmentId: folder.departmentId, path: parentPath }))
        : null;

      if (parentFolder) {
        addEdge(edges, derivedEdge({
          companyId: input.companyId,
          from: folderRef,
          to: { type: "memory_folder", id: parentFolder.id },
          kind: "belongs_to",
        }));
      } else if (folder.departmentId && departments.has(folder.departmentId)) {
        addEdge(edges, derivedEdge({
          companyId: input.companyId,
          from: folderRef,
          to: { type: "department", id: folder.departmentId },
          kind: "belongs_to",
        }));
      }
    }

    for (const item of boundedItems) {
      const itemRef: CompanyBrainNodeRef = { type: "memory_item", id: item.id };

      if (item.departmentId) {
        const department = departments.get(item.departmentId);
        if (department) {
          const ref: CompanyBrainNodeRef = { type: "department", id: department.id };
          addNode(nodes, departmentNode(input.companyId, department));
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "belongs_to" }));
        }
      }

      if (item.folderPath) {
        const folder = foldersByPath.get(memoryFolderMapKey({
          departmentId: item.departmentId,
          path: item.folderPath,
        })) ?? foldersByPath.get(memoryFolderMapKey({
          departmentId: null,
          path: item.folderPath,
        }));
        if (folder) {
          addEdge(edges, derivedEdge({
            companyId: input.companyId,
            from: itemRef,
            to: { type: "memory_folder", id: folder.id },
            kind: "belongs_to",
          }));
        }
      }

      if (item.projectId) {
        const project = projectsById.get(item.projectId);
        if (project) {
          const ref: CompanyBrainNodeRef = { type: "project", id: project.id };
          addNode(nodes, {
            ...ref,
            companyId: input.companyId,
            label: project.name,
            status: project.status,
            scope: { projectId: project.id, isCompanyWide: false },
            href: `/projects/${project.id}`,
            metadata: { projectType: project.type },
          });
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "belongs_to" }));
        }
      }

      if (item.goalId) {
        const goal = goalsById.get(item.goalId);
        if (goal) {
          const ref: CompanyBrainNodeRef = { type: "goal", id: goal.id };
          addNode(nodes, {
            ...ref,
            companyId: input.companyId,
            label: goal.title,
            status: goal.status,
            scope: { goalId: goal.id, isCompanyWide: false },
            href: `/goals/${goal.id}`,
          });
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "applies_to" }));
        }
      }

      if (item.taskId) {
        const task = tasksById.get(item.taskId);
        if (task) {
          const ref: CompanyBrainNodeRef = { type: "task", id: task.id };
          addNode(nodes, {
            ...ref,
            companyId: input.companyId,
            label: task.title,
            status: task.status,
            scope: { isCompanyWide: false },
            href: `/issues/${task.id}`,
          });
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "applies_to" }));
        }
      }

      if (item.sourceArtifactId) {
        const artifact = artifactsById.get(item.sourceArtifactId);
        if (artifact) {
          const ref: CompanyBrainNodeRef = { type: "artifact", id: artifact.id };
          addNode(nodes, {
            ...ref,
            companyId: input.companyId,
            label: artifact.title,
            status: artifact.status,
            href: `/artifacts/${artifact.id}`,
          });
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "derived_from" }));
        }
      }

      if (item.agentId) {
        const agent = agentsById.get(item.agentId);
        if (agent) {
          const ref: CompanyBrainNodeRef = { type: "agent", id: agent.id };
          addNode(nodes, {
            ...ref,
            companyId: input.companyId,
            label: agent.name,
            status: agent.status,
            href: `/agents/${agent.id}`,
          });
          addEdge(edges, derivedEdge({ companyId: input.companyId, from: itemRef, to: ref, kind: "created_by" }));
        }
      }
    }
  }

  for (const edge of input.semanticEdges) {
    if (kinds && !kinds.has(edge.kind as CompanyBrainEdgeKind)) continue;
    if (edge.fromType !== "memory_item" || edge.toType !== "memory_item") continue;
    if (!visibleItemIds.has(edge.fromId) || !visibleItemIds.has(edge.toId)) continue;

    const dto = semanticEdgeToDto(input.companyId, edge);
    if (dto) addEdge(edges, dto);
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    limit: input.limit,
    truncated: visibleItems.length > input.limit,
  };
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

function aggregateMemoryUsage(
  itemId: string,
  rows: MemoryUsageRow[],
): CompanyBrainMemoryUsageResponse {
  const agentsById = new Map<string, {
    agentId: string | null;
    agentName: string;
    retrievalCount: number;
    lastRetrievedAt: string | null;
    taskIds: Set<string>;
  }>();

  for (const row of rows) {
    const key = row.agentId ?? "__unknown_agent__";
    const existing = agentsById.get(key) ?? {
      agentId: row.agentId,
      agentName: row.agentName ?? "Unknown agent",
      retrievalCount: 0,
      lastRetrievedAt: null,
      taskIds: new Set<string>(),
    };

    existing.retrievalCount += 1;
    if (row.taskId) existing.taskIds.add(row.taskId);

    const createdAt = dateToIso(row.createdAt);
    if (createdAt && (!existing.lastRetrievedAt || createdAt > existing.lastRetrievedAt)) {
      existing.lastRetrievedAt = createdAt;
    }
    agentsById.set(key, existing);
  }

  return {
    itemId,
    agents: Array.from(agentsById.values())
      .map((agent) => ({
        agentId: agent.agentId,
        agentName: agent.agentName,
        retrievalCount: agent.retrievalCount,
        lastRetrievedAt: agent.lastRetrievedAt,
        linkedTaskCount: agent.taskIds.size,
      }))
      .sort((a, b) => {
        if (a.retrievalCount !== b.retrievalCount) return b.retrievalCount - a.retrievalCount;
        return a.agentName.localeCompare(b.agentName);
      }),
  };
}

async function loadActorScope(
  db: Db,
  companyId: string,
  actor: { type: "user" | "agent"; principalId: string },
): Promise<GraphActorScope> {
  if (actor.type === "agent") {
    const membership = await db
      .select({ id: agents.id, role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, actor.principalId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    const departmentRows = await db
      .select({ projectId: agentProjects.projectId })
      .from(agentProjects)
      .where(and(eq(agentProjects.companyId, companyId), eq(agentProjects.agentId, actor.principalId)));

    return {
      actorType: "agent",
      principalId: actor.principalId,
      role: membership?.role ?? "team_member",
      departmentIds: departmentRows.map((row) => row.projectId),
      activeCompanyMember: Boolean(membership),
    };
  }

  const membership = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.principalId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  const roleRows = await db
    .select({ role: userRoles.role, projectId: userRoles.projectId })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, actor.principalId)));

  const companyRole = roleRows.find((row) => row.projectId === null)?.role ?? "team_member";

  return {
    actorType: "user",
    principalId: actor.principalId,
    role: companyRole,
    departmentIds: uniqueIds(roleRows.map((row) => row.projectId)),
    activeCompanyMember: Boolean(membership),
  };
}

function semanticEdgeEndpointItemIds(edges: CompanyBrainSemanticEdgeGraphRow[]): string[] {
  return uniqueIds(
    edges.flatMap((edge) => [
      edge.fromType === "memory_item" ? edge.fromId : null,
      edge.toType === "memory_item" ? edge.toId : null,
    ]),
  );
}

async function assertVisibleMemoryEndpoints(
  db: Db,
  companyId: string,
  refs: CompanyBrainNodeRef[],
  scope: GraphActorScope,
): Promise<void> {
  const itemIds = uniqueIds(refs.map((ref) => ref.type === "memory_item" ? ref.id : null));
  if (itemIds.length === 0) return;

  const rows = await db
    .select(memoryItemGraphSelectColumns())
    .from(memoryItems)
    .where(and(eq(memoryItems.companyId, companyId), inArray(memoryItems.id, itemIds)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const itemId of itemIds) {
    const row = byId.get(itemId);
    if (!row || !canSeeMemoryItemForGraph(row, scope)) {
      throw notFound("Memory item not found");
    }
  }
}

async function backfillLegacyMemoryRelationsForItem(
  db: Db,
  companyId: string,
  memoryItemId: string,
): Promise<void> {
  const legacyRows = await db
    .select({
      id: memoryRelations.id,
      fromItemId: memoryRelations.fromItemId,
      toItemId: memoryRelations.toItemId,
      kind: memoryRelations.kind,
      createdBy: memoryRelations.createdBy,
      createdAt: memoryRelations.createdAt,
    })
    .from(memoryRelations)
    .where(
      and(
        eq(memoryRelations.companyId, companyId),
        or(eq(memoryRelations.fromItemId, memoryItemId), eq(memoryRelations.toItemId, memoryItemId))!,
      ),
    );

  for (const row of legacyRows) {
    if (!isEditableEdgeKind(row.kind)) continue;
    const existing = await db
      .select({ id: companyBrainEdges.id, status: companyBrainEdges.status })
      .from(companyBrainEdges)
      .where(
        and(
          eq(companyBrainEdges.companyId, companyId),
          eq(companyBrainEdges.fromType, "memory_item"),
          eq(companyBrainEdges.fromId, row.fromItemId),
          eq(companyBrainEdges.toType, "memory_item"),
          eq(companyBrainEdges.toId, row.toItemId),
          eq(companyBrainEdges.kind, row.kind),
          eq(companyBrainEdges.status, "active"),
        ),
      );
    if (existing.length > 0) continue;

    await db.insert(companyBrainEdges).values({
      companyId,
      fromType: "memory_item",
      fromId: row.fromItemId,
      toType: "memory_item",
      toId: row.toItemId,
      kind: row.kind,
      confidence: null,
      evidence: null,
      createdByPrincipalType: "system",
      createdByPrincipalId: row.createdBy || "legacy_memory_relations",
      source: "legacy_memory_relations",
      status: "active",
      metadata: { legacyRelationId: row.id },
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
  }
}

export function companyBrainGraphService(db: Db) {
  return {
    loadActorScope: (
      companyId: string,
      actor: { type: "user" | "agent"; principalId: string },
    ) => loadActorScope(db, companyId, actor),

    getCompanyGraphOverview: async (
      companyId: string,
      actor: { type: "user" | "agent"; principalId: string },
      options: CompanyBrainOverviewQuery,
    ) => {
      const scope = await loadActorScope(db, companyId, actor);
      const sampledItems = await db
        .select(memoryItemGraphSelectColumns())
        .from(memoryItems)
        .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.status, "approved")))
        .limit(options.limit + 1);
      const visibleItems = sampledItems.filter((item) => canSeeMemoryItemForGraph(item, scope));
      const boundedVisibleItems = visibleItems.slice(0, options.limit);
      const visibleMemoryIds = boundedVisibleItems.map((item) => item.id);

      const semanticEdges = visibleMemoryIds.length > 0
        ? await db
            .select({
              id: companyBrainEdges.id,
              fromType: companyBrainEdges.fromType,
              fromId: companyBrainEdges.fromId,
              toType: companyBrainEdges.toType,
              toId: companyBrainEdges.toId,
              kind: companyBrainEdges.kind,
              confidence: companyBrainEdges.confidence,
              evidence: companyBrainEdges.evidence,
              createdByPrincipalType: companyBrainEdges.createdByPrincipalType,
              createdByPrincipalId: companyBrainEdges.createdByPrincipalId,
              source: companyBrainEdges.source,
              status: companyBrainEdges.status,
              createdAt: companyBrainEdges.createdAt,
            })
            .from(companyBrainEdges)
            .where(
              and(
                eq(companyBrainEdges.companyId, companyId),
                eq(companyBrainEdges.status, "active"),
                or(
                  and(
                    eq(companyBrainEdges.fromType, "memory_item"),
                    inArray(companyBrainEdges.fromId, visibleMemoryIds),
                  ),
                  and(
                    eq(companyBrainEdges.toType, "memory_item"),
                    inArray(companyBrainEdges.toId, visibleMemoryIds),
                  ),
                )!,
              ),
            )
        : [];

      const departmentIds = uniqueIds(boundedVisibleItems.map((item) => item.departmentId));
      const projectIds = uniqueIds(boundedVisibleItems.map((item) => item.projectId));
      const goalIds = uniqueIds(boundedVisibleItems.map((item) => item.goalId));
      const taskIds = uniqueIds(boundedVisibleItems.map((item) => item.taskId));
      const artifactIds = uniqueIds(boundedVisibleItems.map((item) => item.sourceArtifactId));
      const agentIds = uniqueIds(boundedVisibleItems.map((item) => item.agentId));

      const [
        departmentRows,
        projectRows,
        goalRows,
        taskRows,
        artifactRows,
        agentRows,
        memoryFolderRows,
      ] = options.includeStructural
        ? await Promise.all([
            db.select({
                  id: projects.id,
                  name: projects.name,
                  type: projects.type,
                  status: projects.status,
                }).from(projects).where(and(
                  eq(projects.companyId, companyId),
                  eq(projects.type, "department"),
                )),
            projectIds.length
              ? db.select({
                  id: projects.id,
                  name: projects.name,
                  type: projects.type,
                  status: projects.status,
                }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
              : Promise.resolve([]),
            goalIds.length
              ? db.select({
                  id: goals.id,
                  title: goals.title,
                  status: goals.status,
                }).from(goals).where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds)))
              : Promise.resolve([]),
            taskIds.length
              ? db.select({
                  id: issues.id,
                  title: issues.title,
                  status: issues.status,
                }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, taskIds)))
              : Promise.resolve([]),
            artifactIds.length
              ? db.select({
                  id: artifacts.id,
                  title: artifacts.title,
                  status: artifacts.status,
                }).from(artifacts).where(and(eq(artifacts.companyId, companyId), inArray(artifacts.id, artifactIds)))
              : Promise.resolve([]),
            agentIds.length
              ? db.select({
                  id: agents.id,
                  name: agents.name,
                  status: agents.status,
                }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
              : Promise.resolve([]),
            db.select({
              id: memoryFolders.id,
              displayName: memoryFolders.displayName,
              path: memoryFolders.path,
              departmentId: memoryFolders.departmentId,
              seedKey: memoryFolders.seedKey,
              sortOrder: memoryFolders.sortOrder,
            }).from(memoryFolders).where(eq(memoryFolders.companyId, companyId)),
          ])
        : [[], [], [], [], [], [], []];

      return buildCompanyGraphOverview({
        companyId,
        actor: scope,
        memoryItems: visibleItems,
        semanticEdges,
        linked: {
          departments: departmentRows,
          projects: projectRows,
          goals: goalRows,
          tasks: taskRows,
          artifacts: artifactRows,
          agents: agentRows,
          memoryFolders: memoryFolderRows,
        },
        includeStructural: options.includeStructural,
        limit: options.limit,
        kinds: options.kinds,
      });
    },

    getMemoryItemNeighbors: async (
      companyId: string,
      memoryItemId: string,
      actor: { type: "user" | "agent"; principalId: string },
    ) => {
      const scope = await loadActorScope(db, companyId, actor);
      const center = await db
        .select(memoryItemGraphSelectColumns())
        .from(memoryItems)
        .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, memoryItemId)))
        .then((rows) => rows[0] ?? null);
      if (!center) throw notFound("Memory item not found");
      await backfillLegacyMemoryRelationsForItem(db, companyId, memoryItemId);

      const semanticEdges = await db
        .select({
          id: companyBrainEdges.id,
          fromType: companyBrainEdges.fromType,
          fromId: companyBrainEdges.fromId,
          toType: companyBrainEdges.toType,
          toId: companyBrainEdges.toId,
          kind: companyBrainEdges.kind,
          confidence: companyBrainEdges.confidence,
          evidence: companyBrainEdges.evidence,
          createdByPrincipalType: companyBrainEdges.createdByPrincipalType,
          createdByPrincipalId: companyBrainEdges.createdByPrincipalId,
          source: companyBrainEdges.source,
          status: companyBrainEdges.status,
          createdAt: companyBrainEdges.createdAt,
        })
        .from(companyBrainEdges)
        .where(
          and(
            eq(companyBrainEdges.companyId, companyId),
            eq(companyBrainEdges.status, "active"),
            or(
              and(eq(companyBrainEdges.fromType, "memory_item"), eq(companyBrainEdges.fromId, memoryItemId)),
              and(eq(companyBrainEdges.toType, "memory_item"), eq(companyBrainEdges.toId, memoryItemId)),
            )!,
          ),
        );

      const relatedItemIds = uniqueIds(
        semanticEdgeEndpointItemIds(semanticEdges).filter((id) => id !== memoryItemId),
      );

      const relatedItems = relatedItemIds.length > 0
        ? await db
            .select(memoryItemGraphSelectColumns())
            .from(memoryItems)
            .where(and(eq(memoryItems.companyId, companyId), inArray(memoryItems.id, relatedItemIds)))
        : [];

      const departmentIds = uniqueIds([center.departmentId]);
      const projectIds = uniqueIds([center.projectId]);
      const goalIds = uniqueIds([center.goalId]);
      const taskIds = uniqueIds([center.taskId]);
      const artifactIds = uniqueIds([center.sourceArtifactId]);
      const agentIds = uniqueIds([center.agentId]);

      const [
        departmentRows,
        projectRows,
        goalRows,
        taskRows,
        artifactRows,
        agentRows,
      ] = await Promise.all([
        departmentIds.length
          ? db.select({
              id: projects.id,
              name: projects.name,
              type: projects.type,
              status: projects.status,
            }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, departmentIds)))
          : Promise.resolve([]),
        projectIds.length
          ? db.select({
              id: projects.id,
              name: projects.name,
              type: projects.type,
              status: projects.status,
            }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
          : Promise.resolve([]),
        goalIds.length
          ? db.select({
              id: goals.id,
              title: goals.title,
              status: goals.status,
            }).from(goals).where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds)))
          : Promise.resolve([]),
        taskIds.length
          ? db.select({
              id: issues.id,
              title: issues.title,
              status: issues.status,
            }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, taskIds)))
          : Promise.resolve([]),
        artifactIds.length
          ? db.select({
              id: artifacts.id,
              title: artifacts.title,
              status: artifacts.status,
            }).from(artifacts).where(and(eq(artifacts.companyId, companyId), inArray(artifacts.id, artifactIds)))
          : Promise.resolve([]),
        agentIds.length
          ? db.select({
              id: agents.id,
              name: agents.name,
              status: agents.status,
            }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
          : Promise.resolve([]),
      ]);

      return buildMemoryItemNeighborGraph({
        companyId,
        center,
        actor: scope,
        relatedItems,
        semanticEdges,
        linked: {
          departments: departmentRows,
          projects: projectRows,
          goals: goalRows,
          tasks: taskRows,
          artifacts: artifactRows,
          agents: agentRows,
        },
      });
    },

    getMemoryItemUsage: async (
      companyId: string,
      memoryItemId: string,
      actor: { type: "user" | "agent"; principalId: string },
    ) => {
      const scope = await loadActorScope(db, companyId, actor);
      const center = await db
        .select(memoryItemGraphSelectColumns())
        .from(memoryItems)
        .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, memoryItemId)))
        .then((rows) => rows[0] ?? null);
      if (!center || !canSeeMemoryItemForGraph(center, scope)) {
        throw notFound("Memory item not found");
      }

      const rows = await db
        .select({
          agentId: memoryRetrievals.agentId,
          agentName: agents.name,
          taskId: memoryRetrievals.taskId,
          createdAt: memoryRetrievals.createdAt,
        })
        .from(memoryRetrievals)
        .leftJoin(agents, eq(memoryRetrievals.agentId, agents.id))
        .where(
          and(
            eq(memoryRetrievals.companyId, companyId),
            eq(memoryRetrievals.itemId, memoryItemId),
            eq(memoryRetrievals.shownToAgent, true),
          ),
        );

      return aggregateMemoryUsage(memoryItemId, rows);
    },

    createSemanticEdge: async (
      companyId: string,
      input: CreateCompanyBrainSemanticEdge,
      actor: { type: "user" | "agent"; principalId: string },
    ) => {
      const scope = await loadActorScope(db, companyId, actor);
      await assertVisibleMemoryEndpoints(db, companyId, [input.from, input.to], scope);
      const duplicates = await db
        .select({ id: companyBrainEdges.id, status: companyBrainEdges.status })
        .from(companyBrainEdges)
        .where(
          and(
            eq(companyBrainEdges.companyId, companyId),
            eq(companyBrainEdges.fromType, input.from.type),
            eq(companyBrainEdges.fromId, input.from.id),
            eq(companyBrainEdges.toType, input.to.type),
            eq(companyBrainEdges.toId, input.to.id),
            eq(companyBrainEdges.kind, input.kind),
            eq(companyBrainEdges.status, "active"),
          ),
        );
      const prepared = prepareSemanticEdgeCreate({
        companyId,
        input,
        actor: {
          actorType: actor.type,
          actorId: actor.principalId,
        },
        duplicateRows: duplicates,
      });
      const [edge] = await db.insert(companyBrainEdges).values(prepared).returning();
      return edge;
    },

    updateSemanticEdge: async (
      companyId: string,
      edgeId: string,
      input: UpdateCompanyBrainSemanticEdge,
    ) => {
      const existing = await db
        .select()
        .from(companyBrainEdges)
        .where(and(eq(companyBrainEdges.companyId, companyId), eq(companyBrainEdges.id, edgeId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status !== "active") throw notFound("Semantic edge not found");
      if (input.kind && !isEditableEdgeKind(input.kind)) {
        throw badRequest("Edge kind cannot be created manually");
      }
      if (input.kind === "applies_to" && STRUCTURAL_APPLIES_TO_TARGET_TYPES.has(existing.toType as CompanyBrainNodeType)) {
        throw badRequest("applies_to cannot target structural nodes manually");
      }
      const [edge] = await db
        .update(companyBrainEdges)
        .set({
          kind: input.kind ?? existing.kind,
          confidence: input.confidence === undefined ? existing.confidence : parseConfidence(input.confidence),
          evidence: input.evidence === undefined ? existing.evidence : input.evidence,
          metadata: input.metadata === undefined ? existing.metadata : input.metadata,
          updatedAt: new Date(),
        })
        .where(and(eq(companyBrainEdges.companyId, companyId), eq(companyBrainEdges.id, edgeId)))
        .returning();
      return edge;
    },

    archiveSemanticEdge: async (
      companyId: string,
      edgeId: string,
    ) => {
      const [edge] = await db
        .update(companyBrainEdges)
        .set({
          status: "archived",
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(companyBrainEdges.companyId, companyId), eq(companyBrainEdges.id, edgeId)))
        .returning();
      if (!edge) throw notFound("Semantic edge not found");
      return edge;
    },
  };
}

export const __companyBrainGraphTest = {
  aggregateMemoryUsage,
  memoryItemGraphSelectColumnNames,
  prepareSemanticEdgeCreate,
};
