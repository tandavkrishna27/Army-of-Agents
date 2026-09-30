import { useEffect, useRef, type ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "../context/SidebarContext";
import { cn } from "@/lib/utils";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
}

export function PageTabBar({ items, value, onValueChange }: PageTabBarProps) {
  const { isMobile } = useSidebar();
  const activePillRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activePillRef.current?.scrollIntoView?.({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [value]);

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <div className="relative mb-1">
        <div className="overflow-x-auto -mx-1 px-1 pb-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="flex gap-1.5 w-max">
            {items.map((item) => {
              const isActive = item.value === value;
              return (
                <button
                  key={item.value}
                  ref={isActive ? activePillRef : undefined}
                  type="button"
                  onClick={() => onValueChange(item.value)}
                  className={cn(
                    "inline-flex items-center px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors border whitespace-nowrap shrink-0",
                    isActive
                      ? "bg-brand/[0.08] text-[hsl(15_60%_75%)] border-brand/[0.25]"
                      : "bg-card border-border text-foreground/[0.78] hover:bg-card-2 hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 bottom-1 w-6 bg-gradient-to-l from-bg to-transparent"
        />
      </div>
    );
  }

  return (
    <TabsList variant="line">
      {items.map((item) => (
        <TabsTrigger key={item.value} value={item.value}>
          {item.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
