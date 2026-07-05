import pino, { type Logger } from 'pino';
import { env, isProduction } from './env';

/**
 * Root Pino logger. Backend observability is structured JSON in production (ideal for
 * headless/background cron post-mortems); in development it pretty-prints for humans.
 *
 * Every subsystem should derive a child logger via `createLogger(component, bindings)`
 * so that hops, tool invocations, sandbox runs, and errors carry consistent context.
 */
export const rootLogger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'pleiade-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Redact anything that could leak secrets into logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'token',
      '*.token',
      'password',
      '*.password',
      'JWT_SECRET',
      'TELEGRAM_BOT_TOKEN',
    ],
    censor: '[redacted]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
});

/**
 * Create a scoped child logger. `component` is attached as a binding so logs can be
 * filtered per subsystem (e.g. `event-bus`, `skill-sandbox`, `agenda`, `ws`).
 */
export function createLogger(
  component: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return rootLogger.child({ component, ...bindings });
}
