/**
 * `npm run demo:import` — copy `server/data/recorded/` into the committed
 * demo store `server/data/demo/` and list what was copied.
 */

/* global console, process */
import { isDemoStoreFile } from "@fitroom/shared";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGatewayConfig } from "../src/config.js";

const ROUTES = ["recommend", "assistant", "render", "label"];

function main(): void {
  const config = loadGatewayConfig();
  const recordedDir = join(config.dataDir, "recorded");
  const demoDir = join(config.dataDir, "demo");
  if (!existsSync(recordedDir)) {
    console.log("demo:import: nothing to import (no server/data/recorded/).");
    return;
  }
  const copied: string[] = [];
  for (const route of ROUTES) {
    const from = join(recordedDir, route);
    if (!existsSync(from)) continue;
    const names = readdirSync(from)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const raw: unknown = JSON.parse(readFileSync(join(from, name), "utf8"));
      if (!isDemoStoreFile(raw)) {
        console.log(`demo:import: skipping ${route}/${name} (not a demo store file).`);
        continue;
      }
      mkdirSync(join(demoDir, route), { recursive: true });
      const source = join(from, name);
      const dest = join(demoDir, route, name);
      // Only touch the demo file when its content changes: on a Windows
      // checkout an identical rewrite still shows as modified, so compare
      // with line endings normalized and skip the copy when they match.
      const next = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
      const current = existsSync(dest) ? readFileSync(dest, "utf8").replace(/\r\n/g, "\n") : null;
      if (current === next) continue;
      copyFileSync(source, dest);
      copied.push(`${route}/${name}`);
    }
  }
  if (copied.length === 0) {
    console.log("demo:import: nothing to import.");
    return;
  }
  console.log(`demo:import: copied ${String(copied.length)} file(s):`);
  for (const file of copied) console.log(`  ${file}`);
}

try {
  main();
} catch (error) {
  console.error(`demo:import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
