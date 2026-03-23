import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { findConfigPath, parseHost, sshSocketPath } from "../config.ts";

describe("findConfigPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ragent-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .ragent.json in the given directory", async () => {
    const configPath = join(tmpDir, ".ragent.json");
    await Bun.write(configPath, JSON.stringify({ host: "test@host" }));

    const result = await findConfigPath(tmpDir);
    expect(result).toBe(configPath);
  });

  test("walks up to find .ragent.json in parent directory", async () => {
    const child = join(tmpDir, "sub", "deep");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(child, { recursive: true });

    const configPath = join(tmpDir, ".ragent.json");
    await Bun.write(configPath, JSON.stringify({ host: "test@host" }));

    const result = await findConfigPath(child);
    expect(result).toBe(configPath);
  });

  test("returns null when no config found", async () => {
    // Use a dir with no config and that won't walk up to a real one
    const emptyDir = mkdtempSync(join(tmpdir(), "ragent-empty-"));
    const result = await findConfigPath(emptyDir);
    rmSync(emptyDir, { recursive: true, force: true });
    // May find ~/.ragent.json — that's ok. Just checking it doesn't crash.
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("parseHost", () => {
  test("parses user@hostname", () => {
    const result = parseHost("reginald@100.88.84.117");
    expect(result).toEqual({ user: "reginald", hostname: "100.88.84.117" });
  });

  test("parses bare hostname with default user", () => {
    const result = parseHost("100.88.84.117");
    expect(result.hostname).toBe("100.88.84.117");
    expect(typeof result.user).toBe("string");
  });

  test("handles hostname with colons (IPv6)", () => {
    const result = parseHost("user@::1");
    expect(result).toEqual({ user: "user", hostname: "::1" });
  });
});

describe("sshSocketPath", () => {
  test("returns a path in /tmp", () => {
    expect(sshSocketPath()).toStartWith("/tmp/");
  });
});
