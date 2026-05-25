import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

let loaded = false;

function findUp(fileName: string, startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current || parsePath(current).root === current) {
      return null;
    }
    current = parent;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Z0-9_]+$/i.test(key)) {
    return null;
  }
  const value = stripQuotes(trimmed.slice(separator + 1));
  return { key, value };
}

export function loadRootEnv(fileName = ".env"): void {
  if (loaded) {
    return;
  }
  loaded = true;
  const envPath = findUp(fileName, process.cwd());
  if (!envPath) {
    return;
  }
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
  }
}
