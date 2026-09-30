import { createContext, useContext, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { LobbySidebar, type LobbySidebarItem } from "@/components/LobbySidebar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface LobbyShellContextValue {
  /** Open the mobile drawer sidebar. Pages call this from their hamburger button. */
  openMobileMenu: () => void;
}

const LobbyShellContext = createContext<LobbyShellContextValue | null>(null);

/**
 * Access lobby-shell controls from a child page. Provides {@link openMobileMenu}
 * so pages can render their own hamburger button at the right spot in their
 * layout (the empty-state hero centers content, while the populated lobby has a
 * heading at the top — neither layout suits a shell-owned absolute button).
 */
export function useLobbyShell(): LobbyShellContextValue {
  const ctx = useContext(LobbyShellContext);
  if (!ctx) {
    throw new Error("useLobbyShell must be used inside <LobbyShell>");
  }
  return ctx;
}

interface LobbyShellProps {
  /** Which sidebar nav row to highlight as active. */
  activeItem: LobbySidebarItem;
  /** Click handler for the sidebar's "+ New organization" button. */
  onCreateCompany: () => void;
  /**
   * Optional secondary sidebar rendered flush between the primary sidebar and
   * the main content. Hidden on mobile (the primary drawer covers the nav
   * surface on small viewports). Used by Settings — see InstanceSettingsPage.
   */
  secondarySidebar?: ReactNode;
  /** Page content rendered in the main column. */
  children: ReactNode;
}

/**
 * Shared chrome for the lobby-tier pages — Lobby, Marketplace, and Settings.
 * Renders the {@link LobbySidebar} (desktop) plus the mobile drawer Sheet, and
 * exposes {@link openMobileMenu} via {@link useLobbyShell} so each page can put
 * its hamburger button in the right place for its layout.
 *
 * Children are rendered inside `<main>`. The shell does not impose any padding
 * on children — pages are responsible for their own content layout.
 */
export function LobbyShell({
  activeItem,
  onCreateCompany,
  secondarySidebar,
  children,
}: LobbyShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <LobbyShellContext.Provider value={{ openMobileMenu: () => setMobileMenuOpen(true) }}>
      <div
        className={cn(
          "flex h-dvh bg-bg text-foreground",
          "bg-[radial-gradient(ellipse_120%_70%_at_50%_-10%,var(--brand-focus-ring)_0%,transparent_55%)]",
        )}
      >
        {/* Desktop / tablet sidebar — inline, hidden on mobile */}
        <div className="hidden md:flex">
          <LobbySidebar
            activeItem={activeItem}
            onCreateCompany={onCreateCompany}
            hasSecondarySidebar={secondarySidebar != null}
          />
        </div>

        {/* Mobile drawer sidebar — opens on hamburger click, hidden on tablet+ */}
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetContent side="left" className="w-[260px] p-0 sm:max-w-[260px]">
            <LobbySidebar
              activeItem={activeItem}
              onCreateCompany={onCreateCompany}
              drawer
              onNavigate={() => setMobileMenuOpen(false)}
            />
          </SheetContent>
        </Sheet>

        {/* Optional secondary sidebar — flush with the primary, desktop only */}
        {secondarySidebar && (
          <div className="hidden md:flex">{secondarySidebar}</div>
        )}

        {/* Main column — pages own their padding/layout */}
        <main className="flex flex-1 flex-col overflow-auto min-w-0">{children}</main>
      </div>
    </LobbyShellContext.Provider>
  );
}

interface MobileMenuButtonProps {
  /** Extra classes appended to the default button styles. */
  className?: string;
}

/**
 * Pre-styled hamburger button for opening the {@link LobbyShell} mobile drawer.
 * Hidden on tablet+ (md:hidden). Pages drop this where it fits their layout.
 */
export function LobbyShellMobileMenuButton({ className }: MobileMenuButtonProps) {
  const { openMobileMenu } = useLobbyShell();
  return (
    <button
      type="button"
      onClick={openMobileMenu}
      aria-label="Open menu"
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md border border-border-strong bg-card text-very-dim hover:bg-card-2 hover:text-foreground md:hidden",
        className,
      )}
    >
      <Menu className="size-4" />
    </button>
  );
}
