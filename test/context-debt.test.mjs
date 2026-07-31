import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/context-debt.mjs", import.meta.url);

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

    const output = execFileSync(process.execPath, [script.pathname, root, "--json"], { encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.counts.tests, 1);
    assert.equal(result.counts.instructions, 1);
    assert.equal(result.signals[0].code, "no-commands");
    assert.equal(result.repository, basename(root));
    assert.equal(output.includes(root), false);
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

    const output = execFileSync(process.execPath, [script.pathname, root, "--json"], { encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.counts.instructions, 0);
    assert.deepEqual(result.commandsMentioned, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("stops when a repository exceeds configured bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "one.txt"), "");
    await writeFile(join(root, "two.txt"), "");

    const result = spawnSync(process.execPath, [script.pathname, root, "--max-files", "1"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /File count exceeds the 1 limit/);
    assert.equal(result.stderr.includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not read oversized instruction files", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "npm run should-not-be-read");

    const output = execFileSync(
      process.execPath,
      [script.pathname, root, "--max-instruction-bytes", "8", "--json"],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.skippedInstructions, ["AGENTS.md"]);
    assert.deepEqual(result.commandsMentioned, []);
    assert.equal(result.signals.at(-1).code, "oversized-instructions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
