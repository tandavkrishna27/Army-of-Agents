import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Home as HomeIcon,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Target,
  UserPlus,
} from "lucide-react";
import type { ThreadListItem } from "../../api/threads";
import { cn } from "../../lib/utils";

const THREAD_RAIL_SECTIONS: Array<{
  key: "unlisted" | ThreadListItem["phase"] | "archived";
  label: string;
  icon: typeof MessageSquare;
}> = [
  { key: "unlisted", label: "Unlisted", icon: Inbox },
  { key: "discuss", label: "Discuss", icon: MessageSquare },
  { key: "scope", label: "Scope", icon: Target },
  { key: "assign", label: "Assign", icon: UserPlus },
  { key: "done", label: "Done", icon: CheckCircle2 },
  { key: "archived", label: "Archived", icon: Archive },
];

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(dateStr).toLocaleDateString();
}

interface ThreadsSidebarRailProps {
  activeMode: "home" | "threads";
  collapsed: boolean;
  onToggle: () => void;
  onOpenHome: () => void;
  onArchiveThread: (threadId: string) => void;
  onUnarchiveThread: (threadId: string) => void;
  threads: ThreadListItem[];
  archivedThreads: ThreadListItem[];
  unlistedHasItems?: boolean;
  currentId: string | null;
  onNewThread: () => void;
  search: string;
  setSearch: (value: string) => void;
}

export function ThreadsSidebarRail({
  activeMode,
  collapsed,
  onToggle,
  onOpenHome,
  onArchiveThread,
  onUnarchiveThread,
  threads,
  archivedThreads,
  unlistedHasItems = false,
  currentId,
  onNewThread,
  search,
  setSearch,
}: ThreadsSidebarRailProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{ id: string; title: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    unlisted: true,
    discuss: true,
    scope: true,
    assign: true,
    done: true,
    archived: true,
  });
  const threadsByPhase = useMemo(() => {
    const groups: Record<ThreadListItem["phase"], ThreadListItem[]> = {
      discuss: [],
      scope: [],
      assign: [],
      done: [],
    };
    for (const thread of threads) {
      groups[thread.phase]?.push(thread);
    }
    return groups;
  }, [threads]);

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-[42px] shrink-0 items-center gap-1 border-b border-border",
          collapsed ? "justify-center px-1" : "px-2",
        )}
        data-testid="thread-rail-header"
      >
        {!collapsed && (
          <>
            <span className="flex-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Threads
            </span>
            <button
              type="button"
              onClick={() => setSearchOpen((value) => !value)}
              aria-label="Search threads"
              aria-expanded={searchOpen}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                searchOpen && "bg-muted text-foreground",
              )}
            >
              <Search className="h-4 w-4" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand thread browser" : "Collapse thread browser"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {!collapsed && (
        <div className="shrink-0 space-y-2 border-b border-border px-2 py-2">
          {searchOpen && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                aria-label="Search threads"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search threads..."
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}
          <button
            type="button"
            onClick={onNewThread}
            aria-label="New thread"
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-brand bg-brand px-2 text-xs font-semibold text-white transition-colors hover:border-brand/90 hover:bg-brand/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New thread
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {collapsed ? (
          <nav className="flex flex-col items-center gap-1.5 pt-1" aria-label="Collapsed thread categories">
            <button
              type="button"
              onClick={onNewThread}
              aria-label="New thread"
              title="New thread"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-brand bg-brand text-white transition-colors hover:border-brand/90 hover:bg-brand/90"
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="my-1 h-px w-5 bg-border" aria-hidden />
            <Link
              to="/discussions"
              onClick={onOpenHome}
              aria-label="Home"
              aria-current={activeMode === "home" ? "page" : undefined}
              title="Home"
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                activeMode === "home"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <HomeIcon className="h-4 w-4" aria-hidden />
            </Link>
            {THREAD_RAIL_SECTIONS.map((section) => {
              const sectionThreads =
                section.key === "archived"
                  ? archivedThreads
                  : section.key === "unlisted"
                    ? []
                    : threadsByPhase[section.key] ?? [];
              const hasPending = sectionThreads.some((thread) => thread.pendingItemCount > 0);
              const hasSectionAttention = section.key === "unlisted" ? unlistedHasItems : hasPending;
              const SectionIcon = section.icon;
              return (
                <button
                  key={section.key}
                  type="button"
                  onClick={() => {
                    setOpenSections((current) => ({
                      ...current,
                      [section.key]: true,
                    }));
                    onToggle();
                  }}
                  aria-label={section.label}
                  title={section.label}
                  className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <SectionIcon className="h-4 w-4" aria-hidden />
                  {hasSectionAttention && (
                    <span
                      className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                      aria-hidden
                      data-testid={`collapsed-section-pending-${section.key}`}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="space-y-1.5">
            <Link
              to="/discussions"
              onClick={onOpenHome}
              aria-current={activeMode === "home" ? "page" : undefined}
              className={cn(
                "group flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors",
                activeMode === "home"
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground/80 hover:bg-white/[0.04] hover:text-foreground",
              )}
              data-testid="thread-rail-home"
            >
              <HomeIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Home</span>
            </Link>
            <div className="my-1 h-px bg-border" aria-hidden />
            {THREAD_RAIL_SECTIONS.map((section) => {
              const sectionThreads =
                section.key === "archived"
                  ? archivedThreads
                  : section.key === "unlisted"
                    ? []
                    : threadsByPhase[section.key] ?? [];
              const isOpen = openSections[section.key] ?? true;
              const SectionIcon = section.icon;
              return (
                <section key={section.key}>
                  <div className="group flex h-[30px] w-full items-center rounded-md text-[13px] font-medium text-foreground/80 transition-colors hover:bg-white/[0.04] hover:text-foreground">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={section.label}
                      onClick={() =>
                        setOpenSections((current) => ({
                          ...current,
                          [section.key]: !(current[section.key] ?? true),
                        }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
                    >
                      <SectionIcon
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-opacity",
                          !isOpen && "opacity-60",
                        )}
                        aria-hidden
                        data-section-icon="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Toggle ${section.label}`}
                      onClick={() =>
                        setOpenSections((current) => ({
                          ...current,
                          [section.key]: !(current[section.key] ?? true),
                        }))
                      }
                      className="inline-flex size-7 shrink-0 items-center justify-center"
                    >
                      {isOpen ? (
                        <ChevronDown
                          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          aria-hidden
                          data-section-chevron="true"
                        />
                      ) : (
                        <ChevronRight
                          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          aria-hidden
                          data-section-chevron="true"
                        />
                      )}
                    </button>
                  </div>
                  {isOpen && (
                    <div className="space-y-0.5 pb-1">
                      {sectionThreads.map((thread) => (
                        <ThreadRailRow
                          key={thread.id}
                          thread={thread}
                          active={thread.id === currentId}
                          menuOpen={openMenuId === thread.id}
                          archived={section.key === "archived"}
                          onMenuToggle={() =>
                            setOpenMenuId((current) => (current === thread.id ? null : thread.id))
                          }
                          onArchive={() => {
                            setOpenMenuId(null);
                            setArchiveConfirm({ id: thread.id, title: thread.title });
                          }}
                          onUnarchive={() => {
                            setOpenMenuId(null);
                            onUnarchiveThread(thread.id);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
      {archiveConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Archive thread"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4"
          onClick={() => setArchiveConfirm(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Archive thread</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Archive "{archiveConfirm.title}"? It will move out of the live rail and can be restored from Archived.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchiveConfirm(null)}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onArchiveThread(archiveConfirm.id);
                  setArchiveConfirm(null);
                }}
                className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-semibold text-white transition-colors hover:bg-brand/90"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        data-testid="thread-rail-footer"
        className={cn("shrink-0 border-t border-border", collapsed ? "h-2" : "h-2")}
      />
    </div>
  );
}

function ThreadRailRow({
  thread,
  active,
  menuOpen,
  archived,
  onMenuToggle,
  onArchive,
  onUnarchive,
}: {
  thread: ThreadListItem;
  active: boolean;
  menuOpen: boolean;
  archived: boolean;
  onMenuToggle: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  return (
    <div
      className="group relative h-8 rounded-md pl-7 transition-colors hover:bg-white/[0.04]"
      data-testid={`thread-rail-row-${thread.id}`}
    >
      <Link
        to={`/discussions/${thread.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "grid h-8 grid-cols-[minmax(0,1fr)] items-center rounded-md pl-2 pr-12 text-[13px] font-medium transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left font-medium">{thread.title}</span>
      </Link>
      <span
        className={cn(
          "absolute right-2 top-1/2 inline-flex -translate-y-1/2 justify-self-end transition-opacity group-hover:opacity-0",
          menuOpen && "opacity-0",
        )}
        data-testid={`thread-row-meta-${thread.id}`}
      >
        {thread.pendingItemCount > 0 ? (
          <span
            className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400"
            aria-label="Pending items"
            title="Needs review"
            data-testid={`thread-row-pending-${thread.id}`}
          />
        ) : (
          <span
            className="shrink-0 justify-self-end text-[11px] tabular-nums text-muted-foreground"
            data-testid={`thread-row-time-${thread.id}`}
          >
            {thread.lastEntryAt ? relativeTime(thread.lastEntryAt) : ""}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={`${thread.title} actions`}
        aria-expanded={menuOpen}
        onClick={onMenuToggle}
        className={cn(
          "absolute right-1 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100",
          menuOpen && "opacity-100",
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-1 top-7 z-30 min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={archived ? onUnarchive : onArchive}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {archived ? "Unarchive thread" : "Archive thread"}
          </button>
        </div>
      )}
    </div>
  );
}
