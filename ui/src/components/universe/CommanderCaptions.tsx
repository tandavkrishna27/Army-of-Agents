/** Latest caption only; the full reconciled transcript lives in chat history
 * (E1.5/2). Selectable text; captions=false hides just this. Below-blob falls
 * back to bottom-center when the blob is hidden. */
export type CaptionPlacement = "above-compact" | "bottom-center" | "below-blob";

export function CommanderCaptions({
  text,
  placement = "above-compact",
}: {
  text?: string;
  placement?: CaptionPlacement;
}) {
  if (!text) return null;
  return (
    <p className="universe-commander-captions" data-placement={placement}>
      {text}
    </p>
  );
}
