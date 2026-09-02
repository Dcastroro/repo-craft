#!/usr/bin/env node

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "vendor"]);
const defaults = {
  maxDepth: 64,
  maxFiles: 100_000,
  maxInstructionBytes: 1_048_576,
};
const maximums = {
  maxDepth: 256,
  maxFiles: 1_000_000,
  maxInstructionBytes: 16_777_216,
};

function parsePositiveInteger(value, flag, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  if (parsed > maximum) throw new Error(`${flag} cannot exceed ${maximum}.`);
  return parsed;
}

function parseArguments(args) {
  const options = { ...defaults, json: false, root: "." };
  let rootWasSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }

    const limits = {
      "--max-depth": ["maxDepth", maximums.maxDepth],
      "--max-files": ["maxFiles", maximums.maxFiles],
      "--max-instruction-bytes": ["maxInstructionBytes", maximums.maxInstructionBytes],
    };
    if (argument in limits) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      const [name, maximum] = limits[argument];
      options[name] = parsePositiveInteger(value, argument, maximum);
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (rootWasSet) throw new Error("Provide only one repository path.");
    options.root = argument;
    rootWasSet = true;
  }

  return options;
}

function readBoundedInstruction(path, byteLimit) {
  let descriptor;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    if (!fstatSync(descriptor).isFile()) return null;
    const buffer = Buffer.alloc(byteLimit + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > byteLimit) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function analyzeRepository(options) {
  const root = resolve(options.root);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Repository does not exist.");
    }
    throw new Error("Unable to inspect repository path.");
  }
  if (!rootStats.isDirectory()) throw new Error("Repository path is not a directory.");

  const files = [];
  function walk(directory, depth) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new Error("Unable to read a repository directory.");
    }

    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= options.maxDepth) throw new Error(`Directory depth exceeds the ${options.maxDepth} limit.`);
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= options.maxFiles) throw new Error(`File count exceeds the ${options.maxFiles} limit.`);
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  walk(root, 0);

  const instructionNames = new Set(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md"]);
  const instructions = files.filter((path) => instructionNames.has(path) || path.startsWith(".claude/rules/"));
  const manifests = files.filter((path) => /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(path));
  const tests = files.filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\//.test(path));
  const skills = files.filter((path) => /(?:^|\/)(?:skills)\/[^/]+\/SKILL\.md$/.test(path));
  const oversizedInstructions = [];
  const rootText = instructions
    .filter((path) => !path.includes("/"))
    .map((path) => {
      const instructionPath = join(root, path);
      const text = readBoundedInstruction(instructionPath, options.maxInstructionBytes);
      if (text === null) {
        oversizedInstructions.push(path);
        return "";
      }
      return text;
    })
    .join("\n");
  const commandsMentioned = [...rootText.matchAll(/(?:npm run|pnpm|yarn|cargo|go test|pytest)\s+[\w:.-]+/g)]
    .map((match) => match[0]);
  const signals = [
    instructions.length === 0 && { severity: "high", code: "no-instructions", message: "No agent or contributor instructions discovered." },
    manifests.length > 0 && commandsMentioned.length === 0 && { severity: "medium", code: "no-commands", message: "Manifests exist but root instructions name no validation commands." },
    tests.length > 10 && !rootText.toLowerCase().includes("test") && { severity: "medium", code: "hidden-tests", message: "Tests exist but root instructions do not describe the test workflow." },
    skills.length > 8 && { severity: "low", code: "skill-sprawl", message: "More than eight skills increase trigger overlap and context cost." },
    oversizedInstructions.length > 0 && { severity: "medium", code: "oversized-instructions", message: "One or more root instruction files could not be read within safe limits." },
  ].filter(Boolean);

  return {
    repository: basename(root),
    counts: { files: files.length, instructions: instructions.length, manifests: manifests.length, tests: tests.length, skills: skills.length },
    instructions,
    skippedInstructions: oversizedInstructions,
    commandsMentioned: [...new Set(commandsMentioned)].sort(),
    signals,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = analyzeRepository(options);
  const text = [
    `Context debt: ${result.repository}`,
    `Files ${result.counts.files} · Instructions ${result.counts.instructions} · Tests ${result.counts.tests} · Skills ${result.counts.skills}`,
    ...result.signals.map((signal) => `[${signal.severity}] ${signal.message}`),
  ].join("\n");
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure.";
  process.stderr.write(`context-debt: ${message}\n`);
  process.exitCode = 1;
}
