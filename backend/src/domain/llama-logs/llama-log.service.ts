import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { llamaLogRepository } from './llama-log.repository';

const log = createLogger('llama-log-service');

let registered = false;

/**
 * Wire the LLM Debug persistence: subscribe to `llama:call_end` (emitted centrally by `LlamaClient`
 * for every HTTP call to the inference server) and fire-and-forget the record into both Mongo tiers.
 * Idempotent — safe to call once at boot. Persistence never blocks or breaks the inference path;
 * failures are logged and swallowed.
 */
export function registerLlamaLogSubscriber(): void {
  if (registered) return;
  registered = true;
  eventBus.on('llama:call_end', (payload) => {
    llamaLogRepository.insert(payload).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), callId: payload.id }, 'llama call persist failed');
    });
  });
  log.info('llama call capture persistence registered');
}
