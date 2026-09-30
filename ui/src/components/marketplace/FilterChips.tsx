import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

export interface FilterChipsProps {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  maxVisible?: number;
}

export function FilterChips({ options, selected, onChange, maxVisible }: FilterChipsProps) {
  const visible = maxVisible ? options.slice(0, maxVisible) : options;
  const isSelected = (opt: string) => selected.includes(opt);

  const toggle = (opt: string) => {
    if (isSelected(opt)) onChange(selected.filter((s) => s !== opt));
    else onChange([...selected, opt]);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => toggle(opt)}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          aria-pressed={isSelected(opt)}
        >
          <Badge
            variant={isSelected(opt) ? "default" : "outline"}
            className="cursor-pointer hover:opacity-80 transition-opacity"
          >
            {opt}
            {isSelected(opt) && <X className="h-3 w-3 ml-1" />}
          </Badge>
        </button>
      ))}
    </div>
  );
}
