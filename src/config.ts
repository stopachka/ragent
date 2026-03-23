import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface RagentConfig {
  host: string; // user@ip or user@hostname — required
  dir: string; // Remote working directory
  session: string; // tmux session name
  ports: string[]; // Ports to forward (e.g. ["3000", "4000:5000"])
}

interface RawConfig {
  host?: string;
  dir?: string;
  session?: string;
  ports?: string[];
}

const CONFIG_NAME = ".ragent.json";

/**
 * Walk up from `startDir` looking for .ragent.json.
 * Falls back to ~/.ragent.json.
 * Returns null if nothing found.
 */
export async function findConfigPath(startDir?: string): Promise<string | null> {
  const start = resolve(startDir ?? process.cwd());
  const home = homedir();

  let dir = start;
  while (true) {
    const candidate = join(dir, CONFIG_NAME);
    if (await Bun.file(candidate).exists()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const global = join(home, CONFIG_NAME);
  if (await Bun.file(global).exists()) return global;

  return null;
}

/**
 * Derive the remote directory by mirroring the local path relative to $HOME.
 * e.g. local /Users/stopa/projects/instant → ~/projects/instant on remote
 */
function defaultRemoteDir(localDir: string): string {
  const home = homedir();
  if (localDir.startsWith(home)) {
    const rel = localDir.slice(home.length);
    return "~" + rel;
  }
  return "~/";
}

export async function loadConfig(startDir?: string): Promise<RagentConfig> {
  const configPath = await findConfigPath(startDir);
  if (!configPath) {
    console.error("No .ragent.json found. Run `ragent init` to create one.");
    process.exit(1);
  }

  let raw: RawConfig;
  try {
    raw = await Bun.file(configPath).json();
  } catch (e) {
    console.error(`Failed to parse ${configPath}: ${e}`);
    process.exit(1);
  }

  if (!raw.host) {
    console.error(`"host" is required in ${configPath}`);
    process.exit(1);
  }

  const cwd = process.cwd();

  return {
    host: raw.host,
    dir: raw.dir ?? defaultRemoteDir(cwd),
    session: raw.session ?? basename(cwd),
    ports: raw.ports ?? [],
  };
}

/**
 * Parse host string into user and hostname parts.
 * "reginald@100.88.84.117" → { user: "reginald", hostname: "100.88.84.117" }
 * "100.88.84.117" → { user: current local user, hostname: "100.88.84.117" }
 */
export function parseHost(host: string): { user: string; hostname: string } {
  if (host.includes("@")) {
    const [user, ...rest] = host.split("@");
    return { user: user!, hostname: rest.join("@") };
  }
  return { user: process.env.USER ?? "root", hostname: host };
}

/** SSH socket path for ControlMaster (per-session to allow parallel instances) */
export function sshSocketPath(session?: string): string {
  if (session) return `/tmp/ragent-ssh-${session}`;
  return "/tmp/ragent-ssh-socket";
}
