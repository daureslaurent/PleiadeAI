import pino, { type Logger } from 'pino';
import { env, isProduction } from './env';

/**
 * Root Pino logger for the fine-tune service. Structured JSON in production (ideal for
 * post-mortems on multi-hour headless training runs); pretty-printed in development.
 *
 * Copied from the main backend's `config/logger.ts` so both services log identically.
 */
export const rootLogger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'pleiade-finetune' },
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
      'FINETUNE_API_KEY',
      'HF_TOKEN',
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
 * filtered per subsystem (e.g. `server`, `trainer`, `webhook`).
 */
export function createLogger(
  component: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return rootLogger.child({ component, ...bindings });
}
