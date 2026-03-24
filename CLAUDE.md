# ragent

Seamless remote Claude Code sessions. A single Bun/TypeScript binary that SSHes into a remote machine with tmux, port forwarding, and transparent file interception.

## Build & Run

```bash
bun run src/index.ts          # dev mode
bun run build                 # compile to binary + copy to ~/.local/bin/
bun test                      # run tests
```

## Architecture

- **src/index.ts** — CLI entry point, subcommand dispatch
- **src/config.ts** — Central config at `~/.config/ragent/config.json` with per-path overrides
- **src/connect.ts** — SSH + tmux + port forwarding + reverse tunnel + auto-reconnect loop
- **src/fileserver.ts** — Local HTTP file server (Bun.serve) for transparent file fetching
- **src/status.ts** — Connection/port/tmux dashboard
- **src/push.ts** — Manual rsync file push with home dir path rewriting
- **src/editor.ts** — Open remote project in VS Code or Zed via their SSH remote support
- **src/setup.ts** — One-time SSH key gen + Claude Code PreToolUse hook install

## Conventions

- Use Bun-native APIs: `$` shell, `Bun.file()`, `Bun.write()`, `Bun.serve()`, `Bun.spawn()`
- Zero external dependencies — everything uses Bun builtins
- Tests use `bun:test` in `src/__tests__/`
- Config is JSON (`~/.config/ragent/config.json`) with top-level defaults and per-path overrides
