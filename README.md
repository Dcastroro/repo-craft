# Repo Craft

Repo Craft is a Codex plugin for turning repository evidence into concise,
high-signal agent skills.

It takes a deliberately opinionated approach: most repository information
should not become a skill. The plugin maps intent, measures context debt,
proposes only durable opportunities, crafts one focused skill at a time, and
reviews every result against a strict quality bar.

## Skills

- `map-repository-intent`: trace real boundaries and contradictions.
- `find-skill-opportunities`: find workflows that deserve agent context.
- `craft-repository-skill`: create one evidence-backed skill.
- `review-repository-skills`: reject noisy, unsafe, or stale skills.

## Context-debt scanner

```bash
node scripts/context-debt.mjs /path/to/repository
node scripts/context-debt.mjs /path/to/repository --json
```

The scanner is local-only, dependency-free, symlink-safe, and ignores build
outputs and dependency trees.

## Development

```bash
npm install
npm run check
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
```

## Install from source

Clone the repository and add its plugin root to your local Codex plugin
marketplace or development environment:

```bash
git clone https://github.com/Dcastroro/repo-craft.git
```
