import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import {
  X,
  Check,
  CircleX,
  TriangleAlert,
  Info,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useToast, type ToastItem, type ToastTone } from "../context/ToastContext";
import { cn } from "../lib/utils";

const TONE_COLOR_VAR: Record<ToastTone, string> = {
  info: "var(--info)",
  success: "var(--success)",
  warn: "var(--warning)",
  error: "var(--error)",
  loading: "var(--toast-loading)",
};

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: Check,
  warn: TriangleAlert,
  error: CircleX,
  loading: LoaderCircle,
};

function formatRelative(createdAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const color = TONE_COLOR_VAR[toast.tone];
  const Icon = TONE_ICON[toast.tone];
  const isLoading = toast.tone === "loading";
  // Full (two-line) form for loading toasts and entity-referencing events; compact otherwise.
  const isFull = isLoading || !!toast.meta?.ref;
  const ts = formatRelative(toast.createdAt);

  return (
    <li
      className={cn(
        "toast-glass pointer-events-auto relative overflow-hidden rounded-lg transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
    >
      {isFull ? (
        <div className="flex items-start gap-3 px-3 py-2.5">
          <span
            className="mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
          >
            <Icon
              className={cn("size-4", isLoading && "animate-spin motion-reduce:animate-none")}
              style={{ color }}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-medium leading-5 text-text">{toast.title}</p>
              <span className="ml-auto shrink-0 text-[10.5px] text-very-dim">{ts}</span>
            </div>
            {(toast.meta?.ref || toast.body) && (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-dim">
                {toast.meta?.ref && (
                  <span className="rounded bg-white/5 px-1.5 font-mono text-[10.5px] text-dim">
                    {toast.meta.ref}
                  </span>
                )}
                {toast.body && <span className="truncate">{toast.body}</span>}
              </div>
            )}
            {toast.action && (
              <Link
                to={toast.action.href}
                onClick={() => onDismiss(toast.id)}
                className="mt-1.5 inline-flex text-xs font-medium hover:opacity-90"
                style={{ color }}
              >
                {toast.action.label}
              </Link>
            )}
          </div>
          {!isLoading && (
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
              className="-mr-0.5 mt-0.5 shrink-0 rounded p-1 text-dim opacity-60 hover:bg-white/10 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          )}
          {isLoading && <span data-testid="toast-loading-rail" className="toast-rail" />}
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="size-[7px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <p className="shrink-0 text-[13px] font-medium leading-5 text-text">{toast.title}</p>
          {toast.body && <span className="truncate text-xs text-dim">{toast.body}</span>}
          {toast.action && (
            <Link
              to={toast.action.href}
              onClick={() => onDismiss(toast.id)}
              className="ml-auto shrink-0 text-xs font-medium hover:opacity-90"
              style={{ color }}
            >
              {toast.action.label}
            </Link>
          )}
          <span className={cn("shrink-0 text-[10.5px] text-very-dim", !toast.action && "ml-auto")}>
            {ts}
          </span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 rounded p-0.5 text-dim opacity-60 hover:bg-white/10 hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();
  if (toasts.length === 0) return null;
  return (
    <aside
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-3 right-3 z-[120] w-full max-w-sm px-1"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </ol>
    </aside>
  );
}
