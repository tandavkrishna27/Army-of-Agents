import type {
  CompanyBrainEdgeKind,
  CompanyBrainNeighborsResponse,
  CompanyBrainNode,
} from "@armyofagents/shared";

export interface GraphExpandableMemoryItem {
  id: string;
  companyId: string;
  title: string;
  status?: string | null;
}

export interface GraphRetrievalContextItem {
  itemId: string;
  title: string;
  sourceItemId: string;
  sourceTitle: string;
  edgeKind: CompanyBrainEdgeKind;
  why: string;
}

export interface ExpandRetrievalWithCompanyGraphInput<
  TSeed extends GraphExpandableMemoryItem,
  TGraphItem extends GraphExpandableMemoryItem,
> {
  companyId: string;
  seeds: TSeed[];
  maxGraphItems?: number;
  maxCandidateItems?: number;
  loadNeighbors: (memoryItemId: string) => Promise<CompanyBrainNeighborsResponse>;
  loadMemoryItem: (memoryItemId: string) => Promise<TGraphItem | null>;
  filterMemoryItems: (items: TGraphItem[]) => Promise<TGraphItem[]>;
}

export interface ExpandedGraphRetrieval<TSeed extends GraphExpandableMemoryItem> {
  items: TSeed[];
  graphContext: GraphRetrievalContextItem[];
}

const DEFAULT_MAX_GRAPH_ITEMS = 6;
const MAX_CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATE_CEILING = 50;

const USEFUL_RETRIEVAL_EDGE_KINDS = new Set<CompanyBrainEdgeKind>([
  "applies_to",
  "supports",
  "related_to",
  "supersedes",
  "extracted_from",
  "belongs_to",
]);

function memoryNodeById(
  graph: CompanyBrainNeighborsResponse,
): Map<string, CompanyBrainNode> {
  return new Map(
    graph.nodes
      .filter((node) => node.type === "memory_item")
      .map((node) => [node.id, node]),
  );
}

function compactWhy(edgeKind: CompanyBrainEdgeKind, sourceTitle: string): string {
  return `${edgeKind} ${sourceTitle}`;
}

export async function expandRetrievalWithCompanyGraph<
  TSeed extends GraphExpandableMemoryItem,
  TGraphItem extends GraphExpandableMemoryItem,
>(
  input: ExpandRetrievalWithCompanyGraphInput<TSeed, TGraphItem>,
): Promise<ExpandedGraphRetrieval<TSeed>> {
  if (input.seeds.length === 0) {
    return { items: input.seeds, graphContext: [] };
  }

  const maxGraphItems = Math.max(0, input.maxGraphItems ?? DEFAULT_MAX_GRAPH_ITEMS);
  if (maxGraphItems === 0) {
    return { items: input.seeds, graphContext: [] };
  }
  const requestedMaxCandidateItems =
    input.maxCandidateItems ?? maxGraphItems * MAX_CANDIDATE_MULTIPLIER;
  const maxCandidateItems = Math.max(
    maxGraphItems,
    Math.min(requestedMaxCandidateItems, MAX_CANDIDATE_CEILING),
  );

  const seedById = new Map(input.seeds.map((item) => [item.id, item]));
  const candidateById = new Map<
    string,
    {
      itemId: string;
      sourceItemId: string;
      sourceTitle: string;
      edgeKind: CompanyBrainEdgeKind;
      why: string;
    }
  >();

  for (const seed of input.seeds) {
    if (candidateById.size >= maxCandidateItems) break;
    let graph: CompanyBrainNeighborsResponse;
    try {
      graph = await input.loadNeighbors(seed.id);
    } catch {
      continue;
    }
    const nodes = memoryNodeById(graph);
    for (const edge of graph.edges) {
      if (candidateById.size >= maxCandidateItems) break;
      if (!USEFUL_RETRIEVAL_EDGE_KINDS.has(edge.kind)) continue;

      const fromSeed = edge.from.type === "memory_item" && edge.from.id === seed.id;
      const toSeed = edge.to.type === "memory_item" && edge.to.id === seed.id;
      if (!fromSeed && !toSeed) continue;

      const neighborRef = fromSeed ? edge.to : edge.from;
      if (neighborRef.type !== "memory_item") continue;
      if (seedById.has(neighborRef.id)) continue;
      if (candidateById.has(neighborRef.id)) continue;
      if (!nodes.has(neighborRef.id)) continue;

      candidateById.set(neighborRef.id, {
        itemId: neighborRef.id,
        sourceItemId: seed.id,
        sourceTitle: seed.title,
        edgeKind: edge.kind,
        why: compactWhy(edge.kind, seed.title),
      });
    }
  }

  if (candidateById.size === 0) {
    return { items: input.seeds, graphContext: [] };
  }

  const candidateEntries = [...candidateById.values()];
  const loadedResults = await Promise.all(
    candidateEntries.map(async (entry) => {
      try {
        return await input.loadMemoryItem(entry.itemId);
      } catch {
        return null;
      }
    }),
  );
  const loadedItems = (
    loadedResults.filter(
      (item) =>
        item !== null &&
        item.companyId === input.companyId &&
        item.status === "approved",
    )
  ) as TGraphItem[];
  const allowedItems = await input.filterMemoryItems(loadedItems);
  const allowedIds = new Set(allowedItems.map((item) => item.id));
  const titleById = new Map(allowedItems.map((item) => [item.id, item.title]));

  return {
    items: input.seeds,
    graphContext: candidateEntries
      .filter((entry) => allowedIds.has(entry.itemId))
      .slice(0, maxGraphItems)
      .map((entry) => ({
        ...entry,
        title: titleById.get(entry.itemId) ?? entry.itemId,
      })),
  };
}

export const __companyBrainRetrievalExpansionTest = {
  DEFAULT_MAX_GRAPH_ITEMS,
  MAX_CANDIDATE_MULTIPLIER,
  MAX_CANDIDATE_CEILING,
  USEFUL_RETRIEVAL_EDGE_KINDS,
};
