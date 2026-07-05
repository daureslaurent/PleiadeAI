import { Types } from 'mongoose';
import { SkillModel, type SkillDoc } from './skill.model';

export const skillRepository = {
  findById(id: string | Types.ObjectId): Promise<SkillDoc | null> {
    return SkillModel.findById(id).exec();
  },

  findByName(name: string): Promise<SkillDoc | null> {
    return SkillModel.findOne({ name }).exec();
  },

  /** Resolve several skills by name (used by the tool registry when assembling an agent). */
  findByNames(names: string[]): Promise<SkillDoc[]> {
    return SkillModel.find({ name: { $in: names } }).exec();
  },

  list(): Promise<SkillDoc[]> {
    return SkillModel.find().sort({ name: 1 }).exec();
  },

  /** Durable circuit-breaker trip: disable a skill until an operator re-enables it. */
  disable(name: string, reason: string): Promise<SkillDoc | null> {
    return SkillModel.findOneAndUpdate(
      { name },
      { $set: { enabled: false, disabled_reason: reason }, $inc: { failure_count: 1 } },
      { new: true },
    ).exec();
  },

  enable(name: string): Promise<SkillDoc | null> {
    return SkillModel.findOneAndUpdate(
      { name },
      { $set: { enabled: true, disabled_reason: null } },
      { new: true },
    ).exec();
  },
};
