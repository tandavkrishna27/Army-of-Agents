import { useEffect, type ReactNode } from "react";
import { Bot, Network, Users, UsersRound } from "lucide-react";
import {
  SecondarySidebar,
  type SecondarySidebarSection,
} from "@/components/SecondarySidebar";
import { useSidebar } from "@/context/SidebarContext";

export type TeamSectionId = "org-tree" | "agents" | "humans" | "teams";

export interface TeamLayoutProps {
  activeSection: TeamSectionId;
  onSectionChange: (section: TeamSectionId) => void;
  children: ReactNode;
  counts?: Partial<Record<TeamSectionId, number>>;
}

const WORKFORCE_SECTIONS: Array<{
  id: Exclude<TeamSectionId, "org-tree">;
  label: string;
  icon: ReactNode;
}> = [
  { id: "agents", label: "Agents", icon: <Bot /> },
  { id: "humans", label: "Humans", icon: <Users /> },
  { id: "teams", label: "Teams", icon: <UsersRound /> },
];

export function TeamLayout({
  activeSection,
  onSectionChange,
  children,
  counts,
}: TeamLayoutProps) {
  const { isMobile, setCollapsed } = useSidebar();

  useEffect(() => {
    if (!isMobile) {
      setCollapsed(true);
    }
  }, [isMobile, setCollapsed]);

  const sections: SecondarySidebarSection[] = [
    {
      title: "Visualize",
      items: [
        {
          id: "org-tree",
          label: "Org Tree",
          icon: <Network />,
          active: activeSection === "org-tree",
          onClick: () => onSectionChange("org-tree"),
        },
      ],
    },
    {
      title: "Workforce",
      items: WORKFORCE_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        icon: section.icon,
        count: counts?.[section.id],
        active: activeSection === section.id,
        onClick: () => onSectionChange(section.id),
      })),
    },
  ];

  return (
    <div className="flex h-full min-h-0 bg-background">
      <SecondarySidebar sections={sections} className="hidden shrink-0 md:flex" />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
