import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeniedPath, sanitizeText } from "./sanitize.js";

const maxFileChars = 40_000;

export async function readSafeFile(filePath: string, cwd: string): Promise<{ path: string; content: string; truncated: boolean } | { omitted: string }> {
  if (isDeniedPath(filePath)) return { omitted: `${filePath} denied by safety policy` };
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { omitted: `${filePath} outside working directory` };

  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { omitted: `${filePath} is not a file` };
    if (info.size > 512_000) return { omitted: `${filePath} is larger than 512KB` };
    const raw = await readFile(absolute, "utf8");
    const truncated = raw.length > maxFileChars;
    return { path: relative, content: sanitizeText(raw.slice(0, maxFileChars)), truncated };
  } catch (error) {
    return { omitted: `${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function defaultMetadataFiles(): string[] {
  return ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", "tsconfig.json", "opencode.json", "opencode.jsonc", ".opencode/opencode.json"];
}
