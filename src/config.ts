import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface RagentConfig {
  host: string; // user@ip or user@hostname — required
  dir: string; // Remote working directory
  session: string; // tmux session name
  ports: string[]; // Ports to forward (e.g. ["3000", "4000:5000"])
}

interface PathOverrides {
  ports?: string[];
  session?: string;
  host?: string;
}

interface RagentFileConfig {
  host: string;
  ports?: string[];
  paths?: Record<string, PathOverrides>;
}

/** Central config location */
export function configPath(): string {
  return join(homedir(), ".config", "ragent", "config.json");
}

/**
 * Derive the remote directory by mirroring the local path relative to $HOME.
 * e.g. local /Users/stopa/projects/instant → ~/projects/instant on remote
 */
export function defaultRemoteDir(localDir: string, home?: string): string {
  const h = home ?? homedir();
  if (localDir.startsWith(h)) {
    const rel = localDir.slice(h.length);
    return "~" + rel;
  }
  return "~/";
}

function normalizePath(p: string): string {
  return p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
}

/**
 * Resolve a user-provided path to a remote directory.
 * - ~/... or /... → use as-is (already a remote path)
 * - Relative → resolve against cwd, then mirror via defaultRemoteDir
 */
export function resolveRemotePath(
  input: string,
  cwd: string,
  home: string,
): string {
  if (input.startsWith("~") || input.startsWith("/")) {
    return normalizePath(input);
  }
  return defaultRemoteDir(resolve(cwd, input), home);
}

function findPathOverrides(
  paths: Record<string, PathOverrides> | undefined,
  remoteDir: string,
): PathOverrides | undefined {
  if (!paths) return undefined;
  const normalized = normalizePath(remoteDir);
  for (const [key, value] of Object.entries(paths)) {
    if (normalizePath(key) === normalized) return value;
  }
  return undefined;
}

/**
 * Pure resolution logic — given a parsed config file, cwd, and home dir,
 * produce the resolved RagentConfig.
 */
export function resolveConfig(
  raw: RagentFileConfig,
  cwd: string,
  home: string,
  remotePath?: string,
): RagentConfig {
  const remoteDir = remotePath
    ? resolveRemotePath(remotePath, cwd, home)
    : defaultRemoteDir(cwd, home);
  const overrides = findPathOverrides(raw.paths, remoteDir);

  return {
    host: overrides?.host ?? raw.host,
    dir: remoteDir,
    session: overrides?.session ?? basename(remoteDir),
    ports: overrides?.ports ?? raw.ports ?? [],
  };
}

export async function loadConfig(remotePath?: string): Promise<RagentConfig> {
  const cfgPath = configPath();
  const file = Bun.file(cfgPath);

  if (!(await file.exists())) {
    console.error("No config found. Run `ragent setup` to create one.");
    process.exit(1);
  }

  let raw: RagentFileConfig;
  try {
    raw = await file.json();
  } catch (e) {
    console.error(`Failed to parse ${cfgPath}: ${e}`);
    process.exit(1);
  }

  if (!raw.host) {
    console.error(`"host" is required in ${cfgPath}`);
    process.exit(1);
  }

  return resolveConfig(raw, process.cwd(), homedir(), remotePath);
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
