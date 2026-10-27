/**
 * `npm run check:pointer-ownership` — headless pointer-ownership check (no
 * browser, no WebGL, no Meta calls).
 *
 * Drives the real `PointerOwnership` module through the canvas contract:
 * down on a piece (mouse, pen or touch), moves, up; down on empty floor
 * where the camera may move; a cancel mid-drag; two touch pointers. It
 * fails when the camera may move while a piece is held, or when it stays
 * locked after every release.
 *
 * It also guards the real wiring in `client/src/main.ts`: the canvas
 * pointerdown owns piece/handle pointers in the capture phase before
 * OrbitControls sees them, `controls.enabled` follows the ownership lock,
 * `pointercancel` / `lostpointercapture` / window `blur` end the drag, and
 * only a click (down and up within 5 px on empty space) deselects.
 */

/* global console, process */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PointerOwnership } from "../src/pointer-ownership.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "..", "..", ".tmp", "pointer-ownership");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function main(): void {
  mkdirSync(tmpDir, { recursive: true });

  // Fake camera controls: enabled follows the ownership lock.
  const controls = { enabled: true };
  const ownership = new PointerOwnership();
  const applyLock = (): void => {
    controls.enabled = !ownership.locked;
  };

  // 1. Down on a piece: the camera must lock at once.
  ownership.own(1, 100, 100);
  applyLock();
  check("down on a piece locks the camera", ownership.locked && !ownership.cameraMayMove());
  check("controls disabled while a piece is held", controls.enabled === false);

  // 2. Moves while held: still locked.
  check("camera stays locked during piece moves", !ownership.cameraMayMove());

  // 3. Up: release gives the camera back.
  ownership.release(1);
  ownership.forget(1);
  applyLock();
  check("release unlocks the camera", ownership.cameraMayMove() && controls.enabled === true);

  // 4. Down on empty floor: the camera may move.
  ownership.noteEmptyDown(2, 50, 50);
  applyLock();
  check("down on empty floor leaves the camera free", ownership.cameraMayMove());
  ownership.forget(2);

  // 5. A cancel mid-drag ends the drag and unlocks.
  ownership.own(3, 200, 200);
  applyLock();
  check("drag locks before cancel", !ownership.cameraMayMove());
  ownership.cancel(3);
  applyLock();
  check("pointercancel unlocks the camera", ownership.cameraMayMove() && controls.enabled);

  // 6. Two touch pointers: the second finger is owned too; releasing the
  // first must not free the camera while the second is still down.
  ownership.own(10, 100, 100);
  applyLock();
  ownership.own(11, 300, 300);
  applyLock();
  check("second finger keeps the camera locked", !ownership.cameraMayMove());
  ownership.release(10);
  ownership.forget(10);
  applyLock();
  check(
    "camera stays locked until every finger is up",
    !ownership.cameraMayMove() && controls.enabled === false,
  );
  ownership.release(11);
  ownership.forget(11);
  applyLock();
  check("camera returns after the last finger lifts", ownership.cameraMayMove());

  // 7. Cancelling one of two pointers keeps the other locked.
  ownership.own(20, 100, 100);
  ownership.own(21, 300, 300);
  applyLock();
  ownership.cancel(20);
  applyLock();
  check("cancel of one finger keeps the other locked", !ownership.cameraMayMove());
  ownership.cancel(21);
  applyLock();
  check("cancel of both fingers unlocks", ownership.cameraMayMove());

  // 8. Window blur clears every drag.
  ownership.own(30, 100, 100);
  ownership.own(31, 200, 200);
  ownership.clear();
  applyLock();
  check("blur clears all held pointers", ownership.cameraMayMove());

  // 9. Click detection: 5 px decides click vs orbit/pan drag.
  check("up within 5 px is a click", PointerOwnership.isClick({ x: 0, y: 0 }, 3, 4) === true);
  check("up beyond 5 px is a drag", PointerOwnership.isClick({ x: 0, y: 0 }, 6, 0) === false);

  // Static guards: the canvas wires the same rule.
  const mainTs = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
  check(
    "pointerdown owns piece pointers in the capture phase",
    mainTs.includes("pointer-ownership") && mainTs.includes("true,\n    );"),
  );
  check("piece pointerdown stops OrbitControls", mainTs.includes("stopImmediatePropagation"));
  check("controls.enabled follows the ownership lock", mainTs.includes("!this.ownership.locked"));
  check("pointercancel ends the drag", mainTs.includes('"pointercancel"'));
  check("lostpointercapture ends the drag", mainTs.includes('"lostpointercapture"'));
  check("window blur ends the drag", mainTs.includes('window.addEventListener("blur"'));
  check("only a click deselects (5 px)", mainTs.includes("PointerOwnership.isClick"));

  console.log(
    failures === 0
      ? "check:pointer-ownership: all checks passed"
      : `check:pointer-ownership: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
