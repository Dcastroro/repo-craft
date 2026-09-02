#!/usr/bin/env node

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "vendor"]);
const defaults = {
  maxDepth: 64,
  maxFiles: 100_000,
  maxInstructionBytes: 1_048_576,
  // Budget for the *combined* size of every instruction file discovered.
  // A repository can stay under the per-file cap while still handing an
  // agent megabytes of context spread across many small files, so this is
  // tracked and signaled separately from `maxInstructionBytes`.
  maxTotalInstructionBytes: 262_144,
};
const maximums = {
  maxDepth: 256,
  maxFiles: 1_000_000,
  maxInstructionBytes: 16_777_216,
  maxTotalInstructionBytes: 134_217_728,
};

// --- path handling -----------------------------------------------------
//
// Every comparison in this file (Set lookups, regexes with literal "/")
// assumes POSIX-style separators. `relative()`/`join()` return
// platform-native separators (backslashes on Windows), so every relative
// path is funneled through this function before it is stored or compared.
function toPosixPath(pathValue) {
  return sep === "/" ? pathValue : pathValue.split(sep).join("/");
}

function parsePositiveInteger(value, flag, maximum) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  // Strict decimal only: reject hex ("0x10"), scientific notation ("1e3"),
  // signs, decimals, and whitespace-separated garbage that `Number()` would
  // otherwise silently accept.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  if (parsed > maximum) throw new Error(`${flag} cannot exceed ${maximum}.`);
  return parsed;
}

function readPackageVersion() {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  return packageJson.version ?? "0.0.0";
}

function printHelp() {
  const lines = [
    "Usage: context-debt.mjs [path] [options]",
    "",
    'Scan a repository for "context debt": missing, bloated, or undiscoverable',
    "instructions for coding agents.",
    "",
    "Arguments:",
    '  path                              Repository to analyze (default: ".")',
    "",
    "Options:",
    "  --json                            Emit machine-readable JSON",
    `  --max-depth <n>                   Max directory depth (default: ${defaults.maxDepth}, max: ${maximums.maxDepth})`,
    `  --max-files <n>                   Max files to scan (default: ${defaults.maxFiles}, max: ${maximums.maxFiles})`,
    `  --max-instruction-bytes <n>       Max bytes read per instruction file (default: ${defaults.maxInstructionBytes})`,
    `  --max-total-instruction-bytes <n> Max combined instruction bytes before a signal fires (default: ${defaults.maxTotalInstructionBytes})`,
    "  --help                            Show this help message",
    "  --version                         Show the tool version",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printVersion() {
  process.stdout.write(`${readPackageVersion()}\n`);
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
      "--max-total-instruction-bytes": ["maxTotalInstructionBytes", maximums.maxTotalInstructionBytes],
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

// --- instruction file classification ------------------------------------

const rootInstructionNames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "GEMINI.md",
  ".cursorrules",
]);
const specialInstructionPaths = new Set([".github/copilot-instructions.md"]);
// Monorepo package instructions, e.g. "packages/app/AGENTS.md" or
// "apps/AGENTS.md". Excluded from the dot-prefixed segment so tool
// directories (.claude, .github, .vscode, ...) are never mistaken for
// package directories.
const nestedInstructionPattern = /^(?!\.)[^/]+(?:\/[^/]+)?\/(?:AGENTS|CLAUDE)\.md$/;

function isInstructionPath(path) {
  if (specialInstructionPaths.has(path)) return true;
  if (path.startsWith(".claude/rules/")) return true;
  if (!path.includes("/")) return rootInstructionNames.has(path);
  return nestedInstructionPattern.test(path);
}

const manifestPattern =
  /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile|Gemfile|pom\.xml|requirements\.txt|composer\.json)$/;
const testPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\//;
const skillPattern = /(?:^|\/)(?:skills)\/[^/]+\/SKILL\.md$/;

// Matches "test", "tests", or "testing" as a whole word so substrings like
// "latest" or "contest" do not falsely satisfy the hidden-tests check.
const testWordPattern = /\btest(?:s|ing)?\b/i;

// Commands that always take an argument to be meaningful, vs. commands that
// are complete (or optionally take one) on their own.
// Arguments use `[ \t]` rather than `\s` so a trailing optional argument
// never swallows whitespace across a newline into the next line's command.
const commandPattern =
  /(?:npm run|pnpm|yarn|cargo|npx|make|bun)[ \t]+[\w:.-]+|npm (?:test|ci)\b|go test\b|node --test(?:[ \t]+[\w:.-]+)?|pytest(?:[ \t]+[\w:.-]+)?/g;

function readInstructionFile(absolutePath, byteLimit) {
  let descriptor;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return { status: "unreadable", bytes: 0, text: "", reason: "Not a regular file." };
    }
    if (stats.size > byteLimit) {
      return {
        status: "oversized",
        bytes: stats.size,
        text: "",
        reason: `File exceeds the ${byteLimit}-byte read limit.`,
      };
    }
    const buffer = Buffer.alloc(stats.size);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return { status: "ok", bytes: bytesRead, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { status: "unreadable", bytes: 0, text: "", reason: "Could not open the file (permissions or race)." };
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
  const warnings = [];
  let truncated = null;

  function walk(directory, depth) {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      const label = toPosixPath(relative(root, directory)) || ".";
      warnings.push(`Skipped unreadable directory: ${label}`);
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= options.maxDepth) {
          truncated = { reason: `Directory depth exceeds the ${options.maxDepth} limit.` };
          return;
        }
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= options.maxFiles) {
          truncated = { reason: `File count exceeds the ${options.maxFiles} limit.` };
          return;
        }
        files.push(toPosixPath(relative(root, path)));
      }
    }
  }
  walk(root, 0);

  const instructions = files.filter(isInstructionPath);
  const manifests = files.filter((path) => manifestPattern.test(path));
  const tests = files.filter((path) => testPattern.test(path));
  const skills = files.filter((path) => skillPattern.test(path));

  // Policy: `.claude/rules/*` files are real, agent-facing instructions, so
  // they are treated exactly like every other instruction file — counted in
  // `instructions`, read (bounded), and folded into the text used for the
  // command/test-workflow signals below. Previously they were counted but
  // silently excluded from that text, which under-reported context debt for
  // repositories that lean on `.claude/rules/`. The alternative (excluding
  // them from both the count and the text) would hide real agent context
  // from the scanner entirely, so "scan and count everything" was chosen.
  const instructionDetails = instructions.map((path) => {
    const result = readInstructionFile(join(root, path), options.maxInstructionBytes);
    return { path, ...result };
  });

  const skippedInstructions = instructionDetails.filter((detail) => detail.status === "oversized").map((d) => d.path);
  const unreadableInstructions = instructionDetails
    .filter((detail) => detail.status === "unreadable")
    .map((d) => d.path);
  const totalInstructionBytes = instructionDetails.reduce((sum, detail) => sum + detail.bytes, 0);
  const instructionText = instructionDetails
    .filter((detail) => detail.status === "ok")
    .map((detail) => detail.text)
    .join("\n");

  const commandsMentioned = [...instructionText.matchAll(commandPattern)].map((match) => match[0].trim());

  const signals = [
    instructions.length === 0 && {
      severity: "high",
      code: "no-instructions",
      message: "No agent or contributor instructions discovered.",
    },
    manifests.length > 0 &&
      commandsMentioned.length === 0 && {
        severity: "medium",
        code: "no-commands",
        message: "Manifests exist but instructions name no validation commands.",
      },
    tests.length > 10 &&
      !testWordPattern.test(instructionText) && {
        severity: "medium",
        code: "hidden-tests",
        message: "Tests exist but instructions do not describe the test workflow.",
      },
    skills.length > 8 && {
      severity: "low",
      code: "skill-sprawl",
      message: "More than eight skills increase trigger overlap and context cost.",
    },
    skippedInstructions.length > 0 && {
      severity: "medium",
      code: "oversized-instructions",
      message: "One or more instruction files exceed the safe read limit and were skipped.",
    },
    unreadableInstructions.length > 0 && {
      severity: "medium",
      code: "unreadable-instructions",
      message: "One or more instruction files could not be read (permission or type errors).",
    },
    totalInstructionBytes > options.maxTotalInstructionBytes && {
      severity: "medium",
      code: "instruction-bloat",
      message: `Combined instruction size (${totalInstructionBytes} bytes) exceeds the ${options.maxTotalInstructionBytes}-byte budget; agents may truncate or ignore context.`,
    },
    warnings.length > 0 && {
      severity: "low",
      code: "unreadable-directories",
      message: `${warnings.length} director${warnings.length === 1 ? "y" : "ies"} could not be read and were skipped.`,
    },
    truncated && {
      severity: "medium",
      code: "truncated-scan",
      message: `Scan stopped early: ${truncated.reason} Results reflect a partial scan.`,
    },
  ].filter(Boolean);

  return {
    repository: basename(root),
    counts: { files: files.length, instructions: instructions.length, manifests: manifests.length, tests: tests.length, skills: skills.length },
    instructions,
    instructionSizes: instructionDetails.map((detail) => ({
      path: detail.path,
      bytes: detail.bytes,
      status: detail.status,
      ...(detail.reason ? { reason: detail.reason } : {}),
    })),
    totalInstructionBytes,
    skippedInstructions,
    unreadableInstructions,
    commandsMentioned: [...new Set(commandsMentioned)].sort(),
    warnings,
    truncated: Boolean(truncated),
    truncatedReason: truncated ? truncated.reason : null,
    signals,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    printVersion();
    return;
  }

  const options = parseArguments(argv);
  const result = analyzeRepository(options);
  const text = [
    `Context debt: ${result.repository}`,
    `Files ${result.counts.files} · Instructions ${result.counts.instructions} · Tests ${result.counts.tests} · Skills ${result.counts.skills}`,
    `Instruction bytes: ${result.totalInstructionBytes}`,
    ...result.signals.map((signal) => `[${signal.severity}] ${signal.message}`),
  ].join("\n");
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`);
}

// Guard the CLI entry point so this module can be imported (e.g. from
// tests, to exercise internal helpers directly) without triggering a real
// scan of the importing process's working directory as a side effect.
const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure.";
    process.stderr.write(`context-debt: ${message}\n`);
    process.exitCode = 1;
  }
}

export { parsePositiveInteger, toPosixPath, isInstructionPath, readInstructionFile };
