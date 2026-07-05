/**
 * Default per-agent Dockerfile. Ships the runtimes the agent's execution needs out of the box:
 * `bash` (terminal tool), `python3` (Python skills), `node` (TS skills, transpiled to CJS), plus
 * `git` and a build toolchain. The operator may edit this freely in the Agents page — but if a
 * required runtime is removed, the matching execution will fail at run time (see `assertRuntimes`).
 */
export const DEFAULT_DOCKERFILE = `# Per-agent isolated runtime.
# Requirements: bash, python3, and node must remain available for the terminal tool and skills.
FROM node:22-bookworm-slim

# Core runtimes + common CLI tooling. Add whatever your agent needs below.
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash python3 python3-pip git curl ca-certificates build-essential \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# --- Add your customisations here (apt/pip/npm installs, tools, env, etc.) ---
`;

/** Runtimes the isolation layer relies on being present in the built image. */
const REQUIRED = ['bash', 'python3', 'node'] as const;

/**
 * Best-effort static lint of an edited Dockerfile: warn (not block) when a `FROM` looks like it
 * won't provide one of the required runtimes and the file never installs it. Purely heuristic —
 * we only flag when we're fairly confident, to keep false positives low.
 */
export function assertRuntimes(dockerfile: string): string[] {
  const text = dockerfile.toLowerCase();
  const warnings: string[] = [];
  for (const rt of REQUIRED) {
    // node images ship node; python images ship python3; almost everything ships bash except
    // bare alpine (which ships `sh`). Flag only when the runtime name appears nowhere.
    const mentioned = text.includes(rt) || (rt === 'python3' && text.includes('python'));
    if (!mentioned) {
      warnings.push(
        `Dockerfile does not appear to provide "${rt}" — ${labelFor(rt)} may fail in this image.`,
      );
    }
  }
  if (text.includes('alpine') && !text.includes('bash')) {
    warnings.push('Alpine base without `apk add bash`: the bash tool needs GNU bash, not busybox sh.');
  }
  return warnings;
}

function labelFor(rt: (typeof REQUIRED)[number]): string {
  return rt === 'bash' ? 'the bash tool' : rt === 'python3' ? 'Python skills' : 'TypeScript skills';
}
