import { Router } from 'express';
import { coreTools, getCoreTool } from '../../../tools/registry';
import { toolConfigService } from '../../../domain/tools/tool-config.service';

/**
 * Config surface for the Tools page. Lists every core tool with its declared option schema and
 * current effective values, and lets an operator toggle a tool on/off or tune its options.
 */
export const toolsRouter = Router();

/** All core tools + their schema, resolved current values, and enable state. */
toolsRouter.get('/', async (_req, res) => {
  const tools = coreTools();
  const payload = await Promise.all(
    tools.map(async (tool) => {
      const schema = tool.configSchema ?? [];
      const { enabled, config } = await toolConfigService.resolve(tool.name, schema);
      return {
        name: tool.name,
        description: tool.description,
        configSchema: schema,
        config,
        enabled,
      };
    }),
  );
  res.json(payload);
});

/** Persist enable state and/or option values for a single tool. */
toolsRouter.put('/:name', async (req, res) => {
  const tool = getCoreTool(req.params.name);
  if (!tool) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await toolConfigService.update(req.params.name, {
    enabled: req.body?.enabled,
    config: req.body?.config,
  });
  const schema = tool.configSchema ?? [];
  const { enabled, config } = await toolConfigService.resolve(tool.name, schema);
  res.json({ name: tool.name, description: tool.description, configSchema: schema, config, enabled });
});
