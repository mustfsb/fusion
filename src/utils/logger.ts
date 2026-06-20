export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const consoleLogger: Logger = {
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
