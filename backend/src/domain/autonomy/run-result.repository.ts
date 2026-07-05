import { RunResultModel, type RunResultDoc } from './run-result.model';

export const runResultRepository = {
  record(input: {
    schedule_id: string;
    agent_name: string;
    prompt: string;
    status: 'success' | 'error';
    output: string;
    started_at: Date;
  }): Promise<RunResultDoc> {
    return RunResultModel.create({ ...input, finished_at: new Date() });
  },

  /** All results for one schedule, newest first. */
  listBySchedule(scheduleId: string): Promise<RunResultDoc[]> {
    return RunResultModel.find({ schedule_id: scheduleId }).sort({ finished_at: -1 }).exec();
  },
};
