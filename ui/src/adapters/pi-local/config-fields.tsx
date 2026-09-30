import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function PiLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const read = (key: string) =>
    isCreate
      ? String(values?.[key as keyof typeof values] ?? "")
      : eff("adapterConfig", key, String(config[key] ?? ""));
  const write = (key: string, value: string) =>
    isCreate ? set!({ [key]: value }) : mark("adapterConfig", key, value || undefined);

  return (
    <>
      <Field label="Model" hint="Pi model in provider/model format, for example xai/grok-4.">
        <DraftInput
          value={read("model")}
          onCommit={(v) => write("model", v)}
          immediate
          className={inputClass}
          placeholder="provider/model"
        />
      </Field>
      <Field label="Agent instructions file" hint="Absolute path to a markdown file appended to Pi's system prompt.">
        <div className="flex items-center gap-2">
          <DraftInput
            value={read("instructionsFilePath")}
            onCommit={(v) => write("instructionsFilePath", v)}
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
    </>
  );
}
