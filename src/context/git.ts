import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 * 5 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function getGitBranch(cwd: string): Promise<string | undefined> {
  return git(["branch", "--show-current"], cwd);
}

export async function getGitDiff(cwd: string): Promise<string | undefined> {
  return git(["diff", "--no-ext-diff"], cwd);
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const output = await git(["diff", "--name-only"], cwd);
  return output ? output.split("\n").filter(Boolean) : [];
}
