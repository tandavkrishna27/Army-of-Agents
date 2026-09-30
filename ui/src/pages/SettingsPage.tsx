import { useEffect } from "react";
import { useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import {
  SettingsLayout,
  type SettingsSectionId,
  type SettingsSectionAlias,
} from "@/components/settings/SettingsLayout";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { ArchiveCompanySection } from "@/components/settings/sections/ArchiveCompanySection";
import { BudgetCapsSection } from "@/components/settings/sections/BudgetCapsSection";
import { MCPApiKeysSection } from "@/components/settings/sections/MCPApiKeysSection";
import { MCPConnectorsSection } from "@/components/settings/sections/MCPConnectorsSection";
import { MemorySettingsSection } from "@/components/settings/sections/MemorySettingsSection";
import { PluginsSectionWrapper } from "@/components/settings/sections/PluginsSectionWrapper";
import { MarketplacePrefsSection } from "@/components/settings/sections/MarketplacePrefsSection";
import { CommanderSection } from "@/components/settings/sections/CommanderSection";
import { GitHubSection } from "@/components/settings/sections/GitHubSection";
import { ActivitySection } from "@/components/settings/sections/ActivitySection";
import { HealthSection } from "@/components/settings/sections/HealthSection";
import { EnvironmentsSectionWrapper } from "@/components/settings/sections/EnvironmentsSection";
import { SecretsSectionWrapper } from "@/components/settings/sections/SecretsSection";
import { ProvidersSection } from "@/components/settings/sections/ProvidersSection";
import { InboxSection } from "@/components/settings/sections/InboxSection";

// Accepted ?tab= input values. "llm" is retained as a legacy alias so old
// bookmarks (?tab=llm) survive and normalize to "memory" rather than silently
// falling back to General (Rev 3, finding #10).
export const VALID_SECTIONS: readonly SettingsSectionAlias[] = [
  "general", "health", "commander", "memory", "llm", "providers", "budget", "mcp", "connectors", "github", "plugins", "marketplace", "archive",
  "activity", "environments", "secrets", "inbox",
];

function isValidSection(s: string | null): s is SettingsSectionAlias {
  return s != null && (VALID_SECTIONS as readonly string[]).includes(s);
}

/** Normalize an accepted input value to its canonical section id. */
function normalizeSection(s: SettingsSectionAlias): SettingsSectionId {
  return s === "llm" ? "memory" : s;
}

function renderActiveSection(id: SettingsSectionId) {
  switch (id) {
    case "general":
      return <GeneralSection />;
    case "health":
      return <HealthSection />;
    case "commander":
      return <CommanderSection />;
    case "memory":
      return <MemorySettingsSection />;
    case "providers":
      return <ProvidersSection />;
    case "budget":
      return <BudgetCapsSection />;
    case "mcp":
      return <MCPApiKeysSection />;
    case "connectors":
      return <MCPConnectorsSection />;
    case "github":
      return <GitHubSection />;
    case "plugins":
      return <PluginsSectionWrapper />;
    case "marketplace":
      return <MarketplacePrefsSection />;
    case "archive":
      return <ArchiveCompanySection />;
    case "activity":
      return <ActivitySection />;
    case "environments":
      return <EnvironmentsSectionWrapper />;
    case "secrets":
      return <SecretsSectionWrapper />;
    case "inbox":
      return <InboxSection />;
    default: {
      const exhaustive: never = id;
      return (
        <div className="p-8">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
            Settings · {exhaustive}
          </div>
          <div className="mt-2 text-sm text-muted-foreground italic">
            Unknown section.
          </div>
        </div>
      );
    }
  }
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const tabParam = searchParams.get("tab");
  const activeSection: SettingsSectionId = isValidSection(tabParam)
    ? normalizeSection(tabParam)
    : "general";

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings" }]);
  }, [setBreadcrumbs]);

  const handleSectionChange = (id: SettingsSectionId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", id);
      // Drop sub-tab param when switching sections
      next.delete("sub");
      next.delete("section");
      return next;
    });
  };

  return (
    <SettingsLayout activeSection={activeSection} onSectionChange={handleSectionChange}>
      <h1 className="sr-only">Settings</h1>
      {renderActiveSection(activeSection)}
    </SettingsLayout>
  );
}
