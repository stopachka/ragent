import { describe, test, expect } from "bun:test";
import { buildSshArgs } from "../connect.ts";
import type { RagentConfig } from "../config.ts";

describe("buildSshArgs", () => {
  const baseConfig: RagentConfig = {
    host: "reginald@100.88.84.117",
    dir: "~/projects/instant",
    session: "instant",
    ports: [],
  };

  test("builds basic SSH args with tmux", () => {
    const args = buildSshArgs(baseConfig, 19876);

    expect(args[0]).toBe("ssh");
    expect(args).toContain("-t");
    expect(args).toContain("reginald@100.88.84.117");

    // Should contain tmux command as last arg
    const lastArg = args[args.length - 1]!;
    expect(lastArg).toContain("tmux new-session -As instant");
    expect(lastArg).toContain("-c ~/projects/instant");
  });

  test("includes ControlMaster options", () => {
    const args = buildSshArgs(baseConfig, 19876);

    const controlMasterIdx = args.indexOf("ControlMaster=auto");
    expect(args.some((a) => a.includes("ControlMaster=auto"))).toBe(true);
    expect(args.some((a) => a.includes("ControlPath="))).toBe(true);
    expect(args.some((a) => a.includes("ControlPersist="))).toBe(true);
  });

  test("includes ServerAlive options", () => {
    const args = buildSshArgs(baseConfig, 19876);

    expect(args.some((a) => a.includes("ServerAliveInterval="))).toBe(true);
    expect(args.some((a) => a.includes("ServerAliveCountMax="))).toBe(true);
  });

  test("adds port forwarding for configured ports", () => {
    const config: RagentConfig = {
      ...baseConfig,
      ports: ["3000", "4000:5000"],
    };

    const args = buildSshArgs(config, 19876);

    expect(args).toContain("-L");
    // Check that port forwards are present
    expect(args.some((a) => a === "3000:localhost:3000")).toBe(true);
    expect(args.some((a) => a === "4000:localhost:5000")).toBe(true);
  });

  test("adds reverse tunnel for file server", () => {
    const args = buildSshArgs(baseConfig, 19876);

    expect(args).toContain("-R");
    expect(args.some((a) => a === "19876:localhost:19876")).toBe(true);
  });

  test("handles empty ports", () => {
    const args = buildSshArgs(baseConfig, 19876);
    // Should still have -R for reverse tunnel but no -L
    const lFlags = args.filter((a) => a === "-L");
    expect(lFlags.length).toBe(0);

    const rFlags = args.filter((a) => a === "-R");
    expect(rFlags.length).toBe(1);
  });
});
