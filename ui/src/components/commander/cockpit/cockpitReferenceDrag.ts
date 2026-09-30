import {
  COMMANDER_INPUT_REF_DRAG_MIME,
  encodeCommanderInputRefDragPayload,
  type CommanderInputRef,
} from "@armyofagents/shared";

export function setCommanderRefDragData(
  dataTransfer: DataTransfer,
  ref: CommanderInputRef,
  prompt?: string,
) {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(
    COMMANDER_INPUT_REF_DRAG_MIME,
    encodeCommanderInputRefDragPayload(ref, prompt),
  );
}
