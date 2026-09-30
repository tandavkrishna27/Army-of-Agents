import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useCatalog } from "@/hooks/useCatalog";
import { searchItems } from "@/api/marketplace";
import { detailUrl } from "./CatalogCard";
import { TYPE_ICONS, TYPE_LABELS } from "@/lib/marketplace-constants";

const DEBOUNCE_MS = 150;
const MAX_DROPDOWN_RESULTS = 5;

/**
 * Debounced search input with dropdown of top 5 matches.
 * Submitting (Enter) navigates to /marketplace/search?q=...
 * Clicking a dropdown result navigates to the item's detail page.
 */
export function SearchTypeahead() {
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  const results = useMemo(() => {
    if (!catalog || !debounced.trim()) return [];
    return searchItems(catalog.items, debounced).slice(0, MAX_DROPDOWN_RESULTS);
  }, [catalog, debounced]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      navigate(`/marketplace/search?q=${encodeURIComponent(input.trim())}`);
      setOpen(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search marketplace…"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="pl-8 w-72"
          aria-label="Search marketplace"
        />
      </div>
      {open && results.length > 0 && (
        <div
          role="listbox"
          className="absolute z-50 top-full mt-1 left-0 right-0 bg-popover border rounded-md shadow-lg max-h-80 overflow-auto"
        >
          {results.map((item) => {
            const Icon = TYPE_ICONS[item.type];
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected="false"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  navigate(detailUrl(item));
                  setOpen(false);
                  setInput("");
                }}
                className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 text-sm"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {TYPE_LABELS[item.type]} · {item.description}
                  </p>
                </div>
              </button>
            );
          })}
          {results.length === MAX_DROPDOWN_RESULTS && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleSubmit}
              className="w-full text-left px-3 py-2 border-t hover:bg-accent text-sm text-primary"
            >
              See all results for "{input}" →
            </button>
          )}
        </div>
      )}
    </form>
  );
}
