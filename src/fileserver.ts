import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Server } from "bun";

const home = homedir();

/** Allowed path prefixes for file serving */
const ALLOWED_PREFIXES = [home, "/tmp", "/var", "/private/tmp", "/private/var"];

function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_PREFIXES.some((prefix) => resolved.startsWith(prefix));
}

let server: Server | null = null;

/**
 * Start a local HTTP file server on an auto-assigned port.
 * Returns the port number.
 *
 * Endpoint: GET /fetch?path=<absolute-path>
 * Returns the file contents or 404/403.
 */
export function startFileServer(): number {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // auto-assign
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response("ok");
      }

      if (url.pathname !== "/fetch") {
        return new Response("Not found", { status: 404 });
      }

      const filePath = url.searchParams.get("path");
      if (!filePath) {
        return new Response("Missing ?path= parameter", { status: 400 });
      }

      if (!isAllowedPath(filePath)) {
        return new Response("Forbidden: path not in allowed directories", {
          status: 403,
        });
      }

      const file = Bun.file(filePath);
      return file.exists().then((exists) => {
        if (!exists) {
          return new Response("File not found", { status: 404 });
        }
        return new Response(file);
      });
    },
  });

  return server.port;
}

export function stopFileServer(): void {
  if (server) {
    server.stop(true);
    server = null;
  }
}

export function getFileServerPort(): number | null {
  return server?.port ?? null;
}
