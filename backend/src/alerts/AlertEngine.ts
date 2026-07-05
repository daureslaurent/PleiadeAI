import { Types } from 'mongoose';
import { createLogger } from '../config/logger';
import { notificationRepository } from '../domain/notifications/notification.repository';
import { telegramService } from './telegram.service';

const log = createLogger('alert-engine');

/**
 * Dual-alert fan-out (spec §5). A completed headless task pushes simultaneously to:
 *   1. a persistent `notifications` document (the UI inbox), and
 *   2. the external Telegram Bot API.
 *
 * Both legs run concurrently and failures are isolated: a Telegram outage never blocks the
 * durable Mongo record, and vice-versa.
 */
export const alertEngine = {
  async dispatch(input: {
    agentId: string | Types.ObjectId;
    title: string;
    content: string;
  }): Promise<void> {
    const results = await Promise.allSettled([
      notificationRepository.create({
        agent_id: input.agentId,
        title: input.title,
        content: input.content,
      }),
      telegramService.send(input.title, input.content),
    ]);

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        log.error({ leg: i === 0 ? 'mongo' : 'telegram', err: r.reason }, 'alert leg failed');
      }
    });
  },
};
