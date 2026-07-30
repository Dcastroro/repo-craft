import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
