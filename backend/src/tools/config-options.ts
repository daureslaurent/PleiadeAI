import { createLogger } from '../config/logger';
import { agentRepository } from '../domain/agents/agent.repository';
import { flowRepository } from '../domain/flows/flow.repository';
import { mediaWorkflowRepository } from '../domain/media-workflows/media-workflow.repository';
import { WORKFLOW_KINDS, type WorkflowKind } from '../domain/media-workflows/media-workflow.model';
import { skillRepository } from '../domain/skills/skill.repository';
import { toolConfigService } from '../domain/tools/tool-config.service';
import { coreTools } from './registry';
import type { ToolConfigField } from './types';

const log = createLogger('tool-config-options');

export interface ConfigOption {
  value: string;
  label: string;
}

/**
 * Providers for `ToolConfigField.optionsSource`.
 *
 * A tool's `configSchema` is a static module-level constant, which is right for fixed choices (image
 * sizes, sampler names) and wrong for anything the operator maintains in the database. The media
 * tools need "which of my imported ComfyUI workflows should this use", a list that changes without a
 * redeploy — so the schema names a source and the Tools route resolves it on the way out.
 */
const PROVIDERS: Record<string, () => Promise<ConfigOption[]>> = {
  ...Object.fromEntries(
    WORKFLOW_KINDS.map((kind: WorkflowKind) => [
      `media_workflows:${kind}`,
      async () => {
        const docs = await mediaWorkflowRepository.listEnabled(kind);
        return docs.map((doc) => ({
          value: String(doc._id),
          label: doc.avg_duration_ms
            ? `${doc.name} (~${Math.round(doc.avg_duration_ms / 1000)}s)`
            : doc.name,
        }));
      },
    ]),
  ),

  // The three below exist for the Flows node registry (FLOWS_PLAN.md §3), whose config schemas go
  // through this same resolver: a node picks the agent it delegates to, the tool it calls, or the
  // flow it nests — all lists that change without a redeploy.
  agents: async () => {
    const agents = await agentRepository.list();
    return agents.map((a) => ({
      value: a.name,
      label: a.description ? `${a.name} — ${a.description.slice(0, 60)}` : a.name,
    }));
  },

  tools: async () => {
    const disabled = await toolConfigService.disabledNames();
    const core = coreTools()
      .filter((t) => !disabled.has(t.name))
      .map((t) => ({ value: t.name, label: t.name }));
    const skills = (await skillRepository.list()).filter((s) => s.enabled);
    return [...core, ...skills.map((s) => ({ value: s.name, label: `${s.name} (skill)` }))].sort((a, b) =>
      a.value.localeCompare(b.value),
    );
  },

  flows: async () => {
    const flows = await flowRepository.listEnabled();
    return flows.map((f) => ({ value: String(f._id), label: f.name }));
  },
};

/** Placeholder so an unconfigured field reads as unconfigured rather than as "the first option". */
const NONE: ConfigOption = { value: '', label: 'None — pick one' };

/**
 * Resolve every dynamic field in a tool's schema against the live database.
 *
 * Two synthetic entries keep the select honest: a leading "None", and — when the stored value no
 * longer exists (the operator deleted or disabled that workflow) — a `(missing)` entry for it. Without
 * the latter the `<select>` would silently render the *first* option as if it were the saved one, and
 * the operator would never learn their tool is pointing at nothing.
 */
export async function resolveDynamicOptions(
  schema: ToolConfigField[],
  config: Record<string, unknown>,
): Promise<ToolConfigField[]> {
  if (!schema.some((f) => f.optionsSource)) return schema;

  return Promise.all(
    schema.map(async (field) => {
      const provider = field.optionsSource ? PROVIDERS[field.optionsSource] : undefined;
      if (!provider) return field;

      let options: ConfigOption[] = [];
      try {
        options = await provider();
      } catch (err) {
        log.warn({ source: field.optionsSource, err: String(err) }, 'options provider failed');
      }

      const current = config[field.key];
      const all = [NONE, ...options];
      if (typeof current === 'string' && current && !options.some((o) => o.value === current)) {
        all.push({ value: current, label: `(missing) ${current}` });
      }

      return {
        ...field,
        options: all.map((o) => o.value),
        optionLabels: Object.fromEntries(all.map((o) => [o.value, o.label])),
      };
    }),
  );
}
