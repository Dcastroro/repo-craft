---
name: find-skill-opportunities
description: Find high-value repository workflows that should become skills and reject knowledge that should remain code, tests, or ordinary documentation. Use when users ask what skills a repo needs, want agent onboarding improved, or want context debt assessed. Read-only; propose exact skill boundaries without creating them.
---

# Find skill opportunities

Treat context like product surface area: every always-loaded word has a cost.

1. Map repository intent first.
2. Look for repeated decisions with repository-specific answers:
   - fragile release or migration sequences;
   - domain invariants not encoded by types;
   - security or compliance review paths;
   - conventions spread across multiple sources;
   - failures that require non-obvious diagnosis.
3. Reject candidates that are generic, one-off, fully enforced by tooling, or cheaper to discover than to load.
4. Score survivors with [references/opportunity-rubric.md](references/opportunity-rubric.md).
5. Return at most five candidates, ordered by avoided risk.

For each candidate give: name, trigger description, evidence sources, workflow, resources, maintenance signal, and why it deserves context.
