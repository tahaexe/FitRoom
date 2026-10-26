/**
 * Demo recommend requests: the four recorded requests for the demo room
 * (the sample room with `shared/samples/fit-tests/valid.json`) — sofas,
 * coffee tables, shelves, and "What fits here?" on the longest free run of
 * the north wall (`wall-3`).
 *
 * Built with the shared code (free-space analysis + candidate filter), with
 * every candidate spot verified by the fit engine: adding the probe must
 * introduce no new error, so every recorded answer fits by construction.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FitEngine,
  analyzeFreeSpace,
  buildRecommendRequest,
  type CatalogItem,
  type FitIssue,
  type RecommendRequest,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";

function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function issueKey(issue: FitIssue): string {
  return `${issue.type}|${[...issue.itemIds].sort().join(",")}`;
}

/**
 * The four demo requests, rebuilt deterministically. `demo-requests.ts`
 * embeds their output; `check:recommend` rebuilds and compares.
 */
export function buildRecommendDemoRequests(): RecommendRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "living-420x360.json")) as RoomLayout;
  const scene = readJson(resolve(sharedDir, "samples", "fit-tests", "valid.json")) as SceneState;
  const catalog = readJson(resolve(sharedDir, "catalog", "catalog.json")) as CatalogItem[];
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category }]),
  );
  const engine = new FitEngine(room, products);
  const base = new Set<string>();
  for (const issue of engine.check(scene)) {
    if (issue.severity === "error") base.add(issueKey(issue));
  }
  const verify = (
    productId: string,
    position: { x: number; z: number },
    rotationY: number,
  ): boolean => {
    const probe = {
      ...scene,
      items: [
        ...scene.items,
        {
          instanceId: "recommend-probe",
          productId,
          position: {
            x: Math.round(position.x * 10) / 10,
            z: Math.round(position.z * 10) / 10,
          },
          rotationY,
          variant: "",
        },
      ],
    };
    for (const issue of engine.check(probe)) {
      if (issue.severity !== "error") continue;
      if (!base.has(issueKey(issue))) return false;
    }
    return true;
  };

  const free = analyzeFreeSpace(room, scene, catalogById);
  const north = free.runs
    .filter((run) => run.wall === "wall-3")
    .sort((a, b) => b.length_cm - a.length_cm)[0];
  if (north === undefined) {
    throw new Error("demo room has no free run on the north wall (wall-3).");
  }
  const queries = [
    { category: "sofa" as const },
    { category: "coffee-table" as const },
    { category: "shelf" as const },
    {
      category: "any" as const,
      spot: { wall: north.wall, start_cm: north.start_cm, end_cm: north.end_cm },
    },
  ];
  return queries.map((query) => buildRecommendRequest(room, scene, catalog, query, verify));
}
