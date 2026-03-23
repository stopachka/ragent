import { type RagentConfig, sshSocketPath } from "./config.ts";

/**
 * Resolve ~ in config.dir by querying the remote's $HOME via SSH.
 * Uses Bun.spawn (not $`` shell) to avoid local $HOME expansion.
 */
async function resolveRemoteDir(config: RagentConfig): Promise<string> {
  const dir = config.dir;
  if (!dir.startsWith("~")) return dir;

  const socket = sshSocketPath(config.session);
  const proc = Bun.spawn(
    [
      "ssh",
      "-o", `ControlPath=${socket}`,
      "-o", "ConnectTimeout=5",
      config.host,
      "echo", "$HOME",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("Failed to resolve remote home directory.");
    process.exit(1);
  }

  const output = new TextDecoder()
    .decode(await new Response(proc.stdout).arrayBuffer())
    .trim();

  // Remote shell may print login noise; $HOME is the last line
  const lines = output.split("\n").filter(Boolean);
  const remoteHome = lines[lines.length - 1]!;

  return dir.replace("~", remoteHome);
}

/** Open the remote project in VS Code via Remote-SSH */
export async function openCode(config: RagentConfig): Promise<void> {
  const remoteDir = await resolveRemoteDir(config);
  console.log(`Opening VS Code: ${config.host}:${remoteDir}`);
  const uri = `vscode-remote://ssh-remote+${config.host}${remoteDir}`;
  Bun.spawn(["code", "--folder-uri", uri]);
}

/** Open the remote project in Zed via SSH */
export async function openZed(config: RagentConfig): Promise<void> {
  const remoteDir = await resolveRemoteDir(config);
  console.log(`Opening Zed: ${config.host}:${remoteDir}`);
  Bun.spawn(["zed", `ssh://${config.host}${remoteDir}`]);
}
