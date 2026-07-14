import { Router } from 'express';
import { notificationRepository } from '../../../domain/notifications/notification.repository';

/** Persistent notifications inbox (Autonomy & Inbox Monitor). */
export const inboxRouter = Router();

inboxRouter.get('/', async (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  res.json(await notificationRepository.list({ agentId, unreadOnly }));
});

inboxRouter.get('/unread-count', async (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  res.json({ count: await notificationRepository.countUnread(agentId) });
});

inboxRouter.post('/:id/read', async (req, res) => {
  const n = await notificationRepository.markRead(req.params.id);
  if (!n) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(n);
});

inboxRouter.post('/read-all', async (req, res) => {
  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : undefined;
  res.json({ updated: await notificationRepository.markAllRead(agentId) });
});

/** Bulk-delete every already-read notification (inbox housekeeping). */
inboxRouter.post('/clear-read', async (req, res) => {
  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : undefined;
  res.json({ deleted: await notificationRepository.clearRead(agentId) });
});

inboxRouter.delete('/:id', async (req, res) => {
  const n = await notificationRepository.remove(req.params.id);
  if (!n) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});
