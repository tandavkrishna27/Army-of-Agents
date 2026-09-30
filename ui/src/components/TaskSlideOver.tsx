import { useCallback, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";
import { TaskDetail } from "./TaskDetail";
import { cn } from "../lib/utils";

interface TaskSlideOverProps {
  issueId: string | null;
  open: boolean;
  onClose: () => void;
}

const MIN_PANEL_WIDTH = 720;
const WIDE_PANEL_FLOOR = 840;
const MAX_PANEL_WIDTH = 960;

function clampPanelWidth(width: number) {
  const viewportWidth = typeof window === "undefined" ? MAX_PANEL_WIDTH : window.innerWidth;
  const viewportBound = Math.max(MIN_PANEL_WIDTH, viewportWidth - 32);
  const wideBound = Math.max(WIDE_PANEL_FLOOR, viewportWidth * 0.5);
  return Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH, viewportBound, wideBound));
}

export function TaskSlideOver({ issueId, open, onClose }: TaskSlideOverProps) {
  const [wide, setWide] = useState(false);
  const [customWidth, setCustomWidth] = useState<number | null>(null);

  // Title-only query, deduped with TaskDetail's issues.detail query.
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId && open,
  });

  const toggleWide = useCallback(() => {
    setCustomWidth(null);
    setWide((current) => !current);
  }, []);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setWide(true);

    const onPointerMove = (moveEvent: PointerEvent) => {
      setCustomWidth(clampPanelWidth(window.innerWidth - moveEvent.clientX));
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    onPointerMove(event.nativeEvent);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, []);

  const isWide = wide || Boolean(customWidth);
  const panelWidth = customWidth
    ? `${customWidth}px`
    : isWide
      ? "min(960px, max(50vw, 840px), calc(100vw - 32px))"
      : "min(760px, calc(100vw - 32px))";
  const panelStyle = { width: panelWidth, maxWidth: panelWidth } satisfies CSSProperties;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        data-size-mode={isWide ? "wide" : "default"}
        style={panelStyle}
        className={cn(
          "p-0 gap-0 overflow-hidden overflow-x-hidden flex flex-col min-w-0 max-w-full transition-[width,max-width] duration-200 ease-out",
          isWide
            ? "task-slide-over-wide w-full sm:w-[min(960px,max(50vw,840px),calc(100vw-32px))] sm:max-w-[min(960px,max(50vw,840px),calc(100vw-32px))]"
            : "task-slide-over-default w-full sm:w-[min(760px,calc(100vw-32px))] sm:max-w-[min(760px,calc(100vw-32px))]",
        )}
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
      >
        <SheetTitle className="sr-only">
          {issue?.identifier ? `${issue.identifier}: ` : ""}
          {issue?.title ?? "Task details"}
        </SheetTitle>
        <SheetDescription className="sr-only">
          Task details, comments, and workspace actions
        </SheetDescription>
        <button
          type="button"
          aria-label="Resize task panel"
          title="Drag to resize"
          data-testid="task-slide-over-resize-handle"
          className="absolute inset-y-0 left-0 z-10 hidden w-2 cursor-ew-resize touch-none bg-transparent transition-colors hover:bg-border/70 active:bg-border sm:block"
          onPointerDown={handleResizePointerDown}
          onDoubleClick={toggleWide}
        />
        <TaskDetail
          issueId={issueId}
          active={open}
          onDismiss={onClose}
          panelWide={isWide}
          onTogglePanelWide={toggleWide}
        />
      </SheetContent>
    </Sheet>
  );
}
