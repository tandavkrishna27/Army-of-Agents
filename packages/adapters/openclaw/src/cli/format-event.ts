import pc from "picocolors";

export function printOpenClawStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    console.log(line);
    return;
  }

  if (line.startsWith("[openclaw]")) {
    console.log(pc.cyan(line));
    return;
  }

  console.log(pc.gray(line));
}
