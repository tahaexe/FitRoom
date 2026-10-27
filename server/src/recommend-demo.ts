/**
 * Demo recommend requests for the demo room (the sample room with
 * `shared/samples/fit-tests/valid.json`): coffee tables (in front of the
 * sofa), shelves, "What fits here?" on every free run the demo room lists,
 * and "Find a replacement" for the Chester Leather Sofa.
 *
 * Built with the shared code (free-space analysis + candidate filter), with
 * every candidate spot verified by the fit engine: seat accessories ignore
 * placed items of their own category and the replacement leaves the
 * selected instance out (see `shared/src/recommend/ignore.ts`), so adding
 * the probe must introduce no new error — every recorded answer fits by
 * construction. A category with no candidates (e.g. sofas in the demo room)
 * never reaches the model: the panel answers locally with sizes.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FitEngine,
  analyzeFreeSpace,
  buildRecommendRequest,
  recommendIgnoreIds,
  wallDisplayName,
  type CatalogItem,
  type CandidateQuery,
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
 * The demo requests, rebuilt deterministically. `demo-requests.ts`
 * embeds their output; `check:recommend` rebuilds and compares.
 */
export function buildRecommendDemoRequests(): RecommendRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "living-420x360.json")) as RoomLayout;
  const scene = readJson(resolve(sharedDir, "samples", "fit-tests", "valid.json")) as SceneState;
  const catalog = readJson(resolve(sharedDir, "catalog", "catalog.json")) as CatalogItem[];
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
  const engine = new FitEngine(room, products);
  const base = new Set<string>();
  for (const issue of engine.check(scene)) {
    if (issue.severity === "error") base.add(issueKey(issue));
  }
  const verifyFor = (query: CandidateQuery) => {
    const ignore = new Set(recommendIgnoreIds(scene, catalog, query));
    const items = scene.items.filter((i) => !ignore.has(i.instanceId));
    return (productId: string, position: { x: number; z: number }, rotationY: number): boolean => {
      const probe = {
        ...scene,
        items: [
          ...items,
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
  };

  const free = analyzeFreeSpace(room, scene, catalogById);
  const back = free.runs
    .filter((run) => wallDisplayName(room, run.wall).startsWith("Back wall"))
    .sort((a, b) => b.length_cm - a.length_cm)[0];
  if (back === undefined) {
    throw new Error("demo room has no free run on the back wall.");
  }
  const chester = scene.items.find((i) => i.productId === "sofa_02");
  if (chester === undefined) {
    throw new Error("demo room has no Chester Leather Sofa to replace.");
  }
  const queries: CandidateQuery[] = [
    { category: "coffee-table" },
    { category: "shelf" },
    {
      category: "any",
      spot: { wall: back.wall, start_cm: back.start_cm, end_cm: back.end_cm },
    },
  ];
  // Every other free run the demo room lists gets its own "What fits here?"
  // request (longest first), so every entry answers from the demo store.
  // Runs with no fitting candidate stay local (no model call) and are left out.
  const rest = free.runs
    .filter(
      (run) =>
        !(run.wall === back.wall && run.start_cm === back.start_cm && run.end_cm === back.end_cm),
    )
    .sort((a, b) => b.length_cm - a.length_cm);
  for (const run of rest) {
    const query: CandidateQuery = {
      category: "any",
      spot: { wall: run.wall, start_cm: run.start_cm, end_cm: run.end_cm },
    };
    const built = buildRecommendRequest(room, scene, catalog, query, verifyFor(query));
    if (built.candidates.length === 0) continue;
    queries.push(query);
  }
  queries.push({
    category: "sofa",
    replace: {
      productId: chester.productId,
      position: { ...chester.position },
      rotationY: chester.rotationY,
    },
  });
  return queries.map((query) =>
    buildRecommendRequest(room, scene, catalog, query, verifyFor(query)),
  );
}
