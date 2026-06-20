export class FusionCouncilError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FusionCouncilError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
