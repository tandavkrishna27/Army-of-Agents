import type { UniversePreferences } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { useUniversePreferences } from "@/hooks/useUniversePreferences";

type SelectField = keyof Pick<UniversePreferences, "theme"|"density"|"motion"|"accent"|"blobStyle"|"blobColor"|"grid"|"dockHiding"|"commanderPlacement"|"conversationPresentation"|"blobVisibility"|"chatVisibility"|"captions"|"captionSize"|"captionPlacement"|"restoreWorkspace"|"openPanelPreviews"|"attentionPreviews"|"arrangement">;
const OPTIONS: Record<SelectField, readonly string[]> = {
  theme:["inherit","system","light","dark"], density:["comfortable","compact"], motion:["subtle","full","reduced"],
  accent:["brand_red","teal","indigo","amber"], blobStyle:["fluid","orbital_rings","minimal_glow"], blobColor:["match_accent","brand_red","teal","indigo","amber"],
  grid:["dots","lines","none"], dockHiding:["always","auto_hide"], commanderPlacement:["automatic","manual"], conversationPresentation:["compact","expanded"],
  blobVisibility:["shown","hidden"], chatVisibility:["shown","tucked"], captions:["visible","hidden"], captionSize:["standard","large"],
  captionPlacement:["bottom_center","below_blob"], restoreWorkspace:["previous","overview"], openPanelPreviews:["auto","always","hidden"],
  attentionPreviews:["auto","always","hidden"], arrangement:["assisted","manual"],
};
const APPEARANCE: SelectField[] = ["theme","density","motion","accent","blobStyle","blobColor","grid"];
const WORKSPACE: SelectField[] = ["dockHiding","commanderPlacement","conversationPresentation","blobVisibility","chatVisibility","captions","captionSize","captionPlacement","restoreWorkspace","openPanelPreviews","attentionPreviews","arrangement"];
const label = (value: string) => value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());

export function UniverseSection() {
  const { selectedCompanyId } = useCompany();
  const preferences = useUniversePreferences(selectedCompanyId);
  if (preferences.status === "loading") return <p role="status">Loading Universe preferences…</p>;
  if (!preferences.snapshot) return <p role="alert">Universe preferences are unavailable.</p>;
  const effective = { ...preferences.snapshot.effective, ...preferences.draft };
  const section = (title: string, fields: SelectField[]) => <fieldset className="grid gap-4 rounded-lg border border-border p-4">
    <legend className="px-2 text-sm font-semibold">{title}</legend>
    {fields.map(field => <label key={field} className="grid gap-1 text-sm"><span>{label(field)}</span>
      <select value={String(effective[field])} onChange={event => preferences.edit({[field]: event.target.value} as never)} className="h-9 rounded-md border border-border bg-background px-2">
        {OPTIONS[field].map(value => <option key={value} value={value}>{label(value)}</option>)}
      </select></label>)}
    {title === "Appearance" && <label className="grid gap-1 text-sm"><span>Grid intensity</span><input aria-label="Grid intensity" type="range" min="0" max="0.3" step="0.05" value={effective.gridIntensity} onChange={event => preferences.edit({gridIntensity:Number(event.target.value)})}/></label>}
    {title === "Workspace" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={effective.snapToGrid} onChange={event => preferences.edit({snapToGrid:event.target.checked})}/>Snap to grid</label>}
    <button type="button" onClick={() => void preferences.reset(title === "Appearance" ? "appearance" : "workspace")} className="justify-self-start rounded-md border border-border px-3 py-2">Reset {title.toLowerCase()}</button>
  </fieldset>;
  return <div className="mx-auto grid max-w-3xl gap-5 p-6"><div><h2 className="text-lg font-semibold">Universe</h2><p className="text-sm text-muted-foreground">Personal appearance and workspace behavior. Reset never removes panels, drafts, conversations, or artifacts.</p></div>
    {section("Appearance", APPEARANCE)}{section("Workspace", WORKSPACE)}
    <fieldset className="grid gap-4 rounded-lg border border-border p-4"><legend className="px-2 text-sm font-semibold">Attention presentation</legend>
      <p className="text-sm text-muted-foreground">These choices can make shared Inbox policy quieter. Enable notification channels and quiet hours in Inbox settings.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={effective.soundEffects} onChange={event=>preferences.edit({soundEffects:event.target.checked})}/>Allow attention sounds when Inbox policy permits</label>
      <label className="grid gap-1 text-sm"><span>Spoken announcements</span><select value={effective.spokenAnnouncements} onChange={event=>preferences.edit({spokenAnnouncements:event.target.value as "inherit"|"quieter"})} className="h-9 rounded-md border border-border bg-background px-2"><option value="inherit">Follow Inbox policy</option><option value="quieter">Quieter — suppress unsolicited speech</option></select></label>
      <button type="button" onClick={()=>void preferences.reset("voice")} className="justify-self-start rounded-md border border-border px-3 py-2">Reset attention presentation</button>
    </fieldset>
    {preferences.status === "conflict" && <div role="alert">Preferences changed elsewhere. <button type="button" onClick={() => preferences.acceptLatest()}>Use latest</button></div>}
    {preferences.error && preferences.status !== "conflict" && <p role="alert">{preferences.error instanceof Error ? preferences.error.message : "Could not save preferences."}</p>}
    <div className="sticky bottom-0 flex justify-end gap-2 bg-background/95 py-3"><button type="button" disabled={!Object.keys(preferences.draft).length} onClick={preferences.discard} className="rounded-md border border-border px-4 py-2">Discard</button><button type="button" disabled={!Object.keys(preferences.draft).length || preferences.status === "saving"} onClick={() => void preferences.patch()} className="rounded-md bg-brand px-4 py-2 text-white">Save</button></div>
  </div>;
}
