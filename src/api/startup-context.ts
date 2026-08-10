import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/env.js";

interface PackageMetadata {
  name?: string;
  version?: string;
}

function findPackageVersion(startPath: string, expectedName: string): string {
  let directory = dirname(startPath);
  const root = parse(directory).root;
  while (directory !== root) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as PackageMetadata;
      if (metadata.name === expectedName) {
        return metadata.version ?? "unknown";
      }
    }
    directory = dirname(directory);
  }
  return "unknown";
}

export function installedVersions(): { appVersion: string; ksefClientVersion: string } {
  const require = createRequire(import.meta.url);
  const modulePath = fileURLToPath(import.meta.url);
  const ksefEntry = require.resolve("ksef-client");
  return {
    appVersion: findPackageVersion(modulePath, "ksef-exporter"),
    ksefClientVersion: findPackageVersion(ksefEntry, "ksef-client"),
  };
}

export function startupContext(
  config: Pick<AppConfig, "KSEF_ENVIRONMENT" | "DATABASE_PATH" | "LOG_LEVEL">,
  versions = installedVersions(),
): Record<string, unknown> {
  return {
    event: "app.started",
    ...versions,
    ksefEnvironment: config.KSEF_ENVIRONMENT,
    databasePath: config.DATABASE_PATH,
    logLevel: config.LOG_LEVEL,
  };
}
