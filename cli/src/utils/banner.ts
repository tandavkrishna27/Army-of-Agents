import pc from "picocolors";

const AOA_ART = [
  " █████╗  ██████╗  █████╗ ",
  "██╔══██╗██╔═══██╗██╔══██╗",
  "███████║██║   ██║███████║",
  "██╔══██║██║   ██║██╔══██║",
  "██║  ██║╚██████╔╝██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
] as const;

const TAGLINE = "Army of Agents — open-source orchestration for zero-human companies";

export function printAoaCliBanner(): void {
  const lines = [
    "",
    ...AOA_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
