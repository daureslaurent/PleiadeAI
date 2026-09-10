import {
  androidModule,
  apisModule,
  automationModule,
  desktopModule,
  filesModule,
  flowsModule,
  mailModule,
  shellModule,
  visualsModule,
  webModule,
} from './definitions/capabilities';
import { environmentModule, sessionModule, toolUseModule } from './definitions/core';
import { modesModule } from './definitions/modes';
import { agentsMdModule, houseRulesModule, parametersModule } from './definitions/operator';
import { memoryModule, notebookModule, todoModule } from './definitions/self';
import { autoLoopModule, boardModule, forumModule, orchestrationModule } from './definitions/work';
import type { BlockPlacement, PromptBlock, PromptModule } from './types';

/**
 * The register (`MODULES_PLAN.md` §3). Declaration order is only the order rows appear inside a
 * group on the settings page — where a *block* lands is decided by its `placement` + `order`, never
 * by this array, so a module can be moved here without changing a single prompt.
 */
export const MODULES: PromptModule[] = [
  // core
  environmentModule,
  toolUseModule,
  sessionModule,
  // operator-owned
  houseRulesModule,
  agentsMdModule,
  parametersModule,
  modesModule,
  // the agent's own state
  notebookModule,
  todoModule,
  memoryModule,
  // work
  orchestrationModule,
  boardModule,
  forumModule,
  autoLoopModule,
  // capabilities
  visualsModule,
  filesModule,
  shellModule,
  webModule,
  apisModule,
  flowsModule,
  automationModule,
  mailModule,
  desktopModule,
  androidModule,
];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export function moduleById(id: string): PromptModule | undefined {
  return BY_ID.get(id);
}

/** Whether a module ships on. Only the board ships off, for the reason its definition gives. */
export function moduleDefaultEnabled(m: PromptModule): boolean {
  return m.defaultEnabled !== false;
}

const OWNER_BY_TOOL = new Map<string, PromptModule>();
for (const m of MODULES) {
  for (const tool of m.tools ?? []) {
    if (OWNER_BY_TOOL.has(tool)) {
      throw new Error(
        `module registry: tool '${tool}' is claimed by both '${OWNER_BY_TOOL.get(tool)!.id}' and '${m.id}'`,
      );
    }
    OWNER_BY_TOOL.set(tool, m);
  }
}

/**
 * The module that owns a core tool, if any. A tool nobody claims (a skill, or a core tool added
 * without a module) is never gated — an unclaimed tool is a registry bug, not a reason to make it
 * unreachable.
 */
export function toolOwner(name: string): PromptModule | undefined {
  return OWNER_BY_TOOL.get(name);
}

/** Every block of every module at one placement, in the order they render. */
export function blocksAt(placement: BlockPlacement): { module: PromptModule; block: PromptBlock }[] {
  const out = MODULES.flatMap((module) =>
    (module.blocks ?? []).filter((b) => b.placement === placement).map((block) => ({ module, block })),
  );
  return out.sort((a, b) => a.block.order - b.block.order);
}

/** Titles of every declared block, by placement — what `prompt-usage` uses to cut a message apart. */
export function blockTitles(placement: BlockPlacement): string[] {
  return blocksAt(placement).map(({ block }) => block.title);
}
