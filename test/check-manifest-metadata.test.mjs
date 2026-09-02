import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The script under test defaults to its own repository root, but accepts an
// optional root argument precisely so it can be pointed at disposable
// fixture directories here — the real script file is what runs (a genuine
// subprocess CLI invocation, not an imported/mocked function), it just reads
// a different root, which also keeps coverage instrumentation attributed to
// the real file instead of a copy.
const realScriptPath = fileURLToPath(new URL("../scripts/check-manifest-metadata.mjs", import.meta.url));

const baseFields = {
  name: "repo-craft",
  version: "0.2.0",
  description: "Turn repository evidence into concise, high-signal agent skills.",
};

// package.json's `name` is documented as intentionally different from the
// plugin id used by every plugin manifest.
const basePackageJson = { name: "repo-craft-plugin", version: baseFields.version, description: baseFields.description };
const basePluginManifest = { ...baseFields };

async function makeFixture({ packageJson = basePackageJson, claudePlugin = basePluginManifest, codexPlugin = basePluginManifest, rootPlugin = basePluginManifest } = {}) {
  const root = await mkdtemp(join(tmpdir(), "repo-craft-manifest-"));
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2));
  await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(claudePlugin, null, 2));
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(codexPlugin, null, 2));
  await writeFile(join(root, "plugin.json"), JSON.stringify(rootPlugin, null, 2));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [realScriptPath, root], { encoding: "utf8" });
}

test("passes when package.json and all three plugin manifests are in sync", async () => {
  const root = await makeFixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Plugin metadata matches across package\.json and all plugin manifests\./);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a plugin manifest's version drifts from package.json", async () => {
  const root = await makeFixture({
    codexPlugin: { ...basePluginManifest, version: "0.3.0" },
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Plugin metadata is out of sync:/);
    assert.match(result.stderr, /version mismatch: package\.json has "0\.2\.0", \.codex-plugin\/plugin\.json has "0\.3\.0"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a plugin manifest's description drifts from package.json", async () => {
  const root = await makeFixture({
    rootPlugin: { ...basePluginManifest, description: "Something else entirely." },
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Plugin metadata is out of sync:/);
    assert.match(
      result.stderr,
      /description mismatch: package\.json has "Turn repository evidence into concise, high-signal agent skills\.", plugin\.json has "Something else entirely\."/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when the plugin id (name) diverges across the three plugin manifests", async () => {
  const root = await makeFixture({
    claudePlugin: { ...basePluginManifest, name: "repo-craft" },
    codexPlugin: { ...basePluginManifest, name: "repo-craft-codex" },
    rootPlugin: { ...basePluginManifest, name: "repo-craft" },
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Plugin metadata is out of sync:/);
    assert.match(
      result.stderr,
      /name mismatch: \.claude-plugin\/plugin\.json has "repo-craft", \.codex-plugin\/plugin\.json has "repo-craft-codex"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not fail when package.json's name differs from the plugin manifests' name", async () => {
  // Documented, intentional divergence: package.json is the npm package id
  // ("repo-craft-plugin"), while the plugin manifests share the plugin id
  // ("repo-craft"). Only version/description are cross-checked against
  // package.json; `name` is only cross-checked among the plugin manifests.
  const root = await makeFixture({
    packageJson: { name: "some-totally-different-npm-name", version: baseFields.version, description: baseFields.description },
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Plugin metadata matches across package\.json and all plugin manifests\./);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with no root argument, defaults to this repository's own manifests and passes", () => {
  // Exercises the default (no-argument) branch of the root resolution, and
  // doubles as a real regression check that this repository's own
  // package.json and plugin manifests are actually in sync.
  const result = spawnSync(process.execPath, [realScriptPath], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Plugin metadata matches across package\.json and all plugin manifests\./);
});

test("reports multiple mismatches at once rather than stopping at the first", async () => {
  const root = await makeFixture({
    packageJson: { ...basePackageJson, version: "9.9.9" },
    codexPlugin: { ...basePluginManifest, description: "Different description." },
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version mismatch/);
    assert.match(result.stderr, /description mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
