/**
 * `npm run validate -- <file...>` — validate room samples, the catalog and
 * scene files against the shared contracts. With no arguments, validates all
 * samples plus the catalog. Every failure is printed with its JSON path.
 *
 * Runs from compiled output: `node ./dist/validate-cli.js [files...]`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  process.exitCode = failed ? 1 : 0;
}
