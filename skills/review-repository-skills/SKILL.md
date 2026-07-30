---
name: review-repository-skills
description: Review repository skills against a high craft bar for trigger precision, progressive disclosure, evidence, safety, maintenance, and context efficiency. Use when auditing existing skills, reviewing generated skills, or deciding whether a skill should ship. Read-only by default; flag issues and withhold approval until earned.
---

# Review repository skills

Approval is earned. Start from failure modes.

1. Read the skill and every resource it requires for its default path.
2. Test whether the description triggers on the right requests and stays quiet otherwise.
3. Verify every repository claim against its source.
4. Look for duplicated documentation, generic advice, hidden dependencies, unsafe writes, stale paths, and unbounded context.
5. Apply [references/review-rubric.md](references/review-rubric.md).
6. Return findings first, ordered by impact, with exact file and remediation.
7. End with one disposition: reject, revise, or approve.

Do not approve because formatting is valid. A valid skill can still be useless.
