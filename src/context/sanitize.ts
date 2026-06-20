const deniedSegments = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const deniedBasenames = [/^\.env(?:\..*)?$/i];
const deniedExtensions = new Set([".pem", ".key", ".p12", ".sqlite", ".db"]);

export function isDeniedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => deniedSegments.has(part))) return true;
  const basename = parts.at(-1) ?? normalized;
  if (deniedBasenames.some((pattern) => pattern.test(basename))) return true;
  const lower = basename.toLowerCase();
  return [...deniedExtensions].some((extension) => lower.endsWith(extension));
}

export function sanitizeText(input: string): string {
  return input
    .replace(/^([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*).+$/gim, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED]")
    .replace(/(sk-proj-[A-Za-z0-9_-]{16,})/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}
