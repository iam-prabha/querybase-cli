import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  base: { service: "querybase", version: process.env.npm_package_version },
});

export function childLogger(name: string) {
  return logger.child({ command: name });
}