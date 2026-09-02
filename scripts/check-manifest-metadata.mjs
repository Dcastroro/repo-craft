#!/usr/bin/env node
// Fails CI when the plugin's duplicated metadata drifts out of sync.
//
// `name`, `version`, and `description` are intentionally repeated across
// package.json and the three plugin manifests (.claude-plugin/plugin.json,
// .codex-plugin/plugin.json, and the root plugin.json for Antigravity)
// because each loader reads its own manifest file. `package.json`'s `name`
// is legitimately different ("repo-craft-plugin", the npm package id) from
// the plugin id ("repo-craft") used by every plugin manifest, so `name` is
// only cross-checked among the three plugin manifests. `version` and
// `description` are expected to match across all four files.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Accepts an optional repository root argument (defaulting to this script's
// own repository) so tests can point the real script at disposable fixture
// directories instead of duplicating it, keeping test-coverage instrumentation
// attributed to this file.
const rootDir = process.argv[2] ? resolve(process.argv[2]) : join(scriptDir, "..");

function readJson(relativePath) {
  const fullPath = join(rootDir, relativePath);
  return { path: relativePath, data: JSON.parse(readFileSync(fullPath, "utf8")) };
}

const packageJson = readJson("package.json");
const pluginManifests = [
  readJson(".claude-plugin/plugin.json"),
  readJson(".codex-plugin/plugin.json"),
  readJson("plugin.json"),
];

const errors = [];

function assertFieldMatches(field, sources) {
  const [first, ...rest] = sources;
  for (const source of rest) {
    if (source.data[field] !== first.data[field]) {
      errors.push(
        `${field} mismatch: ${first.path} has ${JSON.stringify(first.data[field])}, ` +
          `${source.path} has ${JSON.stringify(source.data[field])}.`,
      );
    }
  }
}

assertFieldMatches("name", pluginManifests);
assertFieldMatches("version", [packageJson, ...pluginManifests]);
assertFieldMatches("description", [packageJson, ...pluginManifests]);

if (errors.length > 0) {
  process.stderr.write("Plugin metadata is out of sync:\n");
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Plugin metadata matches across package.json and all plugin manifests.\n");
}
