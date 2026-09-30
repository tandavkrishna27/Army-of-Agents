import type { ReactNode } from "react";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
  collapsed?: boolean;
}

export function SidebarSection({ label, children, collapsed }: SidebarSectionProps) {
  if (collapsed) {
    return (
      <div className="w-full">
        <div className="mx-auto w-8 my-1.5 border-t border-border" />
        <div className="flex flex-col gap-0.5 mt-0.5 items-center">{children}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
        {label}
      </div>
      <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
    </div>
  );
}
