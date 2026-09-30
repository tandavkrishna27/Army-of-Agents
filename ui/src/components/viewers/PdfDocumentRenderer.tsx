import { Document, Page, pdfjs } from "react-pdf";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfDocumentRendererProps {
  fileUrl: string;
  pageNumber: number;
  pageWidth: number;
  onLoadSuccess: (numPages: number) => void;
  onLoadError: () => void;
}

export function PdfDocumentRenderer({
  fileUrl,
  pageNumber,
  pageWidth,
  onLoadSuccess,
  onLoadError,
}: PdfDocumentRendererProps) {
  return (
    <Document
      file={fileUrl}
      onLoadSuccess={({ numPages }) => onLoadSuccess(numPages)}
      onLoadError={onLoadError}
      loading={<div className="p-8 text-xs text-muted-foreground">Loading PDF...</div>}
      error={<div className="p-8 text-xs text-destructive">Failed to load PDF.</div>}
    >
      <Page pageNumber={pageNumber} width={pageWidth} />
    </Document>
  );
}
