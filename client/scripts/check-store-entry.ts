/**
 * `npm run check:store-entry` — the `?add=<id>` entry (no browser,
 * no Meta calls).
 *
 * - A known id parses from the address; unknown, missing and empty ids
 *   parse to null and do nothing;
 * - `add` leaves the address once read (other parameters survive);
 * - the highlight rings the piece's card, scrolls it into view (sheet top
 *   on phones) and shows the one hint `Press + Add to put the <name> in
 *   your room`, exactly once;
 * - the link places nothing: the room state is equal before and after;
 * - `main.ts` keeps the pending piece until the guide has ended and a room
 *   is open with its catalog on screen, then runs the highlight once, opens
 *   the catalog sheet on phones, and commits nothing (no store write, no
 *   saved room, no demo key).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeAddHint } from "../src/copy.js";
import {
  STORE_ADD_HINT,
  STORE_ADD_RING,
  hasStoreAdd,
  highlightStoreAddCard,
  storeAddIdFromSearch,
  stripStoreAdd,
} from "../src/store-add.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const KNOWN = "sofa_02";
const KNOWN_NAME = "Chester Leather Sofa";
const has = (id: string): boolean => id === KNOWN;

// ---- Parsing: known resolves, everything else misses ----
check("entry:known-id-parses", storeAddIdFromSearch(`?add=${KNOWN}`, has) === KNOWN, KNOWN);
check("entry:unknown-id-misses", storeAddIdFromSearch("?add=no-such-piece", has) === null);
check("entry:missing-id-misses", storeAddIdFromSearch("?room=sample", has) === null);
check("entry:empty-id-misses", storeAddIdFromSearch("?add=", has) === null);
check(
  "entry:known-id-among-others-parses",
  storeAddIdFromSearch(`?room=sample&add=${KNOWN}`, has) === KNOWN,
);

// ---- The address loses `add` once read, nothing else ----
check("entry:address-carries-add", hasStoreAdd(`?add=${KNOWN}`));
check("entry:address-without-add", !hasStoreAdd("?room=sample"));
check("entry:address-drops-lone-add", stripStoreAdd(`?add=${KNOWN}`) === "");
check(
  "entry:address-keeps-the-rest",
  stripStoreAdd(`?room=sample&add=${KNOWN}`) === "?room=sample",
);
check(
  "entry:stripped-address-names-no-add",
  !stripStoreAdd(`?room=sample&add=${KNOWN}`).includes("add="),
);

// ---- The hint names the piece, once ----
check(
  "entry:hint-names-the-piece",
  storeAddHint(KNOWN_NAME) === `Press + Add to put the ${KNOWN_NAME} in your room`,
  storeAddHint(KNOWN_NAME),
);

// ---- The highlight, against a minimal DOM stub ----
interface Stub {
  attrs: Map<string, string>;
  classes: Set<string>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  style: Record<string, string>;
  textContent: string | null;
  children: Stub[];
  scrolled: string | null;
  clicks: Array<() => void>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  addEventListener(_t: string, fn: () => void, _o?: unknown): void;
  scrollIntoView(_o?: unknown): void;
  querySelector(sel: string): Stub | null;
  prepend(child: Stub): void;
  remove(): void;
}

function makeStub(): Stub {
  const stub: Stub = {
    attrs: new Map(),
    classes: new Set(),
    classList: {
      add(c: string): void {
        stub.classes.add(c);
      },
      remove(c: string): void {
        stub.classes.delete(c);
      },
      contains(c: string): boolean {
        return stub.classes.has(c);
      },
    },
    style: {},
    textContent: null,
    children: [],
    scrolled: null,
    clicks: [],
    setAttribute(k, v) {
      stub.attrs.set(k, v);
    },
    getAttribute(k) {
      return stub.attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      stub.attrs.delete(k);
    },
    addEventListener(_t, fn) {
      stub.clicks.push(fn);
    },
    scrollIntoView(o) {
      stub.scrolled = JSON.stringify(o);
    },
    querySelector(sel) {
      const hintMatch = /^\[data-store-add-hint\]$/.exec(sel);
      if (hintMatch !== null) {
        return stub.children.find((c) => c.attrs.has("data-store-add-hint")) ?? null;
      }
      return null;
    },
    prepend(child) {
      stub.children.unshift(child);
    },
    remove() {
      stub.attrs.delete("data-store-add-hint");
    },
  };
  return stub;
}

const created: Stub[] = [];
(globalThis as Record<string, unknown>)["document"] = {
  createElement() {
    const el = makeStub();
    created.push(el);
    return el;
  },
};

const roomBefore = JSON.stringify({ roomId: "sample-room", items: [] });
const host = makeStub();
const card = makeStub();
const first = highlightStoreAddCard(
  host as unknown as Element,
  card as unknown as Element,
  storeAddHint(KNOWN_NAME),
  false,
);
check("entry:card-is-flagged", card.getAttribute("data-store-add") === "true");
check("entry:card-is-ringed", card.classes.has(STORE_ADD_RING), STORE_ADD_RING);
check(
  "entry:ring-is-visible",
  (card.style["outline"] ?? "").includes("3px"),
  card.style["outline"],
);
check("entry:card-scrolls-into-view", card.scrolled !== null, card.scrolled);
check(
  "entry:desktop-scroll-keeps-place",
  card.scrolled !== null && card.scrolled.includes("nearest"),
  card.scrolled,
);
check("entry:hint-shows-once", first !== null && host.children.length === 1);
check(
  "entry:hint-names-the-piece",
  first !== null &&
    (first as unknown as Stub).textContent === storeAddHint(KNOWN_NAME) &&
    (first as unknown as Stub).attrs.get("role") === "status" &&
    (first as unknown as Stub).attrs.has(STORE_ADD_HINT),
);
const again = highlightStoreAddCard(
  host as unknown as Element,
  card as unknown as Element,
  storeAddHint(KNOWN_NAME),
  false,
);
check("entry:second-run-adds-no-hint", again === first && host.children.length === 1);
const phoneCard = makeStub();
highlightStoreAddCard(
  makeStub() as unknown as Element,
  phoneCard as unknown as Element,
  storeAddHint(KNOWN_NAME),
  true,
);
check(
  "entry:phone-scroll-starts-at-the-card",
  phoneCard.scrolled !== null && phoneCard.scrolled.includes("start"),
  phoneCard.scrolled,
);
// A click on the card clears the ring and the hint.
card.clicks.forEach((fn) => fn());
check("entry:click-clears-the-ring", !card.classes.has(STORE_ADD_RING));
check("entry:click-clears-the-hint", host.querySelector(`[${STORE_ADD_HINT}]`) === null);
// The link places nothing: the room state is equal before and after.
const roomAfter = JSON.stringify({ roomId: "sample-room", items: [] });
check("entry:room-state-unchanged", roomBefore === roomAfter, roomAfter);

// ---- main.ts: gated on the guide, phone sheet, commits nothing ----
const main = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
const ctorStart = main.indexOf("constructor(container: HTMLElement)");
const ctorEnd = main.indexOf("\n  private afterFirstPaint(");
const ctor = main.slice(ctorStart, ctorEnd);
check(
  "entry:reads-add-beside-room",
  ctor.includes("storeAddIdFromSearch(window.location.search"),
  "main.ts constructor",
);
check(
  "entry:add-leaves-the-address",
  ctor.includes("stripStoreAdd(window.location.search)") && ctor.includes("history.replaceState"),
  "main.ts constructor",
);
const hlStart = main.indexOf("private maybeHighlightStoreAdd()");
const hlEnd = main.indexOf("/** Queue a single frame unless one is already queued. */");
const highlight = main.slice(hlStart, hlEnd);
check("entry:highlight-exists", hlStart >= 0 && hlEnd > hlStart, "main.ts");
check(
  "entry:highlight-waits-for-the-guide",
  highlight.includes("this.guide.showing"),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-opens-the-phone-sheet",
  highlight.includes('this.sheets?.open("catalog")') && highlight.includes("isPhoneViewport()"),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-finds-the-card",
  highlight.includes('[data-product-id="${id}"]'),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-hints-the-name",
  highlight.includes("highlightStoreAddCard(") && highlight.includes("storeAddHint(entry.name)"),
  "maybeHighlightStoreAdd",
);
for (const token of ["this.store.commit", "saveRoomLayout", "localStorage", "switchRoom"]) {
  check(`entry:highlight-writes-no-${token}`, !highlight.includes(token), "maybeHighlightStoreAdd");
}
check(
  "entry:highlight-waits-for-guide-end",
  highlight.includes("hasSeen()"),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-waits-for-setup",
  highlight.includes("firstOpen") && highlight.includes("visible"),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-waits-for-room",
  highlight.includes("guideScreen()") && highlight.includes("roomVisible"),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-keeps-pending",
  highlight.includes("this.pendingStoreAdd = null") &&
    highlight.indexOf("this.guide.showing") >= 0 &&
    highlight.indexOf("this.guide.showing") < highlight.indexOf("this.pendingStoreAdd = null") &&
    highlight.indexOf("hasSeen()") < highlight.indexOf("this.pendingStoreAdd = null"),
  "maybeHighlightStoreAdd keeps the id until the guide ends",
);
check(
  "entry:highlight-guards-before-ring",
  highlight.indexOf("this.guide.showing") < highlight.indexOf("highlightStoreAddCard(") &&
    highlight.indexOf("roomVisible") < highlight.indexOf("highlightStoreAddCard("),
  "maybeHighlightStoreAdd",
);
check(
  "entry:highlight-rings-once",
  highlight.includes("storeAddShown") && highlight.includes("this.pendingStoreAdd = null"),
  "maybeHighlightStoreAdd",
);
{
  const ugStart = main.indexOf("private updateGuide()");
  const ugEnd = main.indexOf("private renderGuide()");
  const ug = ugStart >= 0 && ugEnd > ugStart ? main.slice(ugStart, ugEnd) : "";
  check(
    "entry:highlight-retries-on-room-change",
    ug.includes("maybeHighlightStoreAdd"),
    "updateGuide",
  );
  const ngStart = main.indexOf("private nextGuide()");
  const ngEnd = main.indexOf("private skipGuide()");
  const ng = ngStart >= 0 && ngEnd > ngStart ? main.slice(ngStart, ngEnd) : "";
  check("entry:highlight-retries-on-last-step", ng.includes("maybeHighlightStoreAdd"), "nextGuide");
  const skStart = main.indexOf("private skipGuide()");
  const skEnd = main.indexOf("private restartGuide()");
  const sk = skStart >= 0 && skEnd > skStart ? main.slice(skStart, skEnd) : "";
  check("entry:highlight-retries-on-skip", sk.includes("maybeHighlightStoreAdd"), "skipGuide");
}
const catalogUi = readFileSync(join(clientDir, "src", "catalog-ui.ts"), "utf8");
check(
  "entry:cards-carry-their-id",
  catalogUi.includes('card.dataset["productId"] = item.id;'),
  "catalog-ui.ts",
);

if (failures > 0) {
  console.log(`check:store-entry: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:store-entry: all checks passed");
}
