---
"@armyofagents/ui": patch
---

Restructure the lobby into a sidebar+main layout. New `LobbySidebar` (brand + Companies/Marketplace/Settings nav rows + UserMenu). New `LobbyEmptyState` hero replaces the auto-onboarding modal — with zero companies, the founder now sees a designed welcome screen with explicit Create/Import CTAs instead of being thrown straight into the modal. Company creation/import lives in a `+ New` header dropdown when at least one company exists, replacing the legacy dashed grid cards. Company cards now render PR-A's pending-approval and unread-notification counts alongside agent and task counts. Card surface is `bg-card/85` to compose with the gradient background that lands in the next polish PR. Marketplace back-arrow regression: `MarketplaceLayout`'s header arrow now uses `navigate(-1)` (browser history) instead of `navigate("/home")`, so it works from the lobby and other entry points.
