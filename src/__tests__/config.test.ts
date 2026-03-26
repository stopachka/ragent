import { describe, test, expect } from "bun:test";
import {
  configPath,
  defaultRemoteDir,
  resolveConfig,
  resolveRemotePath,
  parseHost,
  sshSocketPath,
} from "../config.ts";

describe("configPath", () => {
  test("returns path under ~/.config/ragent/", () => {
    expect(configPath()).toContain(".config/ragent/config.json");
  });
});

describe("defaultRemoteDir", () => {
  test("mirrors local path relative to home", () => {
    expect(defaultRemoteDir("/Users/stopa/projects/foo", "/Users/stopa")).toBe(
      "~/projects/foo",
    );
  });

  test("returns ~/ for paths outside home", () => {
    expect(defaultRemoteDir("/opt/something", "/Users/stopa")).toBe("~/");
  });
});

describe("resolveConfig", () => {
  test("uses host from top-level config", () => {
    const result = resolveConfig(
      { host: "user@host" },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.host).toBe("user@host");
  });

  test("derives remote dir from cwd relative to home", () => {
    const result = resolveConfig(
      { host: "user@host" },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.dir).toBe("~/projects/foo");
  });

  test("uses session from basename of remote dir", () => {
    const result = resolveConfig(
      { host: "user@host" },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.session).toBe("foo");
  });

  test("uses top-level ports as default", () => {
    const result = resolveConfig(
      { host: "user@host", ports: ["3000"] },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.ports).toEqual(["3000"]);
  });

  test("path-level ports replace top-level ports", () => {
    const result = resolveConfig(
      {
        host: "user@host",
        ports: ["3000"],
        paths: { "~/projects/foo": { ports: ["8080"] } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.ports).toEqual(["8080"]);
  });

  test("returns empty ports when no match and no top-level", () => {
    const result = resolveConfig(
      {
        host: "user@host",
        paths: { "~/projects/bar": { ports: ["3000"] } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.ports).toEqual([]);
  });

  test("handles trailing slash in path keys", () => {
    const result = resolveConfig(
      {
        host: "user@host",
        paths: { "~/projects/foo/": { ports: ["8080"] } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.ports).toEqual(["8080"]);
  });

  test("allows session override per path", () => {
    const result = resolveConfig(
      {
        host: "user@host",
        paths: { "~/projects/foo": { session: "custom" } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.session).toBe("custom");
  });

  test("allows host override per path", () => {
    const result = resolveConfig(
      {
        host: "user@default",
        paths: { "~/projects/foo": { host: "user@other" } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
    );
    expect(result.host).toBe("user@other");
  });
});

describe("resolveRemotePath", () => {
  test("tilde path used as-is", () => {
    expect(resolveRemotePath("~/projects/bar", "/Users/stopa", "/Users/stopa")).toBe(
      "~/projects/bar",
    );
  });

  test("absolute path used as-is", () => {
    expect(resolveRemotePath("/home/user/foo", "/Users/stopa", "/Users/stopa")).toBe(
      "/home/user/foo",
    );
  });

  test("strips trailing slash", () => {
    expect(resolveRemotePath("~/projects/bar/", "/Users/stopa", "/Users/stopa")).toBe(
      "~/projects/bar",
    );
  });

  test("relative path resolves against cwd then mirrors", () => {
    expect(
      resolveRemotePath("./sub", "/Users/stopa/projects/foo", "/Users/stopa"),
    ).toBe("~/projects/foo/sub");
  });
});

describe("resolveConfig with remotePath", () => {
  test("uses remotePath instead of cwd", () => {
    const result = resolveConfig(
      { host: "user@host" },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
      "~/projects/bar",
    );
    expect(result.dir).toBe("~/projects/bar");
    expect(result.session).toBe("bar");
  });

  test("path overrides still match with remotePath", () => {
    const result = resolveConfig(
      {
        host: "user@host",
        ports: ["3000"],
        paths: { "~/projects/bar": { ports: ["9090"] } },
      },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
      "~/projects/bar",
    );
    expect(result.ports).toEqual(["9090"]);
  });

  test("undefined remotePath falls back to cwd", () => {
    const result = resolveConfig(
      { host: "user@host" },
      "/Users/stopa/projects/foo",
      "/Users/stopa",
      undefined,
    );
    expect(result.dir).toBe("~/projects/foo");
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
