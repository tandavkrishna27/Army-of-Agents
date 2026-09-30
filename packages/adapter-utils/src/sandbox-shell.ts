export function preferredShellForSandbox(shellCommand: unknown): "bash" | "sh" {
  return shellCommand === "bash" ? "bash" : "sh";
}
