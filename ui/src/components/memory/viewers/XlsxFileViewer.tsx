import { OfficeFileViewer } from "./OfficeFileViewer";

interface XlsxFileViewerProps {
  companyId: string;
  assetId: string;
}

/**
 * Memory-scoped XLSX preview. Thin wrapper over the shared {@link OfficeFileViewer}
 * (DOCX + XLSX share the render chrome + fetch-inject); pins the "spreadsheet"
 * render copy. The memory `/render` route dispatches XLSX to exceljs → sanitized
 * HTML, same shared DOMPurify config as DOCX.
 */
export function XlsxFileViewer({ companyId, assetId }: XlsxFileViewerProps) {
  return <OfficeFileViewer companyId={companyId} assetId={assetId} noun="spreadsheet" />;
}
