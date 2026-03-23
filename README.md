# ragent

Seamless remote AI coding sessions. SSH into a remote machine with tmux, port forwarding, auto-reconnect, and transparent file interception — so pasted images just work.

## Install

```bash
# From source
git clone https://github.com/stopachka/ragent.git
cd ragent
bun build src/index.ts --compile --outfile ragent
cp ragent ~/.local/bin/
```

Requires [Bun](https://bun.sh) to build. The compiled binary has no runtime dependencies.

## Quick Start

```bash
# 1. Create config in your project
cd ~/projects/myapp
ragent init
# Edit .ragent.json with your remote host

# 2. One-time setup (SSH key + Claude Code hook)
ragent setup

# 3. Connect
ragent
# You're now in tmux on the remote. Ports forwarded. Auto-reconnect on.
```

## Config

Place a `.ragent.json` in your project directory:

```json
{
  "host": "user@hostname",
  "dir": "~/projects/myapp",
  "session": "myapp",
  "ports": ["3000", "4000", "8888"]
}
```

Only `host` is required. Everything else has smart defaults:

| Field | Default | Description |
|-------|---------|-------------|
| `host` | — | SSH destination (required). Any reachable host. |
| `dir` | mirrors local path | Remote working directory |
| `session` | directory name | tmux session name |
| `ports` | none | Ports to forward (local:remote or just port) |

Config lookup: `.ragent.json` in cwd → walk up parent dirs → `~/.ragent.json` (global fallback).

## Commands

| Command | Description |
|---------|-------------|
| `ragent` | Connect with auto-reconnect |
| `ragent status` | Show connection, ports, tmux sessions |
| `ragent push <file>` | Push a file to the same path on remote |
| `ragent run <cmd>` | Run a command on the remote |
| `ragent init` | Create `.ragent.json` in current directory |
| `ragent setup` | One-time: SSH key + Claude Code hook install |
| `ragent disconnect` | Tear down SSH connection |

## How It Works

### Connection
`ragent` opens an SSH connection with tmux, ControlMaster (for fast reconnects), and port forwarding. If the connection drops, it automatically reconnects in 3 seconds. Your tmux session persists on the remote through any disconnection.

### File Interception
When Claude Code on the remote tries to read a file that doesn't exist (e.g. an image you pasted from your laptop), a PreToolUse hook fetches it transparently:

1. `ragent` runs a local HTTP file server and sets up a reverse SSH tunnel
2. A Claude Code hook on the remote intercepts `Read` tool calls
3. If the file is missing, the hook fetches it from your laptop through the tunnel
4. The file is written to the remote filesystem and the Read succeeds

### Auto-Reconnect
Close your laptop, lose WiFi, whatever — `ragent` detects the SSH drop and reconnects automatically. Your tmux session on the remote is untouched.

## Remote Prerequisites

1. SSH enabled (macOS: System Settings → General → Sharing → Remote Login)
2. `tmux` installed (`brew install tmux`)
3. Claude Code installed and authenticated

## Development

```bash
bun run src/index.ts    # run without compiling
bun test                # run tests
bun build src/index.ts --compile --outfile ragent  # build binary
```
