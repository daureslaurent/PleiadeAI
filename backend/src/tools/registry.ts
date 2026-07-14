import { createLogger } from '../config/logger';
import { skillRepository } from '../domain/skills/skill.repository';
import { toolConfigService } from '../domain/tools/tool-config.service';
import { skillRunner } from './sandbox/SkillRunner';
import { setAgentParameter } from './core/setAgentParameter';
import { updateNotebook } from './core/updateNotebook';
import { webSearch } from './core/webSearch';
import { webFetch } from './core/webFetch';
import { remember } from './core/remember';
import { forget } from './core/forget';
import { askAgent } from './core/askAgent';
import { askParent } from './core/askParent';
import { askUser } from './core/askUser';
import { annuaire } from './core/annuaire';
import { bash } from './core/bash';
import { scheduleTask } from './core/scheduleTask';
import { visualScreenshot, visualAct, visualClick, visualWindows } from './core/visual';
import { analyzeImage } from './core/analyzeImage';
import { generateImage } from './core/generateImage';
import { data } from './core/data';
import { listMail, readMail } from './core/mail';
import { guide } from './core/guide';
import { read } from './core/fs/read';
import { write } from './core/fs/write';
import { edit } from './core/fs/edit';
import { list } from './core/fs/list';
import { glob } from './core/fs/glob';
import { grep } from './core/fs/grep';
import { patch } from './core/fs/patch';
import type { Tool } from './types';

const log = createLogger('tool-registry');

/**
 * Names of the visual-desktop control tools. Auto-added to an agent's toolset by `AgentRunner` when
 * the agent's isolation image is flagged `visual` (like `annuaire`/`ask_agent` are always granted to
 * top-level agents). The global kill-switch in `resolveTools` still applies.
 */
export const VISUAL_TOOL_NAMES = ['visual_screenshot', 'visual_act', 'visual_click', 'visual_windows'] as const;

/** Static core tools every agent implicitly gets, keyed by name. */
const CORE_TOOLS: Record<string, Tool> = {
  [setAgentParameter.name]: setAgentParameter,
  [updateNotebook.name]: updateNotebook,
  [webSearch.name]: webSearch,
  [webFetch.name]: webFetch,
  [remember.name]: remember,
  [forget.name]: forget,
  [askAgent.name]: askAgent,
  [askParent.name]: askParent,
  [askUser.name]: askUser,
  [annuaire.name]: annuaire,
  [bash.name]: bash,
  [scheduleTask.name]: scheduleTask,
  // Visual-desktop control — auto-granted to agents on a visual isolation image (see AgentRunner).
  [visualScreenshot.name]: visualScreenshot,
  [visualAct.name]: visualAct,
  [visualClick.name]: visualClick,
  [visualWindows.name]: visualWindows,
  [analyzeImage.name]: analyzeImage,
  // Text-to-image generation via the configured Image endpoint (opt-in per agent via tools_allowed).
  [generateImage.name]: generateImage,
  // Read-only Gmail (opt-in via tools_allowed + a per-agent mailbox grant on the Agents page).
  [listMail.name]: listMail,
  [readMail.name]: readMail,
  // Session resource pool (list/save/store) — auto-granted to every agent (see AgentRunner).
  [data.name]: data,
  // Man-style tool/workflow guides — auto-granted to every agent (see AgentRunner).
  [guide.name]: guide,
  // OpenCode-compatible file tools (opt-in per agent via tools_allowed).
  [read.name]: read,
  [write.name]: write,
  [edit.name]: edit,
  [list.name]: list,
  [glob.name]: glob,
  [grep.name]: grep,
  [patch.name]: patch,
};

/**
 * Resolve an agent's `tools_allowed` list into concrete callable tools.
 *
 * Names that match a core tool bind directly; the rest are looked up as dynamic skills and
 * wrapped so the LLM sees them as ordinary tools while execution routes through the sandbox
 * (with its timeout + circuit breaker). Disabled skills are silently omitted so a tripped
 * skill simply disappears from the agent's toolset until re-enabled.
 */
export async function resolveTools(toolsAllowed: string[]): Promise<Tool[]> {
  const resolved: Tool[] = [];
  const skillNames: string[] = [];
  const disabled = await toolConfigService.disabledNames();

  for (const name of toolsAllowed) {
    const core = CORE_TOOLS[name];
    if (core) {
      // Honour the operator's global kill-switch from the Tools page.
      if (!disabled.has(name)) resolved.push(core);
    } else skillNames.push(name);
  }

  if (skillNames.length) {
    const skills = await skillRepository.findByNames(skillNames);
    for (const skill of skills) {
      if (!skill.enabled) {
        log.debug({ skill: skill.name }, 'skipping disabled skill');
        continue;
      }
      resolved.push(wrapSkill(skill));
    }
  }

  return resolved;
}

/** Adapt a stored skill document into the Tool interface. */
function wrapSkill(skill: import('../domain/skills/skill.model').SkillDoc): Tool {
  return {
    name: skill.name,
    description: skill.description || `Dynamic ${skill.language} skill`,
    parameters:
      (skill.parameters_schema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    execute: (args, ctx) => skillRunner.run(skill, args, ctx),
  };
}

/** Always-available core tools (used when assembling the base toolset). */
export function coreTools(): Tool[] {
  return Object.values(CORE_TOOLS);
}

/** Look up a single core tool by name (used by the Tools config API). */
export function getCoreTool(name: string): Tool | undefined {
  return CORE_TOOLS[name];
}
