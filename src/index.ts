import { $ } from "bun";
import { loadConfig, sshSocketPath } from "./config.ts";
import { connect } from "./connect.ts";
import { showStatus } from "./status.ts";
import { pushFile } from "./push.ts";
import { setup } from "./setup.ts";

const HELP = `
ragent — Seamless remote Claude Code sessions

Usage:
  ragent                  Connect (SSH + tmux + ports + file server)
  ragent setup            First-time setup (config + SSH key + deps + connect)
  ragent status           Show connection status
  ragent push <file>      Push a file to remote
  ragent code             Open remote project in VS Code
  ragent zed              Open remote project in Zed
  ragent run <cmd...>     Run a command on remote
  ragent disconnect       Tear down SSH connection

Config:
  Place a .ragent.json in your project directory:
  {
    "host": "user@hostname",     // required
    "dir": "~/projects/myapp",   // default: mirrors local path
    "session": "myapp",          // default: directory name
    "ports": ["3000", "8080"]    // default: none
  }
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "connect";

  switch (command) {
    case "connect":
    case undefined: {
      const config = await loadConfig();
      await connect(config);
      break;
    }

    case "status": {
      const config = await loadConfig();
      await showStatus(config);
      break;
    }

    case "push": {
      const file = args[1];
      if (!file) {
        console.error("Usage: ragent push <file>");
        process.exit(1);
      }
      const config = await loadConfig();
      await pushFile(config, file);
      break;
    }

    case "code": {
      const config = await loadConfig();
      const { openCode } = await import("./editor.ts");
      await openCode(config);
      break;
    }

    case "zed": {
      const config = await loadConfig();
      const { openZed } = await import("./editor.ts");
      await openZed(config);
      break;
    }

    case "run": {
      const cmd = args.slice(1).join(" ");
      if (!cmd) {
        console.error("Usage: ragent run <command>");
        process.exit(1);
      }
      const config = await loadConfig();
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
      const { findConfigPath } = await import("./config.ts");
      const configPath = await findConfigPath();
      if (configPath) {
        const config = await loadConfig();
        await setup(config);
      } else {
        await setup();
      }
      break;
    }

    case "disconnect": {
      const config = await loadConfig();
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
