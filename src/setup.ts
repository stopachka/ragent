import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RagentConfig, parseHost, sshSocketPath } from "./config.ts";

/**
 * Generate the dynamic hook script that reads port from a runtime file.
 */
function generateHookScript(localUser: string, remoteUser: string): string {
  return `#!/usr/bin/env bash
# ragent: Claude Code PreToolUse hook for transparent file fetching
# Fetches missing files from the local machine via reverse SSH tunnel

set -euo pipefail

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

# Rewrite path: /Users/localUser/... -> /Users/remoteUser/...
REMOTE_PATH=$(echo "$FILE_PATH" | sed "s|/Users/${localUser}/|/Users/${remoteUser}/|")

# If file already exists, nothing to do
if [ -f "$REMOTE_PATH" ]; then
  exit 0
fi
if [ -f "$FILE_PATH" ]; then
  exit 0
fi

# Fetch from local machine via reverse tunnel
ENCODED_PATH=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$FILE_PATH" 2>/dev/null || exit 0)

TMPFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" "http://127.0.0.1:$PORT/fetch?path=$ENCODED_PATH" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  mkdir -p "$(dirname "$REMOTE_PATH")"
  mv "$TMPFILE" "$REMOTE_PATH"
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
  const { exitCode: mkdirExit } =
    await $`ssh -o ControlPath=${socket} ${config.host} ${{
      raw: "mkdir -p ~/.config/ragent ~/.claude",
    }}`.nothrow();

  if (mkdirExit !== 0) {
    console.error("Failed to create remote directories");
    return false;
  }

  // Write hook script via stdin pipe
  const writeProc = Bun.spawn(
    [
      "ssh",
      "-o", `ControlPath=${socket}`,
      config.host,
      "cat > ~/.config/ragent/fetch-file.sh && chmod +x ~/.config/ragent/fetch-file.sh",
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

  // Merge hook into remote ~/.claude/settings.json
  const mergeScript = `
    SETTINGS_FILE="$HOME/.claude/settings.json"
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo '{}' > "$SETTINGS_FILE"
    fi

    if grep -q "ragent/fetch-file.sh" "$SETTINGS_FILE" 2>/dev/null; then
      echo "Hook already installed"
      exit 0
    fi

    python3 -c "
import json
settings_path = '$SETTINGS_FILE'
with open(settings_path) as f:
    settings = json.load(f)
if 'hooks' not in settings:
    settings['hooks'] = {}
if 'PreToolUse' not in settings['hooks']:
    settings['hooks']['PreToolUse'] = []
for h in settings['hooks']['PreToolUse']:
    if 'ragent' in h.get('command', ''):
        print('Hook already installed')
        exit(0)
settings['hooks']['PreToolUse'].append({'matcher': 'Read', 'command': 'bash ~/.config/ragent/fetch-file.sh'})
with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
print('Hook installed')
"
  `;

  const { exitCode: mergeExit } =
    await $`ssh -o ControlPath=${socket} ${config.host} ${mergeScript}`.nothrow();

  return mergeExit === 0;
}

/**
 * One-time setup:
 * 1. Generate SSH key if needed
 * 2. Copy key to remote
 * 3. Install Claude Code hook on remote
 */
export async function setup(config: RagentConfig): Promise<void> {
  const home = homedir();
  const keyPath = join(home, ".ssh", "id_ed25519");
  const socket = sshSocketPath();

  // Step 1: SSH key
  console.log("--- SSH Key ---");
  if (!(await Bun.file(keyPath).exists())) {
    console.log("Generating SSH key...");
    await $`ssh-keygen -t ed25519 -f ${keyPath} -N ""`;
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

  // Step 3: Establish ControlMaster for subsequent commands
  console.log("\n--- Establishing connection ---");
  await $`ssh -o ControlMaster=yes -o ControlPath=${socket} -o ControlPersist=300 ${config.host} ${{
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

  // Step 5: Print remote prereqs
  console.log("\n--- Remote Prerequisites ---");
  console.log("Make sure the following are installed on the remote:");
  console.log("  1. tmux:       brew install tmux");
  console.log("  2. Claude Code: npm install -g @anthropic-ai/claude-code");
  console.log("  3. Authenticate: run 'claude' once on the remote");

  console.log("\n--- Setup Complete ---");
  console.log("Run `ragent` to connect!");

  // Clean up ControlMaster
  await $`ssh -O exit -o ControlPath=${socket} ${config.host}`.nothrow().quiet();
}
