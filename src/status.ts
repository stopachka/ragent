import { $ } from "bun";
import { type RagentConfig, sshSocketPath } from "./config.ts";
import { getFileServerPort } from "./fileserver.ts";

async function isSocketAlive(host: string, socket: string): Promise<boolean> {
  if (!(await Bun.file(socket).exists())) return false;

  const { exitCode } = await $`ssh -O check -o ControlPath=${socket} ${host}`
    .nothrow()
    .quiet();

  return exitCode === 0;
}

async function checkPortListening(port: string): Promise<boolean> {
  const localPort = port.includes(":") ? port.split(":")[0]! : port;
  const { exitCode } = await $`lsof -i :${localPort} -sTCP:LISTEN`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

async function getRemoteTmuxSessions(host: string, socket: string): Promise<string> {
  const { stdout, exitCode } =
    await $`ssh -o ControlPath=${socket} ${host} ${{ raw: "tmux list-sessions 2>/dev/null || echo '  (no sessions)'" }}`
      .nothrow()
      .quiet();

  if (exitCode !== 0) return "  (unable to query)";
  return stdout.toString().trim();
}

export async function showStatus(config: RagentConfig): Promise<void> {
  const socket = sshSocketPath(config.session);
  const connected = await isSocketAlive(config.host, socket);

  console.log("=== ragent status ===\n");
  console.log(`Host:       ${config.host}`);
  console.log(`Connection: ${connected ? "CONNECTED" : "DISCONNECTED"}`);
  console.log(`Session:    ${config.session}`);
  console.log(`Remote dir: ${config.dir}`);

  if (config.ports.length > 0) {
    console.log("\n--- Ports ---");
    for (const port of config.ports) {
      const localPort = port.includes(":") ? port.split(":")[0]! : port;
      const remotePort = port.includes(":") ? port.split(":")[1]! : port;
      const active = await checkPortListening(localPort);
      console.log(
        `  :${localPort} → remote:${remotePort}  ${active ? "[ACTIVE]" : "[inactive]"}`,
      );
    }
  }

  const fsPort = getFileServerPort();
  console.log("\n--- File Server ---");
  console.log(`  ${fsPort ? `Running on port ${fsPort}` : "Not running"}`);

  if (connected) {
    console.log("\n--- Remote tmux ---");
    console.log(await getRemoteTmuxSessions(config.host, socket));
  }

  console.log("");
}
