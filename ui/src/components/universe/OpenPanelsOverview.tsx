import { useEffect, useState } from "react";

/** A tile in the open-panels overview. Ordered by the immutable openedOrdinal
 * (creation order), never the controller's focus/z-order list. */
export interface OpenPanelTile {
  key: string;
  title: string;
  kind: string;
  openedOrdinal: number;
  minimized: boolean;
}

export function OpenPanelsOverview({
  panels,
  onOpen,
  pageSize = 6,
}: {
  panels: OpenPanelTile[];
  onOpen: (key: string) => void;
  pageSize?: number;
}) {
  const ordered = [...panels].sort((a, b) => a.openedOrdinal - b.openedOrdinal);
  const size = Math.max(1, Math.floor(pageSize));
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(ordered.length / size) - 1);
  useEffect(() => setPage(current => Math.min(current, lastPage)), [lastPage]);
  if (ordered.length === 0)
    return (
      <p role="status" className="universe-overview-empty">
        No open panels.
      </p>
    );
  const start = Math.min(page, lastPage) * size;
  const visible = ordered.slice(start, start + size);
  return (
    <div className="universe-overview-wrap">
      <ul className="universe-overview" role="list">
        {visible.map((panel) => (
          <li key={panel.key}>
            <button
              type="button"
              className="universe-overview-tile"
              data-minimized={panel.minimized}
              onClick={() => onOpen(panel.key)}
            >
              {/* Android-recents-style thumbnail. Real authorized content capture
               * is the deferred E1.4/2 hover preview; this is a window proxy. */}
              <span
                className="universe-overview-thumb"
                data-kind={panel.kind}
                aria-hidden
              >
                <span className="universe-overview-thumb-bar" />
                <span className="universe-overview-thumb-lines">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="universe-overview-meta">
                <span className="universe-overview-title">{panel.title}</span>
                <span className="universe-overview-kind">
                  {panel.minimized ? `${panel.kind} · minimized` : panel.kind}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {ordered.length > size && (
        <nav className="universe-overview-pages" aria-label="Open panels pages">
          <button type="button" aria-label="Previous open panels" disabled={page <= 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button>
          <span>{start + 1}–{Math.min(start + size, ordered.length)} of {ordered.length}</span>
          <button type="button" aria-label="Next open panels" disabled={page >= lastPage} onClick={() => setPage(value => Math.min(lastPage, value + 1))}>Next</button>
        </nav>
      )}
    </div>
  );
}
