import { $ } from "bun";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { type RagentConfig, parseHost, sshSocketPath } from "./config.ts";

/**
 * Push a local file to the same path on the remote.
 * Rewrites /Users/localUser/... → /Users/remoteUser/...
 */
export async function pushFile(
  config: RagentConfig,
  localPath: string,
): Promise<void> {
  const absPath = resolve(localPath);

  if (!(await Bun.file(absPath).exists())) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const { user: remoteUser } = parseHost(config.host);
  const localUser = process.env.USER ?? "unknown";
  const home = homedir();

  let remotePath = absPath;
  if (absPath.startsWith(home)) {
    remotePath = `/Users/${remoteUser}${absPath.slice(home.length)}`;
  }

  const socket = sshSocketPath(config.session);

  await $`ssh -o ControlPath=${socket} ${config.host} ${{
    raw: `mkdir -p "$(dirname '${remotePath}')"`,
  }}`.nothrow().quiet();

  console.log(`Pushing ${absPath} → ${config.host}:${remotePath}`);

  const { exitCode } =
    await $`rsync -avz -e ${"ssh -o ControlPath=" + socket} ${absPath} ${config.host}:${remotePath}`.nothrow();

  if (exitCode !== 0) {
    console.error("Push failed");
    process.exit(1);
  }

  console.log("Done.");
}
