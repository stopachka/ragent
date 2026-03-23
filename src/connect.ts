import { $ } from "bun";
import { type RagentConfig, parseHost, sshSocketPath } from "./config.ts";
import { startFileServer, stopFileServer } from "./fileserver.ts";

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

  args.push(config.host);
  args.push(`bash -lc 'mkdir -p ~/.config/ragent && echo ${fileServerPort} > ~/.config/ragent/port && tmux new-session -As ${config.session} -c ${config.dir}'`);

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
  let interrupted = false;
  const socket = sshSocketPath(config.session);

  async function teardown() {
    stopFileServer();
    await $`ssh -O exit -o ControlPath=${socket} ${config.host}`.nothrow().quiet();
  }

  process.on("SIGINT", () => {
    interrupted = true;
  });

  await syncTerminfo(config.host);

  while (true) {
    await cleanStaleSocket(config.host, socket);

    const port = startFileServer();
    console.log(`File server on port ${port}`);

    const args = buildSshArgs(config, port);
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
