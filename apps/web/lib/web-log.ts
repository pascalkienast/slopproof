import { createLogger, type Logger } from "@slopproof/observability";

let logger: Logger | undefined;

export function getWebLogger(): Logger {
  logger ??= createLogger(
    { service: "web", version: "0.1.0" },
    process.env.LOG_LEVEL ?? "info",
  );
  return logger;
}

export function setWebLoggerForTests(value: Logger | undefined): void {
  logger = value;
}
