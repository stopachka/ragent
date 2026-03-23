import { parseArgs } from "util";
import { loadConfig } from "./config.ts";
import { connect } from "./connect.ts";
import { showStatus } from "./status.ts";
import { pushFile } from "./push.ts";
import { setup } from "./setup.ts";

const HELP = `
ragent — Seamless remote Claude Code sessions

Usage:
  ragent                  Connect (SSH + tmux + ports + file server)
  ragent status           Show connection status
  ragent push <file>      Push a file to remote
  ragent run <cmd...>     Run a command on remote
  ragent init             Create .ragent.json in current directory
  ragent setup            One-time SSH key + hook install
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

    case "run": {
      const cmd = args.slice(1).join(" ");
      if (!cmd) {
        console.error("Usage: ragent run <command>");
        process.exit(1);
      }
      const config = await loadConfig();
      const { sshSocketPath } = await import("./config.ts");
      const { $ } = await import("bun");
      const socket = sshSocketPath();
      const { exitCode } =
        await $`ssh -o ControlPath=${socket} ${config.host} ${cmd}`.nothrow();
      process.exit(exitCode);
      break;
    }

    case "init": {
      const configPath = `${process.cwd()}/.ragent.json`;
      const file = Bun.file(configPath);
      if (await file.exists()) {
        console.log(`.ragent.json already exists at ${configPath}`);
        const config = await file.json();
        console.log(JSON.stringify(config, null, 2));
        process.exit(0);
      }

      const defaultConfig = {
        host: "user@hostname",
      };

      await Bun.write(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
      console.log(`Created ${configPath}`);
      console.log("Edit it with your remote host, then run `ragent setup`.");
      break;
    }

    case "setup": {
      const config = await loadConfig();
      await setup(config);
      break;
    }

    case "disconnect": {
      const config = await loadConfig();
      const { sshSocketPath } = await import("./config.ts");
      const { $ } = await import("bun");
      const socket = sshSocketPath();
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
