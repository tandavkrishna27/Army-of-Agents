import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
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
      <Field label="Webhook URL" hint={help.webhookUrl}>
        <DraftInput
          value={read("url")}
          onCommit={(v) => write("url", v)}
          immediate
          className={inputClass}
          placeholder="https://..."
        />
      </Field>
      <Field label="Method" hint="HTTP method used when invoking the webhook. Defaults to POST.">
        <DraftInput
          value={read("method")}
          onCommit={(v) => write("method", v.toUpperCase())}
          immediate
          className={inputClass}
          placeholder="POST"
        />
      </Field>
      <Field label="Headers JSON" hint="Optional JSON object of request headers. Secret bindings should be provided through environment secrets where possible.">
        <DraftInput
          value={read("headers")}
          onCommit={(v) => write("headers", v)}
          immediate
          className={inputClass}
          placeholder='{"authorization":"Bearer ..."}'
        />
      </Field>
      <Field label="Payload template JSON" hint="Optional JSON object merged into the webhook payload before agent/run context is added.">
        <DraftInput
          value={read("payloadTemplate")}
          onCommit={(v) => write("payloadTemplate", v)}
          immediate
          className={inputClass}
          placeholder='{"source":"aoa"}'
        />
      </Field>
      <Field label="Timeout ms" hint="Optional request timeout in milliseconds. Empty means no adapter-level timeout.">
        <DraftInput
          value={read("timeoutMs")}
          onCommit={(v) => write("timeoutMs", v)}
          immediate
          className={inputClass}
          placeholder="30000"
        />
      </Field>
    </>
  );
}
