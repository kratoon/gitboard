/**
 * Where each coding agent discovers skills (ADR-992ea64). This is data, so a path change is a one-line
 * edit. Paths were verified on 2026-11-14 and must be re-verified when agents change (they move fast).
 */
export interface AgentDef {
  id: string;
  label: string;
  /** True when the agent reads the shared `.agents/skills/` directory, so it needs no copy of its own. */
  readsAgentsDir: boolean;
  /** Skills directory inside a repository (agents that do not read `.agents/skills/`). */
  projectDir?: string;
  /** Skills directory inside the user's home directory. */
  globalDir?: string;
}

/** The shared location every `.agents`-aware agent reads. */
export const SHARED_PROJECT_DIR = '.agents/skills';
export const SHARED_GLOBAL_DIR = '.agents/skills';
export const SKILL_NAME = 'gitboard';

export const AGENTS: readonly AgentDef[] = [
  { id: 'universal', label: 'Shared .agents/skills (Copilot, Codex, Cursor, Gemini CLI and others)', readsAgentsDir: true },
  { id: 'github-copilot', label: 'GitHub Copilot', readsAgentsDir: true },
  { id: 'codex', label: 'Codex', readsAgentsDir: true },
  { id: 'cursor', label: 'Cursor', readsAgentsDir: true },
  { id: 'gemini-cli', label: 'Gemini CLI', readsAgentsDir: true },
  { id: 'claude-code', label: 'Claude Code', readsAgentsDir: false, projectDir: '.claude/skills', globalDir: '.claude/skills' },
];

/** Installed when no `--agent` is given: the shared directory plus Claude Code. */
export const DEFAULT_AGENTS = ['universal', 'claude-code'] as const;

export function findAgent(id: string): AgentDef | undefined {
  return AGENTS.find((agent) => agent.id === id);
}
