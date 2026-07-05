import mongoose from 'mongoose';
import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('mongoose');

/**
 * Establish the single shared Mongoose connection. All models register against the default
 * connection, so this must run once during boot before the HTTP/WS servers start accepting
 * traffic or Agenda begins scheduling.
 */
export async function connectMongo(): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => log.info('mongo connected'));
  mongoose.connection.on('disconnected', () => log.warn('mongo disconnected'));
  mongoose.connection.on('error', (err) => log.error({ err }, 'mongo connection error'));

  // Fail fast rather than buffering queries indefinitely if Mongo is unreachable at boot.
  mongoose.set('bufferTimeoutMS', 10_000);

  await mongoose.connect(env.MONGO_URI);
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
  log.info('mongo connection closed');
}
