// Host self-update bridge — public surface. See update.ts (trigger files + status) and
// updateChecker.ts (periodic availability check).
export {
  requestUpdate,
  requestCheck,
  getUpdateReadiness,
  readUpdateStatus,
  readUpdateLog,
  getUpdateLogSize,
  type UpdateStatus,
  type UpdateCommit,
  type UpdateReadiness,
  type UpdateLogChunk,
} from './update';
export { runUpdateCheck, scheduleUpdateCheck, stopUpdateCheck } from './updateChecker';
