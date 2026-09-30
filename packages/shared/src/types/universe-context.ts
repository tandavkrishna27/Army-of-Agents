export type UniverseReference =
  | { kind: "task"; id: string }
  | { kind: "artifact"; id: string; versionId?: string }
  | { kind: "message"; id: string };

export interface UniverseViewport {
  width: number;
  height: number;
  x: number;
  y: number;
  zoom: number;
}

export interface UniverseContext {
  schemaVersion: 1;
  conversationId: string;
  selected: UniverseReference | null;
  visible: UniverseReference[];
  viewport: UniverseViewport;
}

export interface ResolvedUniverseReference {
  reference: UniverseReference;
  disposition: "available" | "unavailable" | "superseded";
  label?: string;
  currentVersionId?: string;
}

export interface ResolvedUniverseContext {
  schemaVersion: 1;
  conversationId: string;
  selected: ResolvedUniverseReference | null;
  visible: ResolvedUniverseReference[];
  viewport: UniverseViewport;
}
