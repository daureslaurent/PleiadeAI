import { Router } from 'express';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { settingsService } from '../../../domain/settings/settings.service';
import {
  ModuleError,
  deleteCustomModule,
  listModules,
  setModuleEnabled,
  setModuleOverrides,
  setModuleSubagentEnabled,
  upsertCustomModule,
} from '../../../modules/admin.service';
import { previewPrompt } from '../../../modules/preview';
import { moduleStateFrom } from '../../../modules/state.service';
import { getCoreTool } from '../../../tools/registry';
import { toolConfigService } from '../../../domain/tools/tool-config.service';

/**
 * `Settings → Modules` (`MODULES_PLAN.md` §8). One module is a slice of what this instance is made
 * of — its prompt blocks, the tools those blocks talk about, and the settings that tune it — so the
 * list hands back all three, plus whether each owned tool is *individually* switched off, since
 * both switches have to say yes for an agent to see it.
 */
export const modulesRouter = Router();

function fail(res: import('express').Response, err: unknown): void {
  if (err instanceof ModuleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

modulesRouter.get('/', async (_req, res) => {
  const [{ modules, custom }, toolsDisabled] = await Promise.all([
    listModules(),
    toolConfigService.disabledNames(),
  ]);
  res.json({
    modules: modules.map((m) => ({
      ...m,
      tools: m.tools.map((name) => ({
        name,
        description: getCoreTool(name)?.description ?? '',
        // A tool the module owns can still be off on its own — the module is the coarse switch.
        enabled: !toolsDisabled.has(name),
      })),
    })),
    custom,
  });
});

/** Toggle a built-in module, and/or rewrite the wording of one of its static blocks. */
modulesRouter.put('/:id', async (req, res) => {
  try {
    if (req.body?.enabled !== undefined) await setModuleEnabled(req.params.id, Boolean(req.body.enabled));
    // The subagent profile (`SUBAGENT_PLAN.md` §3): whether the module also applies in a `task` child.
    if (req.body?.subagent !== undefined) {
      await setModuleSubagentEnabled(req.params.id, Boolean(req.body.subagent));
    }
    if (req.body?.overrides && typeof req.body.overrides === 'object') {
      await setModuleOverrides(req.params.id, req.body.overrides as Record<string, string | null>);
    }
  } catch (err) {
    return fail(res, err);
  }
  const { modules, custom } = await listModules();
  res.json(modules.find((m) => m.id === req.params.id) ?? custom.find((m) => m.id === req.params.id) ?? null);
});

/** Create or update an operator-authored module. */
modulesRouter.post('/custom', async (req, res) => {
  try {
    res.json(await upsertCustomModule(req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

modulesRouter.delete('/custom/:id', async (req, res) => {
  try {
    await deleteCustomModule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The prompt one agent would be given under the current switches. Rendered from the agent's real
 * charter and the fleet's real house rules, with sample data standing in for anything that would
 * otherwise cost a retrieval — see `previewContext`.
 */
modulesRouter.post('/preview', async (req, res) => {
  const agentId = String(req.body?.agentId ?? '');
  const agent = agentId ? await agentRepository.findById(agentId) : null;
  if (!agent) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const settings = await settingsService.get();
  const state = moduleStateFrom(settings as unknown as Record<string, unknown>);
  // `scope: 'subagent'` previews what a `task` child of this agent is given instead.
  const scope = req.body?.scope === 'subagent' ? 'subagent' : 'turn';
  res.json(previewPrompt(state, agent, settings.agents_md, scope));
});
