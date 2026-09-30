import { CAPABILITY_DESCRIPTIONS } from "@armyofagents/shared";
import type { PluginCapability } from "@armyofagents/shared";

interface Props {
  pluginName: string;
  capabilities: PluginCapability[];
  agreed: boolean;
  onAgreedChange: (agreed: boolean) => void;
}

export function CapabilityConsentStep({ pluginName, capabilities, agreed, onAgreedChange }: Props) {
  if (capabilities.length === 0) {
    return (
      <p className="text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">{pluginName}</span> requests no special
        permissions.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-zinc-400 mb-2">
          <span className="font-semibold text-zinc-200">{pluginName}</span> requests the following
          permissions:
        </p>
        <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {capabilities.map((cap) => (
            <li key={cap} className="flex items-start gap-2">
              <span className="mt-0.5 text-amber-400 shrink-0">•</span>
              <div>
                <div className="text-xs font-mono text-zinc-500">{cap}</div>
                <div className="text-xs text-zinc-300">
                  {CAPABILITY_DESCRIPTIONS[cap] ?? cap}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onAgreedChange(e.target.checked)}
          className="mt-0.5 accent-indigo-500"
        />
        <span className="text-xs text-zinc-400">
          I understand and agree to grant these permissions to{" "}
          <span className="text-zinc-200 font-semibold">{pluginName}</span>.
        </span>
      </label>
    </div>
  );
}
