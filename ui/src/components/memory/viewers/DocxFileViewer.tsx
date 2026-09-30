import { OfficeFileViewer } from "./OfficeFileViewer";

interface DocxFileViewerProps {
  companyId: string;
  assetId: string;
}

/**
 * Memory-scoped DOCX preview. Thin wrapper over the shared {@link OfficeFileViewer}
 * (DOCX + XLSX share the render chrome + fetch-inject); pins the "document" render
 * copy. Behaviour is identical to the pre-generalization component.
 */
export function DocxFileViewer({ companyId, assetId }: DocxFileViewerProps) {
  return <OfficeFileViewer companyId={companyId} assetId={assetId} noun="document" />;
}
