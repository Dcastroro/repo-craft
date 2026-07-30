#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? ".");
const json = process.argv.includes("--json");
const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "vendor"]);
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(relative(root, path));
  }
}

if (!existsSync(root)) throw new Error(`Repository does not exist: ${root}`);
walk(root);

const instructionNames = new Set(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md"]);
const instructions = files.filter((path) => instructionNames.has(path) || path.startsWith(".claude/rules/"));
const manifests = files.filter((path) => /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(path));
const tests = files.filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\//.test(path));
const skills = files.filter((path) => /(?:^|\/)(?:skills)\/[^/]+\/SKILL\.md$/.test(path));
const rootText = instructions
  .filter((path) => !path.includes("/"))
  .map((path) => readFileSync(join(root, path), "utf8"))
  .join("\n");
const commandsMentioned = [...rootText.matchAll(/(?:npm run|pnpm|yarn|cargo|go test|pytest)\s+[\w:.-]+/g)].map((match) => match[0]);
const signals = [
  instructions.length === 0 && { severity: "high", code: "no-instructions", message: "No agent or contributor instructions discovered." },
  manifests.length > 0 && commandsMentioned.length === 0 && { severity: "medium", code: "no-commands", message: "Manifests exist but root instructions name no validation commands." },
  tests.length > 10 && !rootText.toLowerCase().includes("test") && { severity: "medium", code: "hidden-tests", message: "Tests exist but root instructions do not describe the test workflow." },
  skills.length > 8 && { severity: "low", code: "skill-sprawl", message: "More than eight skills increase trigger overlap and context cost." },
].filter(Boolean);

const result = {
  repository: root,
  counts: { files: files.length, instructions: instructions.length, manifests: manifests.length, tests: tests.length, skills: skills.length },
  instructions,
  commandsMentioned: [...new Set(commandsMentioned)].sort(),
  signals,
};

process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : [
  `Context debt: ${root}`,
  `Files ${files.length} · Instructions ${instructions.length} · Tests ${tests.length} · Skills ${skills.length}`,
  ...signals.map((signal) => `[${signal.severity}] ${signal.message}`),
].join("\n") + "\n");
