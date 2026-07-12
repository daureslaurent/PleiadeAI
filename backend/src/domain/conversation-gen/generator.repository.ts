import type { Types } from 'mongoose';
import { ConversationGeneratorModel, type ConversationGeneratorDoc } from './generator.model';

/** Data-access for conversation generators (see `docs/conversation-generator.md`). */
export const generatorRepository = {
  list(): Promise<ConversationGeneratorDoc[]> {
    return ConversationGeneratorModel.find().sort({ created_at: -1 }).exec();
  },

  listEnabled(): Promise<ConversationGeneratorDoc[]> {
    return ConversationGeneratorModel.find({ enabled: true }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<ConversationGeneratorDoc | null> {
    return ConversationGeneratorModel.findById(id).exec();
  },

  create(input: {
    targetAgentId: string | Types.ObjectId;
    targetAgentName: string;
    interviewerAgentId: string | Types.ObjectId;
    enabled?: boolean;
    intervalMinutes?: number;
    turns?: number;
    topics?: string[];
  }): Promise<ConversationGeneratorDoc> {
    return ConversationGeneratorModel.create({
      target_agent_id: input.targetAgentId,
      target_agent_name: input.targetAgentName,
      interviewer_agent_id: input.interviewerAgentId,
      enabled: input.enabled ?? false,
      interval_minutes: input.intervalMinutes ?? 60,
      turns: input.turns ?? 3,
      topics: input.topics ?? [],
    });
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<{
      target_agent_id: string | Types.ObjectId;
      target_agent_name: string;
      interviewer_agent_id: string | Types.ObjectId;
      enabled: boolean;
      interval_minutes: number;
      turns: number;
      topics: string[];
    }>,
  ): Promise<ConversationGeneratorDoc | null> {
    return ConversationGeneratorModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<ConversationGeneratorDoc | null> {
    return ConversationGeneratorModel.findByIdAndDelete(id).exec();
  },

  /** Record the outcome of one run: a success bumps the count and clears the last error. */
  recordRun(
    id: string | Types.ObjectId,
    outcome: { error?: string },
  ): Promise<ConversationGeneratorDoc | null> {
    const set: Record<string, unknown> = { last_run_at: new Date(), last_error: outcome.error ?? '' };
    const update = outcome.error
      ? { $set: set }
      : { $set: set, $inc: { conversations_count: 1 } };
    return ConversationGeneratorModel.findByIdAndUpdate(id, update, { new: true }).exec();
  },
};
