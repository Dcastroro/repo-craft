import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/context-debt.mjs", import.meta.url),
);
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-craft-scoped-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function scan(root, ...args) {
  const result = spawnSync(
    process.execPath,
    [script, root, "--json", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("scoped Copilot instructions contribute to command and test-workflow discovery", (t) => {
  const root = repo(t);
  write(
    root,
    ".github/instructions/backend/testing.instructions.md",
    '---\napplyTo: "src/**"\n---\nRun npm test before committing.\n',
  );
  write(root, "package.json", "{}");
  for (let i = 0; i < 11; i++) write(root, `test/case-${i}.test.js`, "");
  const r = scan(root);
  assert.deepEqual(r.instructions, [
    ".github/instructions/backend/testing.instructions.md",
  ]);
  assert.deepEqual(r.commandsMentioned, ["npm test"]);
  assert(
    !r.signals.some((s) =>
      ["no-instructions", "no-commands", "hidden-tests"].includes(s.code),
    ),
  );
});
test("unrelated Markdown files and similarly named directories are not instruction files", (t) => {
  const root = repo(t);
  write(root, ".github/instructions/README.md", "npm run unwanted-readme");
  write(
    root,
    ".github/instructions/example.instructions.txt",
    "npm run unwanted-txt",
  );
  write(
    root,
    ".github/instructions-old/testing.instructions.md",
    "npm run unwanted-old",
  );
  write(root, "docs/testing.instructions.md", "npm run unwanted-docs");
  write(root, ".github/instructions/testing.instructions.md", "npm test");
  const r = scan(root);
  assert.equal(r.counts.instructions, 1);
  assert.deepEqual(r.commandsMentioned, ["npm test"]);
});
test("scoped instructions share per-file size limits and do not expose their contents", (t) => {
  const root = repo(t);
  write(
    root,
    ".github/instructions/testing.instructions.md",
    "PRIVATE_SYNTHETIC_SENTINEL npm run private-fixture",
  );
  const r = scan(root, "--max-instruction-bytes", "10");
  assert.equal(r.counts.instructions, 1);
  assert.equal(r.instructionSizes[0].status, "oversized");
  assert(r.signals.some((s) => s.code === "oversized-instructions"));
  assert.deepEqual(r.commandsMentioned, []);
  assert(!JSON.stringify(r).includes("PRIVATE_SYNTHETIC_SENTINEL"));
  assert(!JSON.stringify(r).includes(root));
});
test("scoped instructions count toward the combined context budget", (t) => {
  const root = repo(t);
  write(root, ".github/instructions/a.instructions.md", "npm test\n");
  write(root, ".github/instructions/nested/b.instructions.md", "npm test\n");
  const r = scan(root, "--max-total-instruction-bytes", "10");
  assert.equal(r.counts.instructions, 2);
  assert.equal(r.totalInstructionBytes, 18);
  assert(r.signals.some((s) => s.code === "instruction-bloat"));
});
test("scoped instruction discovery retains directory depth truncation", (t) => {
  const root = repo(t);
  write(
    root,
    ".github/instructions/nested/testing.instructions.md",
    "npm test",
  );
  const r = scan(root, "--max-depth", "2");
  assert.equal(r.truncated, true);
  assert.equal(r.counts.instructions, 0);
  assert(r.signals.some((s) => s.code === "truncated-scan"));
});
test("scoped instruction symlinks are not followed outside the repository", (t) => {
  const root = repo(t),
    outside = repo(t);
  write(outside, "test.instructions.md", "npm run external-fixture");
  fs.mkdirSync(path.join(root, ".github/instructions"), { recursive: true });
  try {
    fs.symlinkSync(
      path.join(outside, "test.instructions.md"),
      path.join(root, ".github/instructions/test.instructions.md"),
    );
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(error.code)
    ) {
      t.skip("Creating file symlinks requires additional Windows privileges");
      return;
    }
    throw error;
  }
  const r = scan(root);
  assert.equal(r.counts.instructions, 0);
  assert.deepEqual(r.commandsMentioned, []);
});
