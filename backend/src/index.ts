import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { rootLogger } from './config/logger';
import { connectMongo, disconnectMongo } from './db/mongoose';
import { setupAgenda } from './autonomy/agenda.setup';
import { attachSocket } from './transport/ws/socket';
import { requireAuth } from './transport/http/middleware/auth';
import { authRouter } from './transport/http/routes/auth.routes';
import { agentsRouter } from './transport/http/routes/agents.routes';
import { sessionsRouter } from './transport/http/routes/sessions.routes';
import { skillsRouter } from './transport/http/routes/skills.routes';
import { memoryRouter } from './transport/http/routes/memory.routes';
import { inboxRouter } from './transport/http/routes/inbox.routes';
import { autonomyRouter } from './transport/http/routes/autonomy.routes';
import { settingsRouter } from './transport/http/routes/settings.routes';
import { endpointsRouter } from './transport/http/routes/endpoints.routes';
import { llmRouter } from './transport/http/routes/llm.routes';
import { endpointService } from './domain/endpoints/endpoint.service';
import { toolsRouter } from './transport/http/routes/tools.routes';
import { isolationsRouter } from './transport/http/routes/isolations.routes';
import { transferRouter } from './transport/http/routes/transfer.routes';
import { hostRouter } from './transport/http/routes/host.routes';
import { scheduleUpdateCheck } from './host';
import { settingsService } from './domain/settings/settings.service';
import { telegramBot } from './telegram/TelegramBot';

/**
 * Composition root. Boot order matters: Mongo must connect before Agenda (which stores jobs in
 * it) and before any route serves traffic; the HTTP server and socket.io share one listener.
 */
async function main(): Promise<void> {
  await connectMongo();

  // Register/refresh the built-in local docker fallback endpoint and discover its model in the
  // background. Best-effort: never blocks or fails boot if the fallback container isn't up yet.
  endpointService.ensureLocalFallback().catch((err) => rootLogger.error({ err }, 'ensureLocalFallback failed'));

  const app = express();
  // Browser calls the API cross-origin (frontend :3000 → backend :4000); allow it.
  app.use(cors());
  app.use(express.json({ limit: '25mb' })); // headroom for Base64 image payloads

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Public auth, then everything else behind the JWT guard.
  app.use('/api/auth', authRouter);
  app.use('/api/agents', requireAuth, agentsRouter);
  app.use('/api/sessions', requireAuth, sessionsRouter);
  app.use('/api/skills', requireAuth, skillsRouter);
  app.use('/api/memory', requireAuth, memoryRouter);
  app.use('/api/inbox', requireAuth, inboxRouter);
  app.use('/api/autonomy', requireAuth, autonomyRouter);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use('/api/endpoints', requireAuth, endpointsRouter);
  app.use('/api/llm', requireAuth, llmRouter);
  app.use('/api/tools', requireAuth, toolsRouter);
  app.use('/api/isolations', requireAuth, isolationsRouter);
  app.use('/api/transfer', requireAuth, transferRouter);
  app.use('/api/host', requireAuth, hostRouter);

  const httpServer = http.createServer(app);
  attachSocket(httpServer);
  await setupAgenda();
  // Interactive Telegram bot (long-poll). Best-effort: a Telegram outage never blocks boot.
  telegramBot.start().catch((err) => rootLogger.error({ err }, 'telegram bot failed to start'));

  // Periodic host update check (only actually runs when update_enabled is on — see runUpdateCheck).
  settingsService
    .get()
    .then((s) => {
      if (s.update_enabled) scheduleUpdateCheck(s.update_check_interval_hours);
    })
    .catch((err) => rootLogger.error({ err }, 'failed to schedule update check'));

  httpServer.listen(env.PORT, () => {
    rootLogger.info({ port: env.PORT }, 'pleiade backend listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    rootLogger.info({ signal }, 'shutting down');
    telegramBot.stop();
    httpServer.close();
    await disconnectMongo();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.error({ err }, 'fatal boot error');
  process.exit(1);
});
