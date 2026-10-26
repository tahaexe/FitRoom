/**
 * `npm run validate -- <file...>` — validate room samples, the catalog and
 * scene files against the shared contracts. With no arguments, validates all
 * samples plus the catalog. Every failure is printed with its JSON path.
 *
 * Runs from compiled output: `node ./dist/validate-cli.js [files...]`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFit, type FitProducts } from "./fit.js";
import type { CatalogItem, RoomLayout, SceneState } from "./types.js";
import {
  validateCatalog,
  validateRoomLayout,
  validateSceneState,
  type ValidationError,
} from "./validate.js";

function sharedRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultFiles(): string[] {
  const root = sharedRoot();
  const files: string[] = [];
  const samplesDir = join(root, "samples");
  if (existsSync(samplesDir)) {
    for (const entry of readdirSync(samplesDir).sort()) {
      if (entry.endsWith(".json")) {
        files.push(join(samplesDir, entry));
      }
    }
  }
  const fitTestsDir = join(samplesDir, "fit-tests");
  if (existsSync(fitTestsDir)) {
    for (const entry of readdirSync(fitTestsDir).sort()) {
      if (entry.endsWith(".json") && entry !== "expected.json") {
        files.push(join(fitTestsDir, entry));
      }
    }
  }
  const catalog = join(root, "catalog", "catalog.json");
  if (existsSync(catalog)) {
    files.push(catalog);
  }
  return files;
}

function isRecordWith(data: unknown, key: string): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  return key in data;
}

function validateDocument(data: unknown): ValidationError[] {
  if (Array.isArray(data)) {
    return validateCatalog(data).errors;
  }
  if (isRecordWith(data, "walls")) {
    return validateRoomLayout(data).errors;
  }
  if (isRecordWith(data, "roomId")) {
    return validateSceneState(data).errors;
  }
  return [
    {
      path: "$",
      message:
        "unrecognised document: expected a RoomLayout (object with walls), " +
        "a SceneState (object with roomId) or a catalog (array of items)",
    },
  ];
}

function validateFile(file: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    console.error(`${file}: FAIL (1 error)`);
    console.error(`  $: cannot read file`);
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    console.error(`${file}: FAIL (1 error)`);
    console.error(`  $: invalid JSON`);
    return false;
  }
  const errors = validateDocument(data);
  if (errors.length === 0) {
    console.log(`${file}: OK`);
    return true;
  }
  console.error(`${file}: FAIL (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  for (const error of errors) {
    console.error(`  ${error.path}: ${error.message}`);
  }
  return false;
}

interface ExpectedIssue {
  type: string;
  itemIds: string[];
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf-8")) as unknown;
}

/**
 * Fit-test scenes: run the real engine on every `fit-tests/*.json` scene
 * and compare (type + sorted itemIds) against `expected.json`.
 */
function checkFitExpectations(): boolean {
  const root = sharedRoot();
  const testsDir = join(root, "samples", "fit-tests");
  const expectedFile = join(testsDir, "expected.json");
  if (!existsSync(expectedFile)) return true;
  let room: RoomLayout;
  let catalog: CatalogItem[];
  let expected: Record<string, ExpectedIssue[]>;
  try {
    room = readJson(join(root, "samples", "living-420x360.json")) as RoomLayout;
    catalog = readJson(join(root, "catalog", "catalog.json")) as CatalogItem[];
    expected = readJson(expectedFile) as Record<string, ExpectedIssue[]>;
  } catch {
    console.error("fit-tests: FAIL (cannot read room, catalog or expected.json)");
    return false;
  }
  const products: FitProducts = new Map(
    catalog.map((c) => [c.id, { size: c.size, category: c.category }]),
  );
  let failed = false;
  for (const name of Object.keys(expected).sort()) {
    const sceneFile = join(testsDir, `${name}.json`);
    if (!existsSync(sceneFile)) {
      console.error(`fit-tests/${name}: FAIL (scene file missing)`);
      failed = true;
      continue;
    }
    const scene = readJson(sceneFile) as SceneState;
    const actual = checkFit(room, scene, products)
      .map((issue) => ({ type: issue.type, itemIds: [...issue.itemIds].sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const want = (expected[name] ?? [])
      .map((issue) => ({ type: issue.type, itemIds: [...issue.itemIds].sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (JSON.stringify(actual) === JSON.stringify(want)) {
      console.log(
        `fit-tests/${name}: OK (${actual.length} issue${actual.length === 1 ? "" : "s"})`,
      );
    } else {
      failed = true;
      console.error(`fit-tests/${name}: FAIL`);
      console.error(`  expected: ${JSON.stringify(want)}`);
      console.error(`  actual:   ${JSON.stringify(actual)}`);
    }
  }
  return !failed;
}

const inputs = process.argv.slice(2).map((arg) => resolve(arg));
const files = inputs.length > 0 ? inputs : defaultFiles();
if (files.length === 0) {
  console.error("validate: no files to check");
  process.exitCode = 1;
} else {
  let failed = false;
  for (const file of files) {
    if (!validateFile(file)) {
      failed = true;
    }
  }
  if (inputs.length === 0) {
    // Full run: the fit-test scenes must also produce their fit contract.
    const testsDir = join(sharedRoot(), "samples", "fit-tests");
    const sceneFiles = files.filter(
      (f) => f.startsWith(testsDir) && basename(f) !== "expected.json",
    );
    const scenesOk = sceneFiles.length > 0 && checkFitExpectations();
    if (!scenesOk) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
