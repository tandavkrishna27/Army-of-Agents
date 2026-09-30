import { useMemo, useState, type ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "@/lib/router";
import { LobbyShell } from "@/components/LobbyShell";
import { lobbyActiveItem } from "@/lib/lobbyActiveItem";

/**
 * Context handed to lobby child routes so a page can fill the shell's
 * secondary-sidebar slot (only Settings uses it today). Read it with
 * `useOutletContext<LobbyOutletContext>()`.
 */
export interface LobbyOutletContext {
  setSecondarySidebar: (node: ReactNode | null) => void;
}

/**
 * Persistent layout route for the lobby-tier pages (Lobby, Marketplace*,
 * Settings). Renders {@link LobbyShell} ONCE and swaps page content via
 * `<Outlet/>`, so the sidebar no longer remounts (and re-animates) on every
 * navigation. `activeItem` is derived from the route; a child page can provide
 * a secondary sidebar via the outlet context.
 */
export function LobbyLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [secondarySidebar, setSecondarySidebar] = useState<ReactNode | null>(null);
  // Stable context identity (setSecondarySidebar is a stable useState setter) so
  // Outlet consumers don't re-render just because this layout re-rendered.
  const outletContext = useMemo<LobbyOutletContext>(() => ({ setSecondarySidebar }), []);

  // ?new=1 forces the org-create step even for a returning founder who already
  // has a (completed) selected company — otherwise /onboarding binds to that
  // company, resolves no step, and dead-ends at the Lobby.
  const handleCreateCompany = () => navigate("/onboarding?new=1");

  return (
    <LobbyShell
      activeItem={lobbyActiveItem(location.pathname)}
      onCreateCompany={handleCreateCompany}
      secondarySidebar={secondarySidebar}
    >
      <Outlet context={outletContext} />
    </LobbyShell>
  );
}
