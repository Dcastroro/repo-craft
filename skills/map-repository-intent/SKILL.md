---
name: map-repository-intent
description: Map a repository's real architecture, operating constraints, domain boundaries, commands, and contradictions before implementation. Use when entering an unfamiliar codebase, planning a cross-cutting change, or deciding what context an agent needs. Read-only; produce evidence, not files.
---

# Map repository intent

Build the smallest map that prevents expensive mistakes.

1. Read root instructions, manifests, CI, and the target area's nearest guidance.
2. Trace one representative path from entrypoint to domain to persistence.
3. Compare documented boundaries with actual imports and commands.
4. Name contradictions; do not silently choose one source.
5. Resolve the plugin root from this skill path and run
   `node <plugin-root>/scripts/context-debt.mjs <repo> --json`.
6. Return:
   - governing sources;
   - architecture and ownership boundaries;
   - real validation commands;
   - sensitive surfaces;
   - contradictions and unknowns;
   - context worth turning into a skill.

Do not summarize every directory. Omit facts an agent can rediscover cheaply.
