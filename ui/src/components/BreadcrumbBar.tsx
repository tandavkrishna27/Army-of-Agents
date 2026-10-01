import { Link } from "@/lib/router";
import { Menu, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";
import { SidebarCollapseToggle } from "./SidebarCollapseToggle";
import { AoaLogo } from "../onboarding/motion/AoaLogo";

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar, toggleCollapse, isMobile, mode } = useSidebar();

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  // Show last 2 entries: parent (clickable, dim) · current (bold, foreground).
  // Top-level pages have just 1 entry → render single title.
  const lastTwo = breadcrumbs.slice(-2);
  const hasParent = lastTwo.length === 2;
  const parent = hasParent ? lastTwo[0] : null;
  const current = lastTwo[hasParent ? 1 : 0] ?? null;

  return (
    <div className="relative mx-2 mt-2 rounded-xl border border-border bg-card/80 px-3 md:px-4 h-11 shrink-0 flex items-center min-w-0 overflow-visible shadow-sm">
      {/* Mobile-only hamburger */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden mr-2 shrink-0"
        onClick={toggleSidebar}
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {!isMobile && (
        <>
          <SidebarCollapseToggle
            collapsed={mode === "hidden"}
            onToggle={toggleCollapse}
            sidebarWidth={0}
            inline
            className="static mr-2 size-7 shrink-0"
            ariaLabel={mode === "expanded" ? "Collapse sidebar" : mode === "compact" ? "Hide sidebar" : "Show sidebar"}
          />
        </>
      )}

      <Link
        to="/"
        aria-label="Go to Lobby"
        title="Go to Lobby"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shrink-0 opacity-90 hover:opacity-100 transition-opacity"
      >
        <AoaLogo size={54} />
      </Link>

      {/* Breadcrumb / page title */}
      <div className="ml-1 flex items-center gap-1.5 min-w-0 flex-1">
        {parent && (
          <>
            {parent.href ? (
              <Link
                to={parent.href}
                className="text-[13px] text-muted-foreground hover:text-foreground truncate"
              >
                {parent.label}
              </Link>
            ) : (
              <span className="text-[13px] text-muted-foreground truncate">{parent.label}</span>
            )}
            <span className="text-muted-foreground/60 shrink-0" aria-hidden>·</span>
          </>
        )}
        {current && (
          <h1 className="text-[14px] font-semibold tracking-wide truncate">
            {current.label}
          </h1>
        )}
      </div>

      {/* Right side — just search */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={openSearch}
          aria-label="Search (Cmd+K)"
          title="Search (Cmd+K)"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
