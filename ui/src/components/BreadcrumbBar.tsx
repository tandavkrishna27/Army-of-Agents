import { Link } from "@/lib/router";
import { Menu, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar } = useSidebar();

  if (breadcrumbs.length === 0) return null;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  // Show last 2 entries: parent (clickable, dim) · current (bold, foreground).
  // Top-level pages have just 1 entry → render single title.
  const lastTwo = breadcrumbs.slice(-2);
  const hasParent = lastTwo.length === 2;
  const parent = hasParent ? lastTwo[0] : null;
  const current = lastTwo[hasParent ? 1 : 0]!;

  return (
    <div className="border-b border-border px-4 md:px-6 h-11 shrink-0 flex items-center min-w-0 overflow-hidden">
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

      {/* Breadcrumb / page title */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
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
        <h1 className="text-[14px] font-semibold tracking-wide truncate">
          {current.label}
        </h1>
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
