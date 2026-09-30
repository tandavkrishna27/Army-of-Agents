import { SharedContentViewer } from "@/components/viewers/SharedContentViewer";
import type { OutputViewerResolution } from "./output-viewer-registry";

interface WorkProductViewerProps {
  viewer: OutputViewerResolution;
  filename: string;
  inlineTextContent?: string | null;
}

export function WorkProductViewer(props: WorkProductViewerProps) {
  return <SharedContentViewer {...props} />;
}
