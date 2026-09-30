import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Briefcase,
  ChevronDown,
  Files,
  Globe,
  Inbox as InboxIcon,
  PanelsTopLeft,
  SlidersHorizontal,
} from "lucide-react";
import {
  initialTrayState,
  trayReducer,
  type TrayMenu,
} from "./tray-state";
import { OpenPanelsOverview, type OpenPanelTile } from "./OpenPanelsOverview";
import { AoaLogo } from "../../onboarding/motion/AoaLogo";
import "../../onboarding/motion/motion.css";
import "./universe-tray.css";

/** A library reference the tray can resolve and open (task, artifact, chat…). */
export interface TrayReferenceItem {
  key: string;
  label: string;
  hint?: string;
}

/** Menus that list authorized references and share the focus-managed popup. */
export type LibraryMenu = Exclude<TrayMenu, "commander" | "open-panels">;

export interface CommanderToggleState {
  chat: boolean;
  blob: boolean;
  captions: boolean;
}

export interface UniverseTrayProps {
  /** Authorization scope identity. A change dismisses any menu holding old-scope data. */
  scopeKey?: string;
  /** Authorized reference lists per library menu. Absent menu → empty. */
  menuItems?: Partial<Record<LibraryMenu, TrayReferenceItem[]>>;
  /** Recent/new conversations exposed under the Commander options menu. */
  commanderConversations?: TrayReferenceItem[];
  /** Live open-panels registry projection (open + minimized), any order. */
  openPanels: OpenPanelTile[];
  /** Per-menu attention counts; only nonzero values render a badge. */
  counts?: Partial<Record<TrayMenu, number>>;
  /** Resolve a library reference and dispatch one open by key. */
  onOpenReference: (menu: LibraryMenu, key: string) => void;
  /** Open a conversation from the Commander options menu. */
  onOpenConversation?: (key: string) => void;
  /** Restore/focus an existing open panel from the overview. */
  onOpenPanel: (key: string) => void;
  /** Commander primary: restore/focus/tuck chat. Never changes voice/blob/captions. */
  onCommanderPrimary: () => void;
  /** Exposes the primary control for focus restoration after another surface tucks chat. */
  commanderPrimaryRef?: (node: HTMLButtonElement | null) => void;
  /** Commander options view-mode toggles (independent of the primary action). */
  commanderToggles?: CommanderToggleState;
  onToggleCommander?: (which: keyof CommanderToggleState, value: boolean) => void;
  /** Current conversation title shown quietly above the tray (U02). */
  conversationTitle?: string;
  /** E8.1 dock hiding; "always" stays expanded, "hidden" collapses by default. */
  dockHiding?: "always" | "auto" | "hidden";
}

// Balanced wings around the centered AoA mark, matching the mock: Work and
// Artifacts & Sources sit left with Commander; Inbox, Browser, Settings and the
// one Open panels control sit right.
type TrayEntry = { menu: TrayMenu; label: string; Icon: typeof Globe };
const LEFT_MENUS: TrayEntry[] = [
  { menu: "work", label: "Work", Icon: Briefcase },
  { menu: "artifacts", label: "Artifacts & Sources", Icon: Files },
];
const RIGHT_MENUS: TrayEntry[] = [
  { menu: "inbox", label: "Inbox", Icon: InboxIcon },
  { menu: "browser", label: "Browser", Icon: Globe },
  { menu: "settings", label: "Settings", Icon: SlidersHorizontal },
  { menu: "open-panels", label: "Open panels", Icon: PanelsTopLeft },
];

const MENU_TITLE: Record<TrayMenu, string> = {
  commander: "Commander options",
  work: "Work",
  artifacts: "Artifacts & Sources",
  inbox: "Inbox",
  browser: "Browser",
  settings: "Settings",
  "open-panels": "Open panels",
};

function Badge({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <span className="universe-tray-badge" aria-hidden>
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function UniverseTray({
  scopeKey,
  menuItems,
  commanderConversations = [],
  openPanels,
  counts,
  onOpenReference,
  onOpenConversation,
  onOpenPanel,
  onCommanderPrimary,
  commanderPrimaryRef,
  commanderToggles,
  onToggleCommander,
  conversationTitle,
  dockHiding = "always",
}: UniverseTrayProps) {
  const [state, dispatch] = useReducer(
    trayReducer,
    dockHiding === "hidden",
    (hidden) => initialTrayState(!hidden)
  );
  const rootRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<TrayMenu, HTMLButtonElement | null>());
  const [search, setSearch] = useState("");
  const popupId = useId();

  useEffect(() => {
    dispatch({ type: "dismiss" });
  }, [scopeKey]);

  // Reset the per-menu search whenever the open menu changes.
  useEffect(() => setSearch(""), [state.menu]);

  // Move focus into the popup when a menu opens.
  useEffect(() => {
    if (!state.menu) return;
    const first = popupRef.current?.querySelector<HTMLElement>(
      "input, button, [tabindex]"
    );
    first?.focus();
  }, [state.menu]);

  // Outside pointerdown dismisses the open menu.
  useEffect(() => {
    if (!state.menu) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node))
        dispatch({ type: "dismiss" });
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [state.menu]);

  const closeToTrigger = useCallback((menu: TrayMenu) => {
    dispatch({ type: "dismiss" });
    triggerRefs.current.get(menu)?.focus();
  }, []);

  const onPopupKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && state.menu) {
      event.stopPropagation();
      closeToTrigger(state.menu);
    }
  };

  const items = useMemo(() => {
    if (!state.menu || state.menu === "commander" || state.menu === "open-panels")
      return [];
    const source = menuItems?.[state.menu] ?? [];
    const q = search.trim().toLowerCase();
    return q
      ? source.filter((item) => item.label.toLowerCase().includes(q))
      : source;
  }, [state.menu, menuItems, search]);

  const openPanelCount = openPanels.length;
  const resolvedCounts: Partial<Record<TrayMenu, number>> = {
    ...counts,
    "open-panels": openPanelCount,
  };

  const menuButton = (
    menu: TrayMenu,
    label: string,
    Icon: typeof Globe
  ) => (
    <button
      key={menu}
      type="button"
      ref={(el) => {
        triggerRefs.current.set(menu, el);
      }}
      className="universe-tray-icon"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={state.menu === menu}
      aria-controls={state.menu === menu ? popupId : undefined}
      data-active={state.menu === menu}
      onClick={() => dispatch({ type: "menu", menu })}
    >
      <Icon size={16} aria-hidden />
      <Badge count={resolvedCounts[menu]} />
      <span className="universe-tray-tip" aria-hidden>
        {label}
      </span>
    </button>
  );

  return (
    <nav
      ref={rootRef}
      className="universe-tray"
      aria-label="Universe"
      data-expanded={state.expanded}
      data-dock-hiding={dockHiding}
      onPointerLeave={() => {
        if (dockHiding === "auto") dispatch({ type: "pointerLeave" });
      }}
      onPointerEnter={() => {
        if (dockHiding === "auto") dispatch({ type: "pointerEnter" });
      }}
    >
      {state.expanded && conversationTitle && (
        <div className="universe-tray-conversation">{conversationTitle}</div>
      )}
      <div className="universe-tray-bar">
        <div className="universe-tray-wing universe-tray-wing-left">
          {state.expanded && (
            <>
              <button
                type="button"
                ref={commanderPrimaryRef}
                className="universe-tray-icon universe-tray-commander"
                aria-label="Commander"
                onClick={onCommanderPrimary}
              >
                <span className="universe-tray-blob" aria-hidden />
                <span className="universe-tray-tip" aria-hidden>
                  Commander
                </span>
              </button>
              <button
                type="button"
                ref={(el) => {
                  triggerRefs.current.set("commander", el);
                }}
                className="universe-tray-icon universe-tray-commander-options"
                aria-label="Commander options"
                aria-haspopup="dialog"
                aria-expanded={state.menu === "commander"}
                aria-controls={state.menu === "commander" ? popupId : undefined}
                data-active={state.menu === "commander"}
                onClick={() => dispatch({ type: "menu", menu: "commander" })}
              >
                <ChevronDown size={13} aria-hidden />
              </button>
              {LEFT_MENUS.map(({ menu, label, Icon }) =>
                menuButton(menu, label, Icon)
              )}
            </>
          )}
        </div>

        <button
          type="button"
          className="universe-tray-logo"
          aria-label="Universe menu"
          aria-expanded={state.expanded}
          onClick={() => dispatch({ type: "logo" })}
        >
          <AoaLogo size={58} />
        </button>

        <div className="universe-tray-wing universe-tray-wing-right">
          {state.expanded &&
            RIGHT_MENUS.map(({ menu, label, Icon }) =>
              menuButton(menu, label, Icon)
            )}
        </div>
      </div>

      {state.menu && (
        <div
          ref={popupRef}
          id={popupId}
          role="dialog"
          aria-label={MENU_TITLE[state.menu]}
          className="universe-tray-popup"
          data-menu={state.menu}
          onKeyDown={onPopupKeyDown}
        >
          <header className="universe-tray-popup-head">
            <span className="universe-tray-popup-title">
              {MENU_TITLE[state.menu]}
            </span>
          </header>

          {state.menu === "open-panels" ? (
            <OpenPanelsOverview
              panels={openPanels}
              onOpen={(key) => {
                onOpenPanel(key);
                closeToTrigger("open-panels");
              }}
            />
          ) : state.menu === "commander" ? (
            <div className="universe-tray-commander-menu">
              <fieldset className="universe-tray-toggles">
                <legend>View</legend>
                {(["chat", "blob", "captions"] as const).map((which) => (
                  <label key={which} className="universe-tray-toggle">
                    <input
                      type="checkbox"
                      checked={commanderToggles?.[which] ?? false}
                      onChange={(event) =>
                        onToggleCommander?.(which, event.target.checked)
                      }
                    />
                    <span>
                      {which[0].toUpperCase()}
                      {which.slice(1)}
                    </span>
                  </label>
                ))}
              </fieldset>
              {commanderConversations.length > 0 && (
                <ul className="universe-tray-list" role="list">
                  {commanderConversations.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="universe-tray-list-item"
                        onClick={() => {
                          onOpenConversation?.(item.key);
                          closeToTrigger("commander");
                        }}
                      >
                        <span>{item.label}</span>
                        {item.hint && (
                          <span className="universe-tray-list-hint">
                            {item.hint}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <input
                type="search"
                className="universe-tray-search"
                aria-label={`Search ${MENU_TITLE[state.menu]}`}
                placeholder={`Search ${MENU_TITLE[state.menu].toLowerCase()}…`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {items.length === 0 ? (
                <p className="universe-tray-empty" role="status">
                  No matches.
                </p>
              ) : (
                <ul className="universe-tray-list" role="list">
                  {items.map((item) => {
                    const menu = state.menu as LibraryMenu;
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          className="universe-tray-list-item"
                          onClick={() => {
                            onOpenReference(menu, item.key);
                            closeToTrigger(menu);
                          }}
                        >
                          <span>{item.label}</span>
                          {item.hint && (
                            <span className="universe-tray-list-hint">
                              {item.hint}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </nav>
  );
}
