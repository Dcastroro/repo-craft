---
name: craft-repository-skill
description: Create or update one concise repository-specific skill from verified code, documentation, commands, and domain evidence. Use after a skill opportunity has a clear trigger and durable workflow. Writes skill files, bundled references, and optional deterministic scripts; validates the result.
---

# Craft a repository skill

Create one skill with one job.

1. Confirm the trigger with a concrete user request.
2. Resolve authoritative sources and contradictions.
3. Choose the smallest useful bundle:
   - `SKILL.md` for decisions and sequence;
   - `references/` for detailed local knowledge;
   - `scripts/` only for repeated deterministic work.
4. Initialize with the available skill scaffold.
5. Write frontmatter with only `name` and a trigger-complete `description`.
6. Write the body in imperative form. Link every optional reference directly.
7. Add a maintenance signal: which source change makes the skill stale.
8. Validate structure and exercise bundled scripts.
9. Show the generated files and the evidence used.

Never copy a whole README into a skill. Never encode secrets, personal data, or
claims not supported by repository evidence.
