import { $ } from "bun";
import { configPath, loadConfig, sshSocketPath } from "./config.ts";
import { connect } from "./connect.ts";
import { showStatus } from "./status.ts";
import { pushFile } from "./push.ts";
import { setup } from "./setup.ts";

const HELP = `
ragent — Seamless remote Claude Code sessions

Usage:
  ragent [path]             Connect (SSH + tmux + ports + file server)
  ragent setup              First-time setup (config + SSH key + deps + connect)
  ragent status [path]      Show connection status
  ragent push <file>        Push a file to remote
  ragent code [path]        Open remote project in VS Code
  ragent zed [path]         Open remote project in Zed
  ragent run <cmd...>       Run a command on remote
  ragent disconnect [path]  Tear down SSH connection

  [path] can be ~/projects/myapp, /absolute/path, or ./relative.
  If omitted, uses the current directory.

Config:
  ~/.config/ragent/config.json:
  {
    "host": "user@hostname",     // required
    "ports": ["3000"],           // default ports for all projects
    "paths": {
      "~/projects/myapp": {      // per-project overrides
        "ports": ["8080"]
      }
    }
  }
`.trim();

const KNOWN_COMMANDS = new Set([
  "connect", "status", "push", "code", "zed",
  "run", "init", "setup", "disconnect", "help", "--help", "-h",
]);

function looksLikePath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith(".");
}

function parseArgs(argv: string[]): { command: string; path?: string; rest: string[] } {
  const first = argv[0];
  if (!first) return { command: "connect", rest: [] };

  if (looksLikePath(first)) {
    return { command: "connect", path: first, rest: argv.slice(1) };
  }

  if (KNOWN_COMMANDS.has(first)) {
    const second = argv[1];
    // Commands that accept an optional trailing path
    const pathCommands = new Set(["connect", "status", "code", "zed", "disconnect"]);
    if (pathCommands.has(first) && second && looksLikePath(second)) {
      return { command: first, path: second, rest: argv.slice(2) };
    }
    return { command: first, rest: argv.slice(1) };
  }

  return { command: first, rest: argv.slice(1) };
}

async function main() {
  const args = process.argv.slice(2);
  const { command, path, rest } = parseArgs(args);

  switch (command) {
    case "connect":
    case undefined: {
      const config = await loadConfig(path);
      await connect(config);
      break;
    }

    case "status": {
      const config = await loadConfig(path);
      await showStatus(config);
      break;
    }

    case "push": {
      const file = rest[0];
      if (!file) {
        console.error("Usage: ragent push <file>");
        process.exit(1);
      }
      const config = await loadConfig(path);
      await pushFile(config, file);
      break;
    }

    case "code": {
      const config = await loadConfig(path);
      const { openCode } = await import("./editor.ts");
      await openCode(config);
      break;
    }

    case "zed": {
      const config = await loadConfig(path);
      const { openZed } = await import("./editor.ts");
      await openZed(config);
      break;
    }

    case "run": {
      const cmd = rest.join(" ");
      if (!cmd) {
        console.error("Usage: ragent run <command>");
        process.exit(1);
      }
      const config = await loadConfig(path);
      const socket = sshSocketPath(config.session);
      const { exitCode } =
        await $`ssh -o ControlPath=${socket} ${config.host} ${cmd}`.nothrow();
      process.exit(exitCode);
      break;
    }

    case "init": {
      console.log("`ragent init` has been merged into `ragent setup`.");
      console.log("Run `ragent setup` instead.");
      break;
    }

    case "setup": {
      const exists = await Bun.file(configPath()).exists();
      if (exists) {
        const config = await loadConfig();
        await setup(config);
      } else {
        await setup();
      }
      break;
    }

    case "disconnect": {
      const config = await loadConfig(path);
      const socket = sshSocketPath(config.session);
      await $`ssh -O exit -o ControlPath=${socket} ${config.host}`
        .nothrow()
        .quiet();
      console.log("Disconnected.");
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log(HELP);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
    }
  }
}

main();
