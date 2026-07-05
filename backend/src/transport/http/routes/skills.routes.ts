import { Router } from 'express';
import { SkillModel } from '../../../domain/skills/skill.model';
import { skillRepository } from '../../../domain/skills/skill.repository';
import { circuitBreaker } from '../../../core/circuit-breaker/CircuitBreaker';

/** CRUD for dynamic skills (Monaco editor in the Matrix) + circuit re-enable. */
export const skillsRouter = Router();

skillsRouter.get('/', async (_req, res) => {
  res.json(await skillRepository.list());
});

skillsRouter.post('/', async (req, res) => {
  const skill = await SkillModel.create(req.body);
  res.status(201).json(skill);
});

skillsRouter.patch('/:id', async (req, res) => {
  const skill = await SkillModel.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  if (!skill) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(skill);
});

/** Operator re-enable: clears the durable flag and the in-memory circuit. */
skillsRouter.post('/:id/enable', async (req, res) => {
  const skill = await skillRepository.findById(req.params.id);
  if (!skill) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await skillRepository.enable(skill.name);
  circuitBreaker.reset(skill.name);
  res.json({ ok: true, name: skill.name });
});

skillsRouter.delete('/:id', async (req, res) => {
  const skill = await SkillModel.findByIdAndDelete(req.params.id);
  if (!skill) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});
