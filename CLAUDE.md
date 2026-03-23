# ragent

Seamless remote Claude Code sessions. A single Bun/TypeScript binary that SSHes into a remote machine with tmux, port forwarding, and transparent file interception.

## Build & Run

```bash
bun run src/index.ts          # dev mode
bun build src/index.ts --compile --outfile ragent  # compile to binary
bun test                      # run tests
```

## Architecture

- **src/index.ts** — CLI entry point, subcommand dispatch
- **src/config.ts** — Loads `.ragent.json` (walks up directories, falls back to `~/.ragent.json`)
- **src/connect.ts** — SSH + tmux + port forwarding + reverse tunnel + auto-reconnect loop
- **src/fileserver.ts** — Local HTTP file server (Bun.serve) for transparent file fetching
- **src/status.ts** — Connection/port/tmux dashboard
- **src/push.ts** — Manual rsync file push with home dir path rewriting
- **src/setup.ts** — One-time SSH key gen + Claude Code PreToolUse hook install

## Conventions

- Use Bun-native APIs: `$` shell, `Bun.file()`, `Bun.write()`, `Bun.serve()`, `Bun.spawn()`
- Zero external dependencies — everything uses Bun builtins
- Tests use `bun:test` in `src/__tests__/`
- Config is JSON (`.ragent.json`) to match Claude Code's settings format
