import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODE, envFilesForMode, loadEnvFiles } from "./load-env.js";

describe("envFilesForMode", () => {
  it("orders base then mode-specific files, lowest priority first", () => {
    expect(envFilesForMode("parkowa")).toEqual([
      ".env",
      ".env.local",
      ".env.parkowa",
      ".env.parkowa.local",
    ]);
  });
});

describe("loadEnvFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "load-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): void => writeFileSync(join(dir, name), body);

  it("loads the base .env when no mode-specific file exists", () => {
    write(".env", "FOO=base\nBAR=base");
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFiles({ cwd: dir, env, mode: "parkowa" });

    expect(env.FOO).toBe("base");
    expect(env.BAR).toBe("base");
    expect(result).toEqual({ mode: "parkowa", loaded: [".env"] });
  });

  it("lets .env.<mode> override .env while keeping unrelated base keys", () => {
    write(".env", "DATABASE_PATH=./data/base.sqlite\nSHARED=1");
    write(".env.parkowa", "DATABASE_PATH=./data/parkowa.sqlite");
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFiles({ cwd: dir, env, mode: "parkowa" });

    expect(env.DATABASE_PATH).toBe("./data/parkowa.sqlite");
    expect(env.SHARED).toBe("1");
    expect(result.loaded).toEqual([".env", ".env.parkowa"]);
  });

  it("reads only the selected mode's file, not sibling modes", () => {
    write(".env.parkowa", "TENANT=parkowa");
    write(".env.portowa", "TENANT=portowa");
    const env: NodeJS.ProcessEnv = {};

    loadEnvFiles({ cwd: dir, env, mode: "portowa" });

    expect(env.TENANT).toBe("portowa");
  });

  it("never overwrites a value already present in the environment", () => {
    write(".env", "KSEF_NIP=1111111111");
    write(".env.parkowa", "KSEF_NIP=2222222222");
    const env: NodeJS.ProcessEnv = { KSEF_NIP: "9999999999" };

    loadEnvFiles({ cwd: dir, env, mode: "parkowa" });

    expect(env.KSEF_NIP).toBe("9999999999");
  });

  it("applies .env.<mode>.local at the highest file priority", () => {
    write(".env", "X=a");
    write(".env.local", "X=b");
    write(".env.parkowa", "X=c");
    write(".env.parkowa.local", "X=d");
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFiles({ cwd: dir, env, mode: "parkowa" });

    expect(env.X).toBe("d");
    expect(result.loaded).toEqual([".env", ".env.local", ".env.parkowa", ".env.parkowa.local"]);
  });

  it("derives the mode from env.APP_ENV", () => {
    write(".env.development", "MODE_FILE=dev");
    write(".env.parkowa", "MODE_FILE=parkowa");
    const env: NodeJS.ProcessEnv = { APP_ENV: "parkowa" };

    const result = loadEnvFiles({ cwd: dir, env });

    expect(result.mode).toBe("parkowa");
    expect(env.MODE_FILE).toBe("parkowa");
  });

  it("falls back to the default mode when APP_ENV is unset", () => {
    write(".env.development", "MODE_FILE=dev");
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFiles({ cwd: dir, env });

    expect(result.mode).toBe(DEFAULT_MODE);
    expect(env.MODE_FILE).toBe("dev");
  });

  it("returns an empty loaded list when no files exist", () => {
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFiles({ cwd: dir, env, mode: "parkowa" });

    expect(result.loaded).toEqual([]);
    expect(env).toEqual({});
  });
});
