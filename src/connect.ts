import { $ } from "bun";
import { readSync, openSync, closeSync } from "node:fs";
import { type RagentConfig, parseHost, sshSocketPath } from "./config.ts";
import { startFileServer, stopFileServer } from "./fileserver.ts";

/** Retrieve stored keychain password for a remote host from local keychain */
async function getKeychainPassword(host: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", "ragent", "-a", host, "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  return stdout.trim() || null;
}

/** Store keychain password for a remote host in local keychain */
async function setKeychainPassword(host: string, password: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["security", "add-generic-password", "-s", "ragent", "-a", host, "-w", password, "-U"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return (await proc.exited) === 0;
}

/** Prompt for a password without echoing input */
async function promptPassword(question: string): Promise<string | null> {
  process.stdout.write(question);
  await $`stty -echo < /dev/tty`.nothrow().quiet();
  try {
    const buf = Buffer.alloc(1024);
    const fd = openSync("/dev/tty", "r");
    const n = readSync(fd, buf);
    closeSync(fd);
    return buf.slice(0, n).toString().trim() || null;
  } finally {
    await $`stty echo < /dev/tty`.nothrow().quiet();
    process.stdout.write("\n");
  }
}

function setTerminalTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

function clearTerminalTitle(): void {
  process.stdout.write(`\x1b]0;\x07`);
}

/** Sync local terminfo to remote so custom terminals (Ghostty, Kitty, etc.) work */
async function syncTerminfo(host: string): Promise<void> {
  const infocmp = Bun.spawn(["infocmp", "-x"], { stdout: "pipe", stderr: "pipe" });
  const terminfo = await new Response(infocmp.stdout).text();
  if ((await infocmp.exited) !== 0 || !terminfo) return;

  const tic = Bun.spawn(["ssh", host, "tic", "-x", "-"], {
    stdin: new TextEncoder().encode(terminfo),
    stdout: "pipe",
    stderr: "pipe",
  });
  await tic.exited;
}

/** Check if the SSH ControlMaster socket is alive */
async function isSocketAlive(host: string, socket: string): Promise<boolean> {
  if (!(await Bun.file(socket).exists())) return false;

  const { exitCode } = await $`ssh -O check -o ControlPath=${socket} ${host}`
    .nothrow()
    .quiet();

  return exitCode === 0;
}

/** Clean up a stale SSH socket */
async function cleanStaleSocket(host: string, socket: string): Promise<void> {
  if (!(await Bun.file(socket).exists())) return;

  if (!(await isSocketAlive(host, socket))) {
    try {
      await Bun.file(socket).delete();
    } catch {
      // ignore
    }
  }
}

/** Build SSH command arguments */
export function buildSshArgs(
  config: RagentConfig,
  fileServerPort: number,
  keychainPassword?: string,
): string[] {
  const socket = sshSocketPath(config.session);
  const args: string[] = [
    "ssh",
    "-t",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${socket}`,
    "-o", "ControlPersist=10",
    "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=3",
  ];

  for (const portSpec of config.ports) {
    const [local, remote] = portSpec.includes(":")
      ? portSpec.split(":")
      : [portSpec, portSpec];
    args.push("-L", `${local}:localhost:${remote}`);
  }

  // Reverse tunnel for file server
  args.push("-R", `${fileServerPort}:localhost:${fileServerPort}`);

  let unlockCmd: string;
  if (keychainPassword) {
    // Base64-encode to avoid shell escaping issues (base64 is [A-Za-z0-9+/=])
    const b64 = Buffer.from(keychainPassword).toString("base64");
    unlockCmd = `security unlock-keychain -p "$(printf %s ${b64} | base64 -D)" ~/Library/Keychains/login.keychain-db 2>/dev/null || true`;
  } else {
    unlockCmd = "security unlock-keychain ~/Library/Keychains/login.keychain-db 2>/dev/null || true";
  }

  args.push(config.host);
  args.push(`bash -lc '${unlockCmd}; mkdir -p ~/.config/ragent && echo ${fileServerPort} > ~/.config/ragent/port && tmux new-session -As ${config.session} -c ${config.dir}'`);

  return args;
}

// Exit code 0 = clean exit (tmux detach or normal exit)
const CLEAN_EXIT_CODES = new Set([0]);

/**
 * Connect to remote with auto-reconnect loop.
 * Starts file server, SSHes in with tmux + port forwarding + reverse tunnel.
 * On network drop: waits 3s and reconnects.
 * On clean exit (Ctrl-C, tmux detach): exits.
 */
export async function connect(config: RagentConfig): Promise<void> {
  setTerminalTitle(`ragent: ${config.dir}`);
  let interrupted = false;
  const socket = sshSocketPath(config.session);

  async function teardown() {
    clearTerminalTitle();
    stopFileServer();
    await $`ssh -O exit -o ControlPath=${socket} ${config.host}`.nothrow().quiet();
  }

  process.on("SIGINT", () => {
    interrupted = true;
  });

  // Check local keychain for stored remote keychain password
  let keychainPw = await getKeychainPassword(config.host);
  if (!keychainPw) {
    console.log(`No keychain password saved for ${config.host}.`);
    console.log("Save your Mac login password so Claude Code can access credentials via SSH.");
    console.log("(Press Enter to skip)\n");
    const pw = await promptPassword(`Password for ${config.host}: `);
    if (pw) {
      await setKeychainPassword(config.host, pw);
      keychainPw = pw;
      console.log("Saved to local keychain.\n");
    }
  }

  await syncTerminfo(config.host);

  while (true) {
    await cleanStaleSocket(config.host, socket);

    const port = startFileServer();
    console.log(`File server on port ${port}`);

    const args = buildSshArgs(config, port, keychainPw ?? undefined);
    console.log(`Connecting to ${config.host}...`);
    console.log(`  Session: ${config.session}`);
    console.log(`  Dir: ${config.dir}`);
    if (config.ports.length > 0) {
      console.log(`  Ports: ${config.ports.join(", ")}`);
    }
    console.log(`  Reverse tunnel: ${port}`);
    console.log("");

    const proc = Bun.spawn(args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;

    stopFileServer();

    if (interrupted) {
      await teardown();
      console.log("\nDisconnected.");
      process.exit(0);
    }

    if (CLEAN_EXIT_CODES.has(exitCode)) {
      await teardown();
      console.log("Session ended.");
      process.exit(0);
    }

    console.log(
      `\nConnection lost (exit code ${exitCode}). Reconnecting in 3s...`,
    );
    await Bun.sleep(3000);

    if (interrupted) {
      await teardown();
      console.log("\nDisconnected.");
      process.exit(0);
    }
  }
}
