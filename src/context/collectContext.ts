import type { ContextBundle } from "../types.js";
import { getChangedFiles, getGitBranch, getGitDiff } from "./git.js";
import { defaultMetadataFiles, readSafeFile } from "./files.js";
import { sanitizeText } from "./sanitize.js";

export type CollectContextInput = {
  cwd: string;
  files?: string[];
  includeDiff?: boolean;
  includeMetadata?: boolean;
  maxContextChars?: number;
};

export async function collectContext(input: CollectContextInput): Promise<ContextBundle> {
  const maxContextChars = input.maxContextChars ?? 160_000;
  const requestedFiles = [...new Set([...(input.includeMetadata === false ? [] : defaultMetadataFiles()), ...(input.files ?? [])])];
  const files: ContextBundle["files"] = [];
  const omitted: string[] = [];
  let usedChars = 0;

  for (const filePath of requestedFiles) {
    const result = await readSafeFile(filePath, input.cwd);
    if ("omitted" in result) {
      omitted.push(result.omitted);
      continue;
    }
    if (usedChars + result.content.length > maxContextChars) {
      omitted.push(`${result.path} omitted because max context size was reached`);
      continue;
    }
    files.push(result);
    usedChars += result.content.length;
  }

  const branch = await getGitBranch(input.cwd);
  const changedFiles = await getChangedFiles(input.cwd);
  const rawDiff = input.includeDiff ? await getGitDiff(input.cwd) : undefined;
  const diff = rawDiff ? sanitizeText(rawDiff).slice(0, Math.max(0, maxContextChars - usedChars)) : undefined;

  return {
    summary: buildContextSummary(branch, changedFiles, files, Boolean(diff), omitted),
    branch,
    changedFiles,
    diff,
    files,
    omitted,
  };
}

function buildContextSummary(
  branch: string | undefined,
  changedFiles: string[],
  files: ContextBundle["files"],
  hasDiff: boolean,
  omitted: string[],
): string {
  return [
    branch ? `Git branch: ${branch}` : "Git branch: unavailable",
    `Changed files: ${changedFiles.length ? changedFiles.join(", ") : "none or unavailable"}`,
    `Included files: ${files.length ? files.map((file) => file.path).join(", ") : "none"}`,
    `Git diff included: ${hasDiff ? "yes" : "no"}`,
    omitted.length ? `Omitted: ${omitted.join("; ")}` : "Omitted: none",
  ].join("\n");
}
