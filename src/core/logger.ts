import pino, { type Logger } from 'pino';

export type { Logger };

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Structured logger.
 *
 * Pretty output for humans at a TTY, newline-delimited JSON everywhere else so
 * CI log processors (including Azure DevOps) can parse it.
 */
export function createLogger(level: LogLevel = 'info', pretty = process.stdout.isTTY): Logger {
  if (pretty) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }
  return pino({ level });
}

/** Shared no-op logger for tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
