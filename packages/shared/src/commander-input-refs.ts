import { z } from "zod";

export const COMMANDER_INPUT_REF_KINDS = [
  "task",
  "discussion",
  "inbox",
  "approval",
  "artifact",
  "asset",
  "goal",
  "agent",
  "note",
] as const;

export type CommanderInputRefKind = (typeof COMMANDER_INPUT_REF_KINDS)[number];

export const MAX_COMMANDER_INPUT_REFS = 12;
export const MAX_COMMANDER_INPUT_REF_LABEL_LENGTH = 160;
export const MAX_COMMANDER_INPUT_REF_DETAIL_LENGTH = 500;

export interface CommanderInputRef {
  v: 1;
  kind: CommanderInputRefKind;
  id: string;
  label: string;
  route?: string | null;
  detail?: string | null;
  source?: string | null;
}

export interface AppendCommanderInputRefResult {
  refs: CommanderInputRef[];
  added: boolean;
  existingKey?: string;
}

export interface CommanderInputRefDragPayload {
  type: typeof COMMANDER_INPUT_REF_DRAG_MIME;
  ref: CommanderInputRef;
  prompt?: string;
}

export const COMMANDER_INPUT_REF_DRAG_MIME = "application/x-aoa-commander-ref";

export const commanderInputRefSchema = z.object({
  v: z.literal(1),
  kind: z.enum(COMMANDER_INPUT_REF_KINDS),
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(MAX_COMMANDER_INPUT_REF_LABEL_LENGTH),
  route: z.string().min(1).max(500).nullish(),
  detail: z.string().max(MAX_COMMANDER_INPUT_REF_DETAIL_LENGTH).nullish(),
  source: z.string().min(1).max(120).nullish(),
});

export const commanderInputRefsSchema = z
  .array(commanderInputRefSchema)
  .max(MAX_COMMANDER_INPUT_REFS);

commanderInputRefSchema satisfies z.ZodType<CommanderInputRef>;

export function commanderInputRefKey(ref: Pick<CommanderInputRef, "kind" | "id">): string {
  return `${ref.kind}:${ref.id}`;
}

export function commanderInputRefKindLabel(kind: CommanderInputRefKind): string {
  switch (kind) {
    case "task":
      return "Task";
    case "discussion":
      return "Discussion";
    case "inbox":
      return "Inbox";
    case "approval":
      return "Approval";
    case "artifact":
      return "Artifact";
    case "asset":
      return "File";
    case "goal":
      return "Goal";
    case "agent":
      return "Agent";
    case "note":
      return "Note";
  }
}

export function appendCommanderInputRef(
  refs: readonly CommanderInputRef[],
  ref: CommanderInputRef,
): AppendCommanderInputRefResult {
  const key = commanderInputRefKey(ref);
  if (refs.some((item) => commanderInputRefKey(item) === key)) {
    return { refs: [...refs], added: false, existingKey: key };
  }
  return {
    refs: [...refs, ref].slice(-MAX_COMMANDER_INPUT_REFS),
    added: true,
  };
}

export function encodeCommanderInputRefDragPayload(
  ref: CommanderInputRef,
  prompt?: string,
): string {
  return JSON.stringify({
    type: COMMANDER_INPUT_REF_DRAG_MIME,
    ref,
    ...(prompt ? { prompt } : {}),
  } satisfies CommanderInputRefDragPayload);
}

export function parseCommanderInputRefDragPayload(
  raw: string,
): { ref: CommanderInputRef; prompt?: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const payload = z
      .object({
        type: z.literal(COMMANDER_INPUT_REF_DRAG_MIME),
        ref: commanderInputRefSchema,
        prompt: z.string().min(1).max(1000).optional(),
      })
      .safeParse(parsed);
    if (!payload.success) return null;
    return {
      ref: payload.data.ref,
      ...(payload.data.prompt ? { prompt: payload.data.prompt } : {}),
    };
  } catch {
    return null;
  }
}

export function formatCommanderInputRefsBlock(refs: readonly CommanderInputRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.slice(0, MAX_COMMANDER_INPUT_REFS).map((ref) => {
    const parts = [
      `${commanderInputRefKindLabel(ref.kind)}: ${ref.label}`,
      `id=${ref.id}`,
      ref.route ? `route=${ref.route}` : null,
      ref.source ? `source=${ref.source}` : null,
      ref.detail ? `detail=${ref.detail}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join(" | ")}`;
  });
  return `Referenced context:\n${lines.join("\n")}`;
}

export function appendCommanderInputRefsToMessage(
  message: string,
  refs: readonly CommanderInputRef[],
): string {
  const refBlock = formatCommanderInputRefsBlock(refs);
  if (!refBlock) return message;
  return `${message.trim()}\n\n${refBlock}`.trim();
}
