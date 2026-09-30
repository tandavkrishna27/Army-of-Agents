import { PluginsSection } from "@/components/settings/PluginsSection";

export function PluginsSectionWrapper() {
  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Extensions
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Plugins<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Installed plugins, capability consent, and runtime status.
        </p>
      </div>
      <div className="p-8">
        <PluginsSection />
      </div>
    </div>
  );
}
