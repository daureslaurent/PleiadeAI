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
import {
  androidUi,
  androidScreenshot,
  androidAct,
  androidApp,
  androidShell,
  androidLogcat,
  androidFile,
} from './core/android';
import { analyzeImage } from './core/analyzeImage';
import { editImage, generateImage, generateSound, generateVideo } from './core/media';
import { data } from './core/data';
import { runFlow } from './core/runFlow';
import { forum } from './core/forum';
import { forumAdmin } from './core/forumAdmin';
import { listMail, readMail } from './core/mail';
import { guide } from './core/guide';
import { todoWrite } from './core/todo';
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

/**
 * Names of the Android control tools. Auto-added by `AgentRunner` when the agent is linked to a
 * device (`agent.android_device_id`) — the Android equivalent of the `visual` image flag, except the
 * trigger is the *device* link rather than the image, because one Android image serves any number of
 * agents pointed at different phones. The global kill-switch in `resolveTools` still applies.
 */
export const ANDROID_TOOL_NAMES = [
  'android_ui',
  'android_screenshot',
  'android_act',
  'android_app',
  'android_shell',
  'android_logcat',
  'android_file',
] as const;

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
  // Android device control — auto-granted to agents linked to a device (see AgentRunner).
  [androidUi.name]: androidUi,
  [androidScreenshot.name]: androidScreenshot,
  [androidAct.name]: androidAct,
  [androidApp.name]: androidApp,
  [androidShell.name]: androidShell,
  [androidLogcat.name]: androidLogcat,
  [androidFile.name]: androidFile,
  [analyzeImage.name]: analyzeImage,
  // Media generation via the configured ComfyUI server, each running an operator-chosen workflow
  // (opt-in per agent via tools_allowed). Video especially is slow and GPU-expensive — grant it
  // deliberately.
  [generateImage.name]: generateImage,
  [generateVideo.name]: generateVideo,
  [generateSound.name]: generateSound,
  [editImage.name]: editImage,
  // Operator-authored pipelines (FLOWS_PLAN.md). Opt-in per agent: a flow can spend real GPU time,
  // so an agent gets to fire one only when the operator says so.
  [runFlow.name]: runFlow,
  [forum.name]: forum,
  [forumAdmin.name]: forumAdmin,
  // Read-only Gmail (opt-in via tools_allowed + a per-agent mailbox grant on the Agents page).
  [listMail.name]: listMail,
  [readMail.name]: readMail,
  // Session resource pool (list/save/store) — auto-granted to every agent (see AgentRunner).
  [data.name]: data,
  // Man-style tool/workflow guides — auto-granted to every agent (see AgentRunner).
  [guide.name]: guide,
  // The agent's own working checklist — auto-granted to every agent (see AgentRunner).
  [todoWrite.name]: todoWrite,
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
      if (!disabled.has(name)) {
        // A dynamic tool (e.g. a media tool reflecting its configured ComfyUI workflow's bindings)
        // gets a shallow-copied schema each call — CORE_TOOLS entries are shared across every
        // concurrent agent turn and must never be mutated in place.
        resolved.push(
          core.resolveParameters ? { ...core, parameters: await core.resolveParameters() } : core,
        );
      }
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
