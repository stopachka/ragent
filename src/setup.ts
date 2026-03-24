import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type RagentConfig,
  configPath,
  defaultRemoteDir,
  parseHost,
  sshSocketPath,
} from "./config.ts";

/**
 * Generate the dynamic hook script that reads port from a runtime file.
 */
function generateHookScript(localUser: string, remoteUser: string): string {
  return `#!/usr/bin/env bash
# ragent: Claude Code PreToolUse hook for transparent file fetching
# Fetches missing files from the local machine via reverse SSH tunnel
# Uses updatedInput to redirect Claude to a local cache path

set -euo pipefail

CACHE_DIR="$HOME/.cache/ragent/files"

# Read the file server port (written by ragent on connect)
PORT_FILE="$HOME/.config/ragent/port"
if [ ! -f "$PORT_FILE" ]; then
  exit 0
fi
PORT=$(cat "$PORT_FILE")
if [ -z "$PORT" ]; then
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')

if [ "$TOOL_NAME" != "Read" ]; then
  exit 0
fi

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# If the file exists locally, nothing to do
if [ -f "$FILE_PATH" ]; then
  exit 0
fi

# Fetch from local machine via reverse tunnel
ENCODED_PATH=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$FILE_PATH" 2>/dev/null || exit 0)

TMPFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" "http://127.0.0.1:$PORT/fetch?path=$ENCODED_PATH" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  mkdir -p "$CACHE_DIR"
  BASENAME=$(basename "$FILE_PATH")
  UUID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo $$)
  CACHED="$CACHE_DIR/\${UUID}-\${BASENAME}"
  mv "$TMPFILE" "$CACHED"
  cat <<ENDJSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"file_path":"$CACHED"}}}
ENDJSON
else
  rm -f "$TMPFILE"
fi

exit 0
`;
}

/**
 * Install the hook script and Claude settings on the remote.
 */
async function installHook(
  config: RagentConfig,
  socket: string,
): Promise<boolean> {
  const { user: remoteUser } = parseHost(config.host);
  const localUser = process.env.USER ?? "unknown";
  const script = generateHookScript(localUser, remoteUser);

  // Create remote dirs
  const mkdirProc = Bun.spawn(
    [
      "ssh", "-o", `ControlPath=${socket}`,
      config.host,
      "mkdir -p ~/.config/ragent ~/.claude",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );

  if ((await mkdirProc.exited) !== 0) {
    console.error("Failed to create remote directories");
    return false;
  }

  // Write hook script via stdin pipe
  const writeProc = Bun.spawn(
    [
      "ssh",
      "-o", `ControlPath=${socket}`,
      config.host,
      "cat > $HOME/.config/ragent/fetch-file.sh && chmod +x $HOME/.config/ragent/fetch-file.sh",
    ],
    {
      stdin: new TextEncoder().encode(script),
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if ((await writeProc.exited) !== 0) {
    console.error("Failed to write hook script to remote");
    return false;
  }

  // Merge hook into remote ~/.claude/settings.json (migrates old format automatically)
  const mergeScript = `
    SETTINGS_FILE="$HOME/.claude/settings.json"
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo '{}' > "$SETTINGS_FILE"
    fi

    python3 -c "
import json, sys
settings_path = '$SETTINGS_FILE'
with open(settings_path) as f:
    settings = json.load(f)
if 'hooks' not in settings:
    settings['hooks'] = {}
if 'PreToolUse' not in settings['hooks']:
    settings['hooks']['PreToolUse'] = []

new_hook = {'matcher': 'Read', 'hooks': [{'type': 'command', 'command': 'bash ~/.config/ragent/fetch-file.sh'}]}
hooks = settings['hooks']['PreToolUse']
migrated = False

for i, h in enumerate(hooks):
    # Old format: {'matcher': ..., 'command': '...ragent...'}
    if 'ragent' in h.get('command', '') and 'hooks' not in h:
        hooks[i] = new_hook
        migrated = True
        break
    # New format already present
    for inner in h.get('hooks', []):
        if 'ragent' in inner.get('command', ''):
            print('Hook already installed')
            sys.exit(0)

if migrated:
    print('Hook migrated to new format')
else:
    hooks.append(new_hook)
    print('Hook installed')

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
"
  `;

  const mergeProc = Bun.spawn(
    [
      "ssh", "-o", `ControlPath=${socket}`,
      config.host,
      mergeScript,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );

  return (await mergeProc.exited) === 0;
}

async function remoteExec(
  host: string,
  socket: string,
  cmd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(
    ["ssh", "-o", `ControlPath=${socket}`, host, `bash -lc ${shellQuote(cmd)}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout: stdout.trim() };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function prompt(question: string): Promise<boolean> {
  process.stdout.write(`${question} [Y/n] `);
  return new Promise((resolve) => {
    const buf = Buffer.alloc(256);
    const fd = require("node:fs").openSync("/dev/tty", "r");
    const n = require("node:fs").readSync(fd, buf);
    require("node:fs").closeSync(fd);
    const answer = buf.slice(0, n).toString().trim().toLowerCase();
    resolve(answer === "" || answer === "y" || answer === "yes");
  });
}

async function installPrereqs(
  config: RagentConfig,
  socket: string,
): Promise<void> {
  const prereqs: { name: string; check: string; install: string }[] = [
    {
      name: "Homebrew",
      check: "command -v brew",
      install:
        'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    },
    {
      name: "tmux",
      check: "command -v tmux",
      install: "brew install tmux",
    },
    {
      name: "Node.js",
      check: "command -v node",
      install: "brew install node",
    },
    {
      name: "Claude Code",
      check: "test -x $HOME/.local/bin/claude",
      install: "curl -fsSL https://cli.claude.ai/install.sh | sh",
    },
  ];

  for (const dep of prereqs) {
    const { exitCode } = await remoteExec(config.host, socket, dep.check);
    if (exitCode === 0) {
      console.log(`  ✓ ${dep.name}`);
    } else {
      const yes = await prompt(`  ✗ ${dep.name} not found. Install?`);
      if (yes) {
        const installProc = Bun.spawn(
          [
            "ssh", "-t", "-o", `ControlPath=${socket}`,
            config.host,
            dep.install,
          ],
          { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
        );
        if ((await installProc.exited) !== 0) {
          console.error(`    Failed to install ${dep.name}. Continuing...`);
        } else {
          console.log(`    ${dep.name} installed.`);
        }
      } else {
        console.log(`    Skipped ${dep.name}.`);
      }
    }
  }
}

async function promptInput(question: string): Promise<string> {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  const fd = require("node:fs").openSync("/dev/tty", "r");
  const n = require("node:fs").readSync(fd, buf);
  require("node:fs").closeSync(fd);
  return buf.slice(0, n).toString().trim();
}

/**
 * One-time setup:
 * 0. Create .ragent.json if it doesn't exist
 * 1. Generate SSH key if needed
 * 2. Copy key to remote
 * 3. Install Claude Code hook on remote
 * 4. Install remote prerequisites
 */
export async function setup(config?: RagentConfig): Promise<void> {
  // Step 0: Create config if needed
  if (!config) {
    const cfgPath = configPath();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(cfgPath), { recursive: true });

    const host = await promptInput("Remote host (user@hostname): ");
    if (!host) {
      console.error("Host is required.");
      process.exit(1);
    }

    const remoteDir = defaultRemoteDir(process.cwd());
    const portsRaw = await promptInput(
      `Ports to forward for ${remoteDir} (comma-separated, or empty): `,
    );
    const ports = portsRaw
      ? portsRaw.split(",").map((p) => p.trim()).filter(Boolean)
      : [];

    const fileConfig: Record<string, unknown> = { host };
    if (ports.length > 0) {
      fileConfig.paths = { [remoteDir]: { ports } };
    }

    await Bun.write(cfgPath, JSON.stringify(fileConfig, null, 2) + "\n");
    console.log(`Created ${cfgPath}\n`);

    const { loadConfig } = await import("./config.ts");
    config = await loadConfig();
  }

  const home = homedir();
  const keyPath = join(home, ".ssh", "id_ed25519");
  const socket = sshSocketPath(config.session);

  // Step 1: SSH key
  console.log("--- SSH Key ---");
  if (!(await Bun.file(keyPath).exists())) {
    console.log("Generating SSH key...");
    const keygen = Bun.spawn(
      ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", ""],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await keygen.exited) !== 0) {
      console.error("Failed to generate SSH key");
      process.exit(1);
    }
  } else {
    console.log(`SSH key exists: ${keyPath}`);
  }

  // Step 2: Copy key to remote
  console.log("\n--- Copy SSH Key ---");
  console.log(`Copying key to ${config.host}...`);
  const { exitCode: copyExit } =
    await $`ssh-copy-id -i ${keyPath}.pub ${config.host}`.nothrow();

  if (copyExit !== 0) {
    console.error("Failed to copy SSH key. Is SSH enabled on the remote?");
    console.error(
      "  macOS: System Settings → General → Sharing → Remote Login → ON",
    );
    process.exit(1);
  }

  // Step 3: Establish ControlMaster for subsequent commands (reuse existing if present)
  console.log("\n--- Establishing connection ---");
  await $`ssh -o ControlMaster=auto -o ControlPath=${socket} -o ControlPersist=300 ${config.host} ${{
    raw: "echo 'Connection established'",
  }}`;

  // Step 4: Install Claude Code hook
  console.log("\n--- Claude Code Hook ---");
  const hookInstalled = await installHook(config, socket);

  if (hookInstalled) {
    console.log("Claude Code hook installed.");
  } else {
    console.error("Failed to install Claude Code hook.");
  }

  // Step 5: Check and install remote prerequisites
  console.log("\n--- Remote Prerequisites ---");
  await installPrereqs(config, socket);

  // Clean up ControlMaster
  await $`ssh -O exit -o ControlPath=${socket} ${config.host}`.nothrow().quiet();

  console.log("\n--- Setup Complete ---");
  console.log("Connecting...\n");

  // Auto-connect
  const { connect } = await import("./connect.ts");
  await connect(config);
}
