/** Frame-wide drag-drop (mock §5). Depth counter because dragenter/leave fire
 *  per child element. Pass `dragHandlers` to ComposerFrame's dragHandlers prop.
 *  File VALIDATION stays in each surface's existing add-files path — this hook
 *  only detects + hands over the File[]. */
import { useCallback, useRef, useState } from "react";

export function useComposerDragDrop({
  onDropFiles,
  disabled = false,
}: {
  onDropFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const depth = useRef(0);
  const [isDragActive, setDragActive] = useState(false);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragActive(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragActive(false);
    },
    [disabled],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onDropFiles(files);
    },
    [disabled, onDropFiles],
  );

  return { isDragActive, dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
