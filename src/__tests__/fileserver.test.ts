import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { startFileServer, stopFileServer, getFileServerPort } from "../fileserver.ts";

describe("fileserver", () => {
  afterEach(() => {
    stopFileServer();
  });

  test("starts on an auto-assigned port", () => {
    const port = startFileServer();
    expect(port).toBeGreaterThan(0);
    expect(getFileServerPort()).toBe(port);
  });

  test("serves files from home directory", async () => {
    const port = startFileServer();

    // Create a temp file under home
    const tmpDir = mkdtempSync(join(homedir(), ".ragent-test-"));
    const testFile = join(tmpDir, "test.txt");
    await Bun.write(testFile, "hello from ragent");

    try {
      const encodedPath = encodeURIComponent(testFile);
      const res = await fetch(`http://127.0.0.1:${port}/fetch?path=${encodedPath}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("hello from ragent");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("serves files from /tmp", async () => {
    const port = startFileServer();

    const tmpDir = mkdtempSync(join(tmpdir(), "ragent-test-"));
    const testFile = join(tmpDir, "image.png");
    await Bun.write(testFile, "fake image data");

    try {
      const encodedPath = encodeURIComponent(testFile);
      const res = await fetch(`http://127.0.0.1:${port}/fetch?path=${encodedPath}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("fake image data");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns 404 for nonexistent files", async () => {
    const port = startFileServer();
    const encodedPath = encodeURIComponent("/tmp/ragent-does-not-exist-12345.txt");
    const res = await fetch(`http://127.0.0.1:${port}/fetch?path=${encodedPath}`);
    expect(res.status).toBe(404);
  });

  test("returns 403 for paths outside allowed directories", async () => {
    const port = startFileServer();
    const encodedPath = encodeURIComponent("/etc/passwd");
    const res = await fetch(`http://127.0.0.1:${port}/fetch?path=${encodedPath}`);
    expect(res.status).toBe(403);
  });

  test("returns 400 when path parameter is missing", async () => {
    const port = startFileServer();
    const res = await fetch(`http://127.0.0.1:${port}/fetch`);
    expect(res.status).toBe(400);
  });

  test("health endpoint returns ok", async () => {
    const port = startFileServer();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("stopFileServer clears the port", () => {
    startFileServer();
    expect(getFileServerPort()).not.toBeNull();
    stopFileServer();
    expect(getFileServerPort()).toBeNull();
  });
});
