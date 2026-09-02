import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readInstructionFile } from "../scripts/context-debt.mjs";

// `fileURLToPath` (not `url.pathname`) is required for cross-platform
// correctness: on Windows, a file URL's `.pathname` keeps a leading slash
// and forward slashes (e.g. "/C:/repo/script.mjs"), which is not a path
// `child_process` can spawn directly.
const scriptPath = fileURLToPath(new URL("../scripts/context-debt.mjs", import.meta.url));

function run(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", ...options });
}

function runJson(root, extraArgs = []) {
  const output = execFileSync(process.execPath, [scriptPath, root, "--json", ...extraArgs], { encoding: "utf8" });
  return JSON.parse(output);
}

test("finds missing validation commands without reading dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/fake"), { recursive: true });
    await mkdir(join(root, ".claude/skills/external"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "AGENTS.md"), "# Rules\nKeep modules small.");
    await writeFile(join(root, "src/index.test.js"), "export {};");
    await writeFile(join(root, "node_modules/fake/secret.test.js"), "export {};");
    await writeFile(join(root, ".claude/skills/external/AGENTS.md"), "# External skill");

    const result = runJson(root);
    assert.equal(result.counts.tests, 1);
    assert.equal(result.counts.instructions, 1);
    assert.equal(result.signals[0].code, "no-commands");
    assert.equal(result.repository, basename(root));
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips symlinks instead of reading content outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  const external = await mkdtemp(join(tmpdir(), "repo-craft-external-"));
  try {
    await writeFile(join(external, "CLAUDE.md"), "npm run exfiltrate");
    await symlink(join(external, "CLAUDE.md"), join(root, "CLAUDE.md"));

    const result = runJson(root);
    assert.equal(result.counts.instructions, 0);
    assert.deepEqual(result.commandsMentioned, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("resolves a symlinked repository root instead of rejecting it as not a directory", async () => {
  const target = await mkdtemp(join(tmpdir(), "repo-craft-target-"));
  const parent = await mkdtemp(join(tmpdir(), "repo-craft-"));
  const linkPath = join(parent, "linked-root");
  try {
    await writeFile(join(target, "AGENTS.md"), "# Rules");
    // Common on macOS, where /tmp itself is a symlink, and whenever a repository is checked out
    // through a symlinked path. Statting the root (unlike statting entries found while walking,
    // which must stay lstat-based to not escape the repository) is meant to follow this.
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    const result = runJson(linkPath);
    assert.equal(result.counts.instructions, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("does not count files under .venv, __pycache__, target, .turbo, or .cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, ".venv/lib/site-packages/pkg/tests"), { recursive: true });
    await writeFile(join(root, ".venv/lib/site-packages/pkg/tests/test_x.py"), "def test_x(): pass");
    await writeFile(join(root, "AGENTS.md"), "# Rules");

    const result = runJson(root);
    assert.equal(result.counts.tests, 0);
    assert.equal(result.counts.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates instead of aborting when the file limit is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "one.txt"), "");
    await writeFile(join(root, "two.txt"), "");

    const result = runJson(root, ["--max-files", "1"]);
    assert.equal(result.truncated, true);
    assert.match(result.truncatedReason, /File count exceeds the 1 limit/);
    assert.equal(result.counts.files, 1);
    assert.equal(result.signals.some((signal) => signal.code === "truncated-scan"), true);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates instead of aborting when the depth limit is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "a/b/c"), { recursive: true });
    await writeFile(join(root, "a/b/c/deep.txt"), "");

    const result = runJson(root, ["--max-depth", "1"]);
    assert.equal(result.truncated, true);
    assert.match(result.truncatedReason, /Directory depth exceeds the 1 limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizes repository inspection errors", () => {
  const missing = join(tmpdir(), "repo-craft-private-path", "missing");
  const result = run([missing]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Repository does not exist/);
  assert.equal(result.stderr.includes(missing), false);
});

test("distinguishes oversized instruction files from unreadable ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "npm run should-not-be-read");

    const result = runJson(root, ["--max-instruction-bytes", "8"]);
    assert.deepEqual(result.skippedInstructions, ["AGENTS.md"]);
    assert.deepEqual(result.commandsMentioned, []);
    const oversizedSignal = result.signals.find((signal) => signal.code === "oversized-instructions");
    assert.ok(oversizedSignal, "expected an oversized-instructions signal");
    const detail = result.instructionSizes.find((entry) => entry.path === "AGENTS.md");
    assert.equal(detail.status, "oversized");
    assert.ok(detail.bytes > 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports unreadable instruction files distinctly from oversized ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Rules");
    await chmod(join(root, "AGENTS.md"), 0o000);

    if (process.getuid && process.getuid() === 0) {
      // Running as root bypasses permission bits; nothing meaningful to assert.
      return;
    }

    const result = runJson(root);
    assert.deepEqual(result.unreadableInstructions, ["AGENTS.md"]);
    const detail = result.instructionSizes.find((entry) => entry.path === "AGENTS.md");
    assert.equal(detail.status, "unreadable");
    assert.ok(detail.reason);
    assert.equal(result.signals.some((signal) => signal.code === "unreadable-instructions"), true);
  } finally {
    await chmod(join(root, "AGENTS.md"), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("continues the scan past an unreadable directory instead of aborting", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", "secret.txt"), "");
    await writeFile(join(root, "AGENTS.md"), "# Rules");
    await chmod(join(root, "locked"), 0o000);

    if (process.getuid && process.getuid() === 0) {
      return;
    }

    const result = runJson(root);
    assert.equal(result.counts.instructions, 1);
    assert.ok(result.warnings.length >= 1);
    assert.equal(result.signals.some((signal) => signal.code === "unreadable-directories"), true);
  } finally {
    await chmod(join(root, "locked"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes GEMINI.md, .cursorrules, and copilot instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, ".github"), { recursive: true });
    await writeFile(join(root, "GEMINI.md"), "# Gemini rules");
    await writeFile(join(root, ".cursorrules"), "# Cursor rules");
    await writeFile(join(root, ".github/copilot-instructions.md"), "# Copilot rules");

    const result = runJson(root);
    assert.equal(result.counts.instructions, 3);
    assert.deepEqual(
      [...result.instructions].sort(),
      [".cursorrules", ".github/copilot-instructions.md", "GEMINI.md"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes first- and second-level nested AGENTS.md/CLAUDE.md for monorepos", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "packages/app"), { recursive: true });
    await mkdir(join(root, "apps"), { recursive: true });
    await writeFile(join(root, "packages/app/AGENTS.md"), "npm test");
    await writeFile(join(root, "apps/CLAUDE.md"), "npm run build");

    const result = runJson(root);
    assert.equal(result.counts.instructions, 2);
    assert.deepEqual(
      [...result.instructions].sort(),
      ["apps/CLAUDE.md", "packages/app/AGENTS.md"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not treat dot-directories as monorepo packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, ".claude/skills/external"), { recursive: true });
    await writeFile(join(root, ".claude/skills/external/AGENTS.md"), "# External skill");

    const result = runJson(root);
    assert.equal(result.counts.instructions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts .claude/rules files as instructions and reads their content", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, ".claude/rules"), { recursive: true });
    await writeFile(join(root, ".claude/rules/testing.md"), "npm test");

    const result = runJson(root);
    assert.equal(result.counts.instructions, 1);
    assert.deepEqual(result.commandsMentioned, ["npm test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects npm test, npm ci, make, npx, node --test, and bun commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(
      join(root, "AGENTS.md"),
      ["npm test", "npm ci", "make build", "npx tsc", "node --test", "bun test"].join("\n"),
    );

    const result = runJson(root);
    for (const command of ["npm test", "npm ci", "make build", "npx tsc", "node --test", "bun test"]) {
      assert.ok(result.commandsMentioned.includes(command), `expected commandsMentioned to include "${command}"`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes Makefile, Gemfile, pom.xml, requirements.txt, and composer.json as manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "Makefile"), "test:\n\techo hi\n");
    await writeFile(join(root, "Gemfile"), "");
    await writeFile(join(root, "pom.xml"), "");
    await writeFile(join(root, "requirements.txt"), "");
    await writeFile(join(root, "composer.json"), "{}");

    const result = runJson(root);
    assert.equal(result.counts.manifests, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes bundle exec, rspec, mvn, gradle, composer, poetry, and python -m alongside their manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "Gemfile"), "");
    await writeFile(join(root, "pom.xml"), "");
    await writeFile(
      join(root, "AGENTS.md"),
      "# Rules\nRun `bundle exec rspec` and `mvn test` before committing. Also `gradle build`, " +
        "`composer install`, `poetry run pytest`, and `python -m pytest` for the other services.",
    );

    const result = runJson(root);
    assert.deepEqual(
      [...result.commandsMentioned].sort(),
      [
        "bundle exec rspec",
        "composer install",
        "gradle build",
        "mvn test",
        "poetry run pytest",
        "python -m pytest",
      ].sort(),
    );
    assert.equal(result.signals.some((signal) => signal.code === "no-commands"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden-tests signal ignores 'latest' and 'contest' as false matches for 'test'", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "AGENTS.md"),
      "Use the latest dependency versions and enter the contest before shipping.",
    );
    for (let index = 0; index < 11; index += 1) {
      await writeFile(join(root, "src", `file-${index}.test.js`), "export {};");
    }

    const result = runJson(root);
    assert.equal(result.counts.tests, 11);
    assert.equal(result.signals.some((signal) => signal.code === "hidden-tests"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden-tests signal does not fire when instructions mention testing as a whole word", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "AGENTS.md"), "Run the test suite with npm test before opening a PR.");
    for (let index = 0; index < 11; index += 1) {
      await writeFile(join(root, "src", `file-${index}.test.js`), "export {};");
    }

    const result = runJson(root);
    assert.equal(result.signals.some((signal) => signal.code === "hidden-tests"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no-instructions signal fires when no instruction files exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "index.js"), "export {};");

    const result = runJson(root);
    assert.equal(result.counts.instructions, 0);
    assert.equal(result.signals[0].code, "no-instructions");
    assert.equal(result.signals[0].severity, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill-sprawl signal fires past eight skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    for (let index = 0; index < 9; index += 1) {
      await mkdir(join(root, "skills", `skill-${index}`), { recursive: true });
      await writeFile(join(root, "skills", `skill-${index}`, "SKILL.md"), "# Skill");
    }

    const result = runJson(root);
    assert.equal(result.counts.skills, 9);
    assert.equal(result.signals.some((signal) => signal.code === "skill-sprawl"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instruction-bloat signal fires when combined instruction size exceeds the budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "x".repeat(2000));

    const result = runJson(root, ["--max-total-instruction-bytes", "1000"]);
    assert.equal(result.totalInstructionBytes, 2000);
    assert.equal(result.signals.some((signal) => signal.code === "instruction-bloat"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--help prints usage and exits successfully without touching a repository", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: context-debt\.mjs/);
});

test("--version prints the package.json version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("accepts a positional repository path equal to an inherited Object.prototype property name", async () => {
  const parent = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    // `"constructor" in limits` (a plain object) is true via the prototype chain even though
    // "constructor" is never one of limits' own keys — a repository directory that happens to be
    // named exactly "constructor" (or "toString", "valueOf", "hasOwnProperty"...) must still be
    // treated as a positional path, not misrouted into the --max-* value-required branch.
    await mkdir(join(parent, "constructor"));
    await writeFile(join(parent, "constructor", "AGENTS.md"), "# Rules");

    const result = run(["constructor", "--json"], { cwd: parent });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).repository, "constructor");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("parseArguments rejects an unknown option", () => {
  const result = run(["--nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option: --nope/);
});

test("parseArguments rejects more than one repository path", () => {
  const result = run(["one", "two"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide only one repository path/);
});

test("parseArguments requires a value for options that take one", () => {
  const result = run(["--max-files"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--max-files requires a value/);
});

test("parseArguments rejects hexadecimal, scientific, and negative numbers", () => {
  for (const value of ["0x10", "1e3", "-5", "5.5", "abc"]) {
    const result = run(["--max-files", value]);
    assert.notEqual(result.status, 0, `expected failure for --max-files ${value}`);
    assert.match(result.stderr, /--max-files must be a positive integer/);
  }
});

test("parseArguments rejects a value above the configured maximum", () => {
  const result = run(["--max-depth", "99999"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--max-depth cannot exceed/);
});

test("parseArguments rejects zero, which is digits-only but not a positive integer", () => {
  // "0" passes the /^\d+$/ shape check but fails the `parsed < 1` guard, a
  // branch distinct from both the shape check and the maximum check.
  const result = run(["--max-files", "0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--max-files must be a positive integer/);
});

test("readInstructionFile reports a non-regular file (e.g. a directory) as unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    // A directory happens to share a name with an expected instruction
    // file. `readdirSync`/`walk` never lets a directory reach this
    // function in normal operation, so this exercises the defensive
    // `!stats.isFile()` branch directly via the exported helper.
    await mkdir(join(root, "AGENTS.md"));

    const result = readInstructionFile(join(root, "AGENTS.md"), 1_048_576);
    assert.equal(result.status, "unreadable");
    assert.equal(result.bytes, 0);
    assert.equal(result.text, "");
    assert.equal(result.reason, "Not a regular file.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
