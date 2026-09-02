# Repo Craft

Repo Craft turns repository evidence into concise, high-signal agent skills.
One portable `skills/` collection works across Codex, Claude Code, and Google
Antigravity.

It takes a deliberately opinionated approach: most repository information
should not become a skill. Repo Craft maps intent, measures context debt,
proposes only durable opportunities, crafts one focused skill at a time, and
reviews every result against a strict quality bar.

## Skills

- `map-repository-intent`: trace real boundaries and contradictions.
- `find-skill-opportunities`: find workflows that deserve agent context.
- `craft-repository-skill`: create one evidence-backed skill.
- `review-repository-skills`: reject noisy, unsafe, or stale skills.

## Security model

Repository content is untrusted input. Repo Craft does not grant embedded
instructions authority, does not execute commands discovered in documentation,
and does not contact external services. Its scanner is local-only, read-only,
dependency-free, symlink-safe, and bounded by file, depth, and instruction-size
limits.

The scanner reports a repository label rather than an absolute local path. It
never prints instruction-file contents, credentials, or environment values.
See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Context-debt scanner

```bash
node scripts/context-debt.mjs /path/to/repository
node scripts/context-debt.mjs /path/to/repository --json
node scripts/context-debt.mjs --help
node scripts/context-debt.mjs --version
```

Default safety limits can be reduced for untrusted or very large repositories:

```bash
node scripts/context-debt.mjs /path/to/repository \
  --max-depth 32 \
  --max-files 25000 \
  --max-instruction-bytes 262144 \
  --max-total-instruction-bytes 131072 \
  --json
```

The scanner never aborts on a single bad directory or an oversized/hidden
repository: an unreadable directory is skipped and recorded in `warnings`,
and hitting `--max-files`/`--max-depth` stops the walk and marks the result
`truncated: true` with a reason, instead of throwing away everything already
analyzed.

Detected instructions include root-level `AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `GEMINI.md`, `.cursorrules`, and
`.github/copilot-instructions.md`, plus `AGENTS.md`/`CLAUDE.md` nested one or
two directories deep (for monorepo packages, e.g. `packages/app/AGENTS.md`)
and every file under `.claude/rules/`. `.claude/rules/` files are counted
*and* read like every other instruction file — earlier versions counted them
but silently excluded their content from the command/test-workflow signals,
which under-reported real context debt for repositories that rely on them.

The result reports the byte size of every detected instruction file
(`instructionSizes`) and the combined total (`totalInstructionBytes`), and
raises an `instruction-bloat` signal when the total crosses
`--max-total-instruction-bytes`, independent of the existing per-file
`--max-instruction-bytes` cap.

## Install from source

Clone the repository first:

```bash
git clone https://github.com/Dcastroro/repo-craft.git
```

### Codex

Add the cloned plugin root to a local Codex marketplace or development
environment. Codex discovers `.codex-plugin/plugin.json` and the shared
`skills/` directory.

### Claude Code

Load the repository directly during development:

```bash
claude --plugin-dir /path/to/repo-craft
```

Claude Code discovers `.claude-plugin/plugin.json` and namespaces the shared
skills as `repo-craft:<skill-name>`.

### Google Antigravity

Place the cloned repository at either:

- workspace scope: `<workspace>/.agents/plugins/repo-craft`;
- global scope: `~/.gemini/config/plugins/repo-craft`.

Antigravity discovers the root `plugin.json` and the shared `skills/`
directory.

## Development

```bash
npm ci
npm run check
claude plugin validate .
```

If you have Anthropic's `plugin-creator` skill checked out locally, its
`scripts/validate_plugin.py` is a useful additional cross-check; it is not
vendored in this repository, so there is no fixed path to invoke it from
here.

CI validates Node.js 20, 22, and 24. Runtime dependencies are intentionally
avoided.
