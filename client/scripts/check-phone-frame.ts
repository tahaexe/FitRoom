/**
 * `npm run check:phone-frame` — portrait-phone room framing (no browser,
 * no Meta calls). The room fills the free area (the scene container less
 * an open sheet), not a third of it:
 *
 * - `frameDollhouse` frames by the room's projected box (the eight corners
 *   at height 0 and the wall height), moving along the view direction until
 *   the box spans 92 % of the free width or 80 % of the free height;
 * - the picture's centre stays in the middle of the free area with
 *   `setViewOffset`, updated on sheet open/close and resize without moving
 *   the camera; cleared on desktop and in Plan.
 *
 * For a 390 x 740 area with and without a 338 px sheet, the fitted box is
 * centred in the free area within 2 px and fills it to the stated share
 * within 2 %.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHONE_FRAME_HEIGHT_SHARE,
  PHONE_FRAME_WIDTH_SHARE,
  fitBoxToArea,
  phoneFreeArea,
  phoneViewOffset,
} from "../src/guide.js";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

check(
  "phone-frame:width-share",
  PHONE_FRAME_WIDTH_SHARE === 0.92,
  `width share ${String(PHONE_FRAME_WIDTH_SHARE)}`,
);
check(
  "phone-frame:height-share",
  PHONE_FRAME_HEIGHT_SHARE === 0.8,
  `height share ${String(PHONE_FRAME_HEIGHT_SHARE)}`,
);

const freeClosed = phoneFreeArea({ w: 390, h: 740 }, 0);
check(
  "phone-frame:free-no-sheet",
  freeClosed.w === 390 && freeClosed.h === 740,
  `${String(freeClosed.w)}x${String(freeClosed.h)}`,
);

const freeOpen = phoneFreeArea({ w: 390, h: 740 }, 338);
check(
  "phone-frame:free-with-sheet",
  freeOpen.w === 390 && freeOpen.h === 402,
  `${String(freeOpen.w)}x${String(freeOpen.h)}`,
);

const offsetClosed = phoneViewOffset(390, 740, 0);
check(
  "phone-frame:offset-no-sheet",
  offsetClosed.fullW === 390 &&
    offsetClosed.fullH === 740 &&
    offsetClosed.x === 0 &&
    offsetClosed.y === 0 &&
    offsetClosed.w === 390 &&
    offsetClosed.h === 740,
  JSON.stringify(offsetClosed),
);

const offsetOpen = phoneViewOffset(390, 740, 338);
check(
  "phone-frame:offset-with-sheet",
  offsetOpen.fullW === 390 &&
    offsetOpen.fullH === 740 &&
    offsetOpen.x === 0 &&
    offsetOpen.y === 169 &&
    offsetOpen.w === 390 &&
    offsetOpen.h === 740,
  JSON.stringify(offsetOpen),
);

const boxes = [
  { x: 95, y: 295, w: 200, h: 150 },
  { x: 135, y: 220, w: 120, h: 300 },
  { x: 0, y: 0, w: 390, h: 740 },
];

for (const sheet of [0, 338]) {
  const area = { w: 390, h: 740 };
  const free = phoneFreeArea(area, sheet);
  for (const box of boxes) {
    const fit = fitBoxToArea(box, area, sheet);
    const cx = fit.screen.x + fit.screen.w / 2;
    const cy = fit.screen.y + fit.screen.h / 2;
    const dx = Math.abs(cx - free.w / 2);
    const dy = Math.abs(cy - free.h / 2);
    check(
      `phone-frame:centred-sheet-${sheet}-box-${box.w}x${box.h}`,
      dx <= 2 && dy <= 2,
      `centre off by ${dx.toFixed(2)},${dy.toFixed(2)} (screen ${fit.screen.x.toFixed(1)},${fit.screen.y.toFixed(1)} ${fit.screen.w.toFixed(1)}x${fit.screen.h.toFixed(1)} free ${String(free.w)}x${String(free.h)})`,
    );
    const widthShare = fit.screen.w / free.w;
    const heightShare = fit.screen.h / free.h;
    const widthHit = Math.abs(widthShare - PHONE_FRAME_WIDTH_SHARE) <= 0.02;
    const heightHit = Math.abs(heightShare - PHONE_FRAME_HEIGHT_SHARE) <= 0.02;
    const widthInside = widthShare <= PHONE_FRAME_WIDTH_SHARE + 0.02;
    const heightInside = heightShare <= PHONE_FRAME_HEIGHT_SHARE + 0.02;
    check(
      `phone-frame:fills-sheet-${sheet}-box-${box.w}x${box.h}`,
      (widthHit || heightHit) && widthInside && heightInside,
      `shares ${widthShare.toFixed(3)} x ${heightShare.toFixed(3)} (want 0.92 x 0.80)`,
    );
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
const guideSource = readFileSync(join(here, "..", "src", "guide.ts"), "utf8");

check(
  "phone-frame:pure-fitting",
  guideSource.includes("phoneFreeArea") &&
    guideSource.includes("phoneViewOffset") &&
    guideSource.includes("fitBoxToArea"),
  "the fitting stays in pure functions in guide.ts",
);
check(
  "phone-frame:projects-corners",
  mainSource.includes("projectRoomBox") && mainSource.includes("wallHeightM"),
  "the framing camera projects the eight room corners",
);
check(
  "phone-frame:moves-along-view",
  mainSource.includes("fitBoxToArea") && mainSource.includes("dist / fit.scale"),
  "the camera moves along the view direction to the 92/80 fit",
);
check(
  "phone-frame:uses-view-offset",
  mainSource.includes("phoneViewOffset") &&
    mainSource.includes("setViewOffset") &&
    mainSource.includes("clearViewOffset"),
  "the picture recentres with setViewOffset",
);
check(
  "phone-frame:updates-on-sheet-and-resize",
  mainSource.includes("openSheetHeight") &&
    mainSource.includes("applyPhoneViewOffset") &&
    mainSource.includes("private applyResize") &&
    mainSource.includes("syncPhoneBar"),
  "sheet open/close and resize re-seat without moving the camera",
);
check(
  "phone-frame:clears-desktop-and-plan",
  mainSource.includes("isPortraitPhone") &&
    mainSource.includes("clearViewOffset") &&
    mainSource.includes("private setMode") &&
    mainSource.includes("applyPhoneViewOffset"),
  "desktop and Plan clear the offset",
);

if (failures > 0) process.exit(1);
console.log("phone-frame: all checks passed");
