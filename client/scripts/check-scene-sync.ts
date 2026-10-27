/**
 * `npm run check:scene-sync` — headless scene-sync check (no browser, no
 * WebGL, no Meta calls).
 *
 * Drives the real `SceneStore` plus the real `SceneSynchronizer` (the one
 * sync path the canvas uses) with plain three.js `Group` objects through
 * add → delete → undo → delete → undo → redo → swap → Inspector move →
 * delete-all, plus a concurrent delete/undo race. After every step it
 * asserts the scene invariant: every piece in the store state has exactly
 * one model, at its state position and rotation, and no model exists
 * without a piece.
 */

/* global console, process */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { SceneStore, emptyScene } from "../src/state.js";
import { SceneSynchronizer } from "../src/scene-sync.js";
import type { SceneItem } from "@fitroom/shared";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "..", "..", ".tmp", "scene-sync");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function item(id: string, x: number, z: number, rotationY = 0, variant = ""): SceneItem {
  return { instanceId: id, productId: "sofa-01", position: { x, z }, rotationY, variant };
}

async function main(): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });

  const modelsRoot = new THREE.Group();
  const syncer = new SceneSynchronizer<THREE.Group>({
    load: (entry) => {
      const group = new THREE.Group();
      group.name = entry.instanceId;
      group.position.set(entry.position.x / 100, 0, entry.position.z / 100);
      group.rotation.y = (entry.rotationY * Math.PI) / 180;
      return Promise.resolve(group);
    },
    place: (group, entry) => {
      group.position.set(entry.position.x / 100, 0, entry.position.z / 100);
      group.rotation.y = (entry.rotationY * Math.PI) / 180;
    },
    attach: (group) => {
      modelsRoot.add(group);
    },
    detach: (group) => {
      modelsRoot.remove(group);
    },
  });

  const store = new SceneStore("check-room", emptyScene("check-room"));
  store.replace(emptyScene("check-room"));

  const syncAndAssert = async (step: string): Promise<void> => {
    await syncer.sync(store.state.items);
    const ids = store.state.items.map((i) => i.instanceId);
    const unique = new Set(ids);
    check(`${step}: no duplicate piece ids in state`, unique.size === ids.length);
    check(
      `${step}: exactly one model per piece`,
      syncer.instances.size === ids.length,
      `instances=${String(syncer.instances.size)} pieces=${String(ids.length)}`,
    );
    check(
      `${step}: no model without a piece`,
      [...syncer.instances.keys()].every((id) => unique.has(id)),
    );
    check(
      `${step}: scene graph matches the map`,
      modelsRoot.children.length === syncer.instances.size,
      `children=${String(modelsRoot.children.length)}`,
    );
    let placed = true;
    for (const piece of store.state.items) {
      const entry = syncer.instances.get(piece.instanceId);
      if (entry === undefined) {
        placed = false;
        break;
      }
      const dx = Math.abs(entry.group.position.x - piece.position.x / 100);
      const dz = Math.abs(entry.group.position.z - piece.position.z / 100);
      const want = (piece.rotationY * Math.PI) / 180;
      const dr = Math.abs(entry.group.rotation.y - want);
      if (dx > 1e-9 || dz > 1e-9 || dr > 1e-9) {
        placed = false;
        break;
      }
    }
    check(`${step}: every model sits at its state position`, placed);
  };

  const commitItems = (items: SceneItem[]): void => {
    store.commit((draft) => {
      draft.items = items;
    });
  };

  // add → delete → undo → delete → undo → redo → swap → Inspector move → delete all
  commitItems([item("a", 100, 100), item("b", 200, 200), item("c", 300, 100)]);
  await syncAndAssert("add three pieces");

  commitItems(store.state.items.filter((i) => i.instanceId !== "a"));
  await syncAndAssert("delete the sofa");

  store.undo();
  await syncAndAssert("undo the delete");
  check("undo restores three pieces", store.state.items.length === 3);

  commitItems(store.state.items.filter((i) => i.instanceId !== "a"));
  await syncAndAssert("delete the sofa again");

  store.undo();
  await syncAndAssert("undo the second delete");

  check("redo is available after undo", store.canRedo());
  store.redo();
  await syncAndAssert("redo the delete");
  check("redo removes the sofa again", !store.state.items.some((i) => i.instanceId === "a"));
  store.undo();
  await syncAndAssert("undo the redo");

  // Swap: replace b with a new piece id, as one undo step.
  commitItems([...store.state.items.filter((i) => i.instanceId !== "b"), item("d", 210, 210, 90)]);
  await syncAndAssert("swap b for d");

  // Inspector move: edit position + rotation in place.
  store.commit((draft) => {
    const it = draft.items.find((i) => i.instanceId === "d");
    if (it !== undefined) {
      it.position = { x: 250, z: 120 };
      it.rotationY = 45;
    }
  });
  await syncAndAssert("inspector move");

  // Concurrent delete/undo race: two syncs overlap; the scene must still
  // converge to exactly the final state (this is the ghost-repro shape).
  const before = store.state.items.map((i) => ({ ...i, position: { ...i.position } }));
  const withDelete = before.filter((i) => i.instanceId !== "d");
  const first = syncer.sync(withDelete);
  const second = syncer.sync(before);
  await Promise.all([first, second]);
  commitItems(before);
  await syncAndAssert("overlapping syncs converge");

  // Delete everything: no model may be left behind.
  commitItems([]);
  await syncAndAssert("delete all");
  check("empty scene draws nothing", modelsRoot.children.length === 0);
  check("undo available after delete-all", store.canUndo());
  check("redo cleared by a fresh commit", !store.canRedo());

  console.log(
    failures === 0
      ? "check:scene-sync: all checks passed"
      : `check:scene-sync: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
