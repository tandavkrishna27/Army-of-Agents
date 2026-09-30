// packages/worker-keystore/src/install/autostart.ts
//
// DSK-003 Lane C (D5/D6, I8) — per-user, unprivileged autostart manifests.
//
// D5 — "runs without administrator privileges where possible" has a concrete per-OS
// answer, and for this host it is ALWAYS. The worker needs the user's own files (the
// granted folders of DSK-002) and the user's own keychain, and no system-wide privilege
// at run time. What makes that true rather than aspirational is the choice of autostart
// mechanism, so each one here is the per-user variant:
//
//   darwin   a launchd LaunchAgent in ~/Library/LaunchAgents — NEVER a LaunchDaemon,
//            which runs as root before login and would defeat the whole claim.
//   linux    a systemd USER unit in ~/.config/systemd/user — never a system unit.
//   win32    a Task Scheduler task with InteractiveToken + LeastPrivilege — never
//            SYSTEM, and never RunLevel HighestAvailable.
//
// An installer may still need elevation to WRITE into a machine-wide location. That is an
// install-time cost, not a run-time privilege, and the two must not be conflated: the
// acceptance clause is about the host.
//
// D6 — "assert it, do not assert about it". These are file CONTENTS, so least privilege
// becomes a property a test reads directly.
//
// ESCAPING IS A SECURITY CONCERN HERE, not a formatting one. In XML and plist formats an
// unescaped `<` in an exec path does not merely corrupt the file — it closes a tag and
// opens another, which in a Task Scheduler XML is exactly how a manifest would acquire a
// RunLevel it was never meant to have. Every interpolated value goes through `xmlEscape`.
//
// No imports at all: this package's runtime dependency manifest is pinned to exactly two
// entries and checked in CI, and pure string building needs neither.

export const AUTOSTART_PLATFORMS = ["darwin", "linux", "win32"] as const;
export type AutostartPlatform = (typeof AUTOSTART_PLATFORMS)[number];

export interface AutostartManifestInput {
  readonly platform: AutostartPlatform;
  /** Absolute path to the installed host binary. */
  readonly execPath: string;
  /** Reverse-DNS style identifier, e.g. `com.aoa.worker-desktop`. */
  readonly label: string;
  /**
   * The installing user's home directory, used to resolve the log destination.
   *
   * OPTIONAL: with none supplied the darwin agent emits no redirection keys at all,
   * because half a path is worse than none — launchd would create a file wherever it
   * resolved a relative string, which is not somewhere anyone will look.
   */
  readonly homeDir?: string;
}

export interface AutostartManifest {
  /** The file name the manifest is written as. */
  readonly filename: string;
  /** Where it belongs, RELATIVE TO THE USER'S HOME — never an absolute system path. */
  readonly installPathRelativeToHome: string;
  readonly contents: string;
}

export class AutostartManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutostartManifestError";
  }
}

/**
 * Where this platform's host should write its output, RELATIVE TO HOME — or `null` when
 * the platform already has a better answer.
 *
 * `null` for linux is a decision, not an omission. systemd captures stdout to the journal
 * already; adding a file would bypass journald's rotation, retention and access control
 * and split one host's output across two places. `journalctl --user` is the answer there.
 */
export function autostartLogPath(platform: AutostartPlatform, label: string): string | null {
  if (platform === "darwin") return `Library/Logs/${label}.log`;
  if (platform === "win32") return `AoA/${label}.log`;
  return null; // linux → journald
}

/** Escape the five XML metacharacters. Applied to EVERY interpolated value. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** True if `value` holds any C0 control character or DEL.
 *
 * Written as a char-code scan rather than a regex ON PURPOSE. The regex form needs
 * escape sequences, and an earlier draft of this guard shipped with RAW control bytes
 * where the escapes were meant — a guard that compiled, read correctly, and matched
 * nothing. DSK-001 hit the identical failure with a backspace byte in place of a word
 * boundary. A comparison on charCodeAt has no escaping surface to get wrong. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An exec path must be present, absolute, and free of control characters.
 *
 * Absolute: a relative path resolves against whatever directory the service manager
 * happens to start in, which is not a decision to leave to chance for a binary holding a
 * device identity.
 *
 * NO CONTROL CHARACTERS, and this is the security half. `xmlEscape` protects the plist
 * and the Task Scheduler manifest, but a systemd unit is INI-like and NOT XML — escaping
 * would be actively wrong there, since systemd reads the raw path. What injects into an
 * INI file is a NEWLINE: an exec path containing one closes `ExecStart=` and opens a
 * fresh directive, and `User=root` on that line is precisely the elevation this module
 * exists to make impossible. Rejected for every platform, because a path carrying a
 * control character is pathological whatever the format. */
function assertExecPath(execPath: string): void {
  const trimmed = execPath.trim();
  if (trimmed.length === 0) {
    throw new AutostartManifestError("autostart exec path must not be empty");
  }
  if (hasControlCharacter(trimmed)) {
    throw new AutostartManifestError(
      "autostart exec path must not contain control characters (a newline injects a directive)",
    );
  }
  const isAbsolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isAbsolute) {
    throw new AutostartManifestError(`autostart exec path must be absolute: ${trimmed}`);
  }
}

/**
 * Drop trailing `/` and `\` so a home directory joins cleanly.
 *
 * Written as a character scan rather than a regex, for the same reason
 * `hasControlCharacter` is: a character class needing an escaped backslash is exactly the
 * kind of literal that survives one round of string handling and not the next. A first
 * draft of this lost a backslash in transit and silently stopped trimming `\`.
 */
function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch !== "/" && ch !== "\\") break;
    end -= 1;
  }
  return value.slice(0, end);
}

/** systemd expands `%` specifiers (`%h` is the user's home); doubling escapes them. */
function systemdEscape(value: string): string {
  return value.replace(/%/g, "%%");
}

/**
 * Build the per-user autostart manifest for one platform.
 *
 * Throws on an unsupported platform rather than emitting a generic file — a manifest that
 * silently did nothing would present as "autostart configured" while the host never runs.
 */
export function buildAutostartManifest(input: AutostartManifestInput): AutostartManifest {
  assertExecPath(input.execPath);
  // The home directory is interpolated into the same XML, so it carries the same
  // injection surface as the exec path and gets the same guard.
  if (input.homeDir !== undefined) assertExecPath(input.homeDir);
  const exec = xmlEscape(input.execPath.trim());
  const label = xmlEscape(input.label);

  // Emitted ONLY when a home directory is known — see the `homeDir` doc.
  const logRelative = autostartLogPath(input.platform, input.label);
  const logAbsolute =
    input.homeDir !== undefined && logRelative !== null
      ? xmlEscape(`${stripTrailingSeparators(input.homeDir.trim())}/${logRelative}`)
      : null;

  if (input.platform === "darwin") {
    const filename = `${input.label}.plist`;
    return {
      filename,
      // LaunchAgents, not LaunchDaemons: a LaunchAgent runs as the logged-in user.
      installPathRelativeToHome: `Library/LaunchAgents/${filename}`,
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${
    logAbsolute === null
      ? ""
      : `
  <key>StandardOutPath</key>
  <string>${logAbsolute}</string>
  <key>StandardErrorPath</key>
  <string>${logAbsolute}</string>`
  }
  <!-- No UserName key: a LaunchAgent runs as the logged-in user by construction. -->
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`,
    };
  }

  if (input.platform === "linux") {
    const filename = `${input.label}.service`;
    return {
      filename,
      // A systemd USER unit; `systemctl --user` never touches the system manager.
      installPathRelativeToHome: `.config/systemd/user/${filename}`,
      // NOT XML: `xmlEscape` would be actively wrong here, because systemd reads the raw
      // path. This format's injection vector is a NEWLINE, which `assertExecPath` rejects
      // outright, plus `%` specifier expansion, which `systemdEscape` doubles.
      contents: `[Unit]
Description=AoA worker desktop host
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdEscape(input.execPath.trim())}
Restart=on-failure
RestartSec=5
# No User= directive: a --user unit runs as the invoking user by construction, and
# naming root here is exactly the mistake this file exists to make impossible.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`,
    };
  }

  if (input.platform === "win32") {
    const filename = `${input.label}.xml`;
    return {
      filename,
      installPathRelativeToHome: `AoA/${filename}`,
      contents: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${label}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${exec}</Command>
    </Exec>
  </Actions>
</Task>
`,
    };
  }

  throw new AutostartManifestError(
    `unsupported autostart platform: ${JSON.stringify(input.platform)}`,
  );
}
