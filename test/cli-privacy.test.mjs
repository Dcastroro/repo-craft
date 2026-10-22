import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../scripts/context-debt.mjs", import.meta.url),
);
const run = (args) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });

for (const [name, argument] of [
  ["ordinary unknown flag", "--nope"],
  ["attached fictional value", "--endpoint=PRIVATE_FICTIONAL_VALUE"],
  ["newline log injection", "--unknown\nPRIVATE_FORGED_LOG"],
  ["terminal control characters", "--unknown\u001b[31mPRIVATE_FICTIONAL_VALUE"],
  ["long unknown flag", `--${"x".repeat(8192)}`],
]) {
  test(`unknown-option diagnostics omit input: ${name}`, () => {
    const result = run([argument]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "context-debt: Unknown option. Use --help for supported options.\n",
    );
  });
}

test("JSON mode does not copy an unknown argument into either output stream", () => {
  const result = run(["--json", "--endpoint=PRIVATE_FICTIONAL_VALUE"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "context-debt: Unknown option. Use --help for supported options.\n",
  );
});

test("known-option errors still identify the safe flag without echoing its value", () => {
  const result = run(["--max-files", "PRIVATE_FICTIONAL_VALUE"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "context-debt: --max-files must be a positive integer.\n",
  );
});
