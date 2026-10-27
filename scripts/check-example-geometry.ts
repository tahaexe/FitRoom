/**
 * `npm run check:example-geometry` — headless example-room geometry check
 * (no browser, no Meta calls).
 *
 * The visitor-facing "Try the example room" flow replays four generated
 * photos of a 420 x 360 cm room from the demo store: `tryExample` in
 * `client/src/photo-room/flow.ts` fetches each wall's `-seg.jpg` /
 * `-label.jpg`, and every segment answer comes from the demo store
 * (`server/data/demo/segment/`, keyed by the SHA-256 of the image data URL
 * exactly like the gateway pipeline keys it). This check replays that path
 * headlessly: it hashes the four committed `-seg.jpg` files, pulls the
 * recorded answers for all five concepts per wall, decodes them with the
 * shared `segmentInstances` (the function the photo flow uses through
 * `client/src/capture/sam.ts`), and solves the room with the example's
 * tapes through `solveRoomFromPhotos` (the flow's build-step solver, same
 * `focal35mm: undefined` as `tryExample` sets).
 *
 * Prints one table (each wall with its taped/estimated source, value and
 * error; the ceiling; each opening with wall, order, offset, width and
 * error) and exits non-zero on any FAIL. Truth: 420 x 360 cm, ceiling
 * 260 cm, the door 90 cm at 30 cm on wall A, and the windows from
 * `.inbox/truth/living-420x360-*.json` on the walls the example maps them
 * to (example C shows truth's north window 160 cm at 80 cm on wall-3,
 * example D truth's east window 120 cm at 120 cm on wall-2, example B has
 * no openings). Bars: taped walls exact, estimated walls within ±5 %,
 * ceiling within ±5 % (the example room is built from generated photos,
 * not exact renders, so it gets the same tolerance as its estimated
 * walls), every opening on the right wall in the right order, offset
 * ±15 cm, width ±10 cm.
 */

/* global console, process */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXAMPLE_SEG_SIZE,
  EXAMPLE_TAPE_A,
  EXAMPLE_TAPE_B,
  type WallLetter,
} from "../client/src/photo-room/example.js";
import { segmentInstances } from "../shared/src/sam.js";
import {
  LETTER_TO_WALL_ID,
  solveRoomFromPhotos,
  validateRoomDraft,
  type PhotoInput,
  type RoomDraft,
} from "../shared/src/photo-room/index.js";
import { validateRoomLayout } from "../shared/src/validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const segDir = join(repoRoot, "server", "data", "demo", "segment");
const exampleDir = join(repoRoot, "client", "public", "assets", "example-room");

const LETTERS: WallLetter[] = ["A", "B", "C", "D"];
const FILE_OF: Record<WallLetter, string> = { A: "a", B: "b", C: "c", D: "d" };
const CONCEPTS = ["wall", "floor", "ceiling", "door", "window"] as const;

const TAPE_A = Number(EXAMPLE_TAPE_A);
const TAPE_B = Number(EXAMPLE_TAPE_B);
const TRUTH_HEIGHT = 260;

interface TruthOpening {
  wall: WallLetter;
  type: "door" | "window";
  offset: number;
  width: number;
}

const TRUTH_OPENINGS: TruthOpening[] = [
  { wall: "A", type: "door", offset: 30, width: 90 },
  { wall: "C", type: "window", offset: 80, width: 160 },
  { wall: "D", type: "window", offset: 120, width: 120 },
];

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Recorded demo-store segment answers keyed by image hash, then concept. */
function loadDemoAnswers(): Map<string, Map<string, string>> {
  const byImage = new Map<string, Map<string, string>>();
  let files: string[];
  try {
    files = readdirSync(segDir).filter((f) => f.endsWith(".json"));
  } catch {
    return byImage;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(segDir, f), "utf8")) as {
        input?: { concept?: unknown; image?: unknown };
        response?: { text?: unknown };
      };
      const concept = parsed.input?.concept;
      const image = parsed.input?.image;
      const text = parsed.response?.text;
      if (typeof concept !== "string" || typeof image !== "string" || typeof text !== "string") {
        continue;
      }
      let perConcept = byImage.get(image);
      if (perConcept === undefined) {
        perConcept = new Map<string, string>();
        byImage.set(image, perConcept);
      }
      perConcept.set(concept, text);
    } catch {
      continue;
    }
  }
  return byImage;
}

async function photoFor(
  letter: WallLetter,
  byImage: Map<string, Map<string, string>>,
): Promise<PhotoInput | null> {
  const file = join(exampleDir, `${FILE_OF[letter]}-seg.jpg`);
  let dataUrl: string;
  try {
    const bytes = readFileSync(file);
    dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
  const key = sha256Hex(dataUrl);
  const perConcept = byImage.get(key);
  if (perConcept === undefined) return null;
  const instances: PhotoInput["instances"] = [];
  for (const concept of CONCEPTS) {
    const text = perConcept.get(concept);
    if (text === undefined || text.trim().length === 0) continue;
    instances.push(
      ...(await segmentInstances(concept, text, {
        width: EXAMPLE_SEG_SIZE.width,
        height: EXAMPLE_SEG_SIZE.height,
      })),
    );
  }
  return {
    wall: letter,
    width: EXAMPLE_SEG_SIZE.width,
    height: EXAMPLE_SEG_SIZE.height,
    focal35mm: undefined,
    instances,
  };
}

/**
 * The flow's missing-tape estimate (`PhotoFlow.estimateMissingTape` in
 * `client/src/photo-room/flow.ts`): with one tape unknown, the first pass
 * solves with the known tape on both axes and the missing wall scales by
 * the solved width/height ratios (both walls share one ceiling height).
 */
function estimateMissingTape(
  draft: RoomDraft,
  known: number,
  missingLetter: WallLetter,
  knownLetter: WallLetter,
): number {
  const missing = draft.photos.find((s) => s.wall === missingLetter);
  const knownSol = draft.photos.find((s) => s.wall === knownLetter);
  const ratioM = missing?.ratio ?? NaN;
  const ratioK = knownSol?.ratio ?? NaN;
  if (
    missing === undefined ||
    knownSol === undefined ||
    !Number.isFinite(ratioM) ||
    !Number.isFinite(ratioK) ||
    ratioM <= 0 ||
    ratioK <= 0
  ) {
    return known;
  }
  return Math.max(50, Math.min(2000, Math.round((known * ratioM) / ratioK)));
}

function printTable(title: string, draft: RoomDraft): void {
  console.log(`--- ${title} (truth 420x360cm, ceiling truth 260cm)`);
  for (const letter of LETTERS) {
    const got = draft.wallLengths[letter];
    const want = letter === "A" || letter === "C" ? TAPE_A : TAPE_B;
    const err = Math.round((got.value - want) * 10) / 10;
    console.log(
      `wall ${letter} (${LETTER_TO_WALL_ID[letter]}): ${String(got.value)}cm [${got.source} ±${String(got.plusMinus)}] err ${err >= 0 ? "+" : ""}${String(err)}cm`,
    );
  }
  const cErr = Math.round((draft.ceilingHeight.value - TRUTH_HEIGHT) * 10) / 10;
  const cPct = Math.round(((draft.ceilingHeight.value - TRUTH_HEIGHT) / TRUTH_HEIGHT) * 1000) / 10;
  console.log(
    `ceiling: ${String(draft.ceilingHeight.value)}cm [${draft.ceilingHeight.source} ±${String(draft.ceilingHeight.plusMinus)}] err ${cErr >= 0 ? "+" : ""}${String(cErr)}cm (${cPct >= 0 ? "+" : ""}${String(cPct)}%)`,
  );
  const truth = [...TRUTH_OPENINGS].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset - b.offset,
  );
  const got = [...draft.openings].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset.value - b.offset.value,
  );
  console.log(`openings: got ${String(got.length)}, truth ${String(truth.length)}`);
  for (const o of got) {
    const near = [...truth]
      .filter((t) => t.wall === o.wall && t.type === o.type)
      .sort((a, b) => Math.abs(a.offset - o.offset.value) - Math.abs(b.offset - o.offset.value))[0];
    const dOff =
      near === undefined
        ? "n/a"
        : `${(o.offset.value - near.offset >= 0 ? "+" : "") + String(Math.round((o.offset.value - near.offset) * 10) / 10)}cm`;
    const dW =
      near === undefined
        ? "n/a"
        : `${(o.width.value - near.width >= 0 ? "+" : "") + String(Math.round((o.width.value - near.width) * 10) / 10)}cm`;
    console.log(
      `  ${o.wall} ${o.type} off ${String(o.offset.value)}±${String(o.offset.plusMinus)} w ${String(o.width.value)}±${String(o.width.plusMinus)} | err off ${dOff} w ${dW}`,
    );
  }
  console.log(
    `flags (${String(draft.flags.length)}): ${draft.flags.map((f) => `${f.code}${f.wall === undefined ? "" : `@${f.wall}`}`).join(", ") || "none"}`,
  );
  const layoutRes = validateRoomLayout(draft.layout);
  console.log(
    `layout validates: ${layoutRes.ok ? "yes" : "NO — " + layoutRes.errors.map((e) => e.message).join("; ")}`,
  );
}

async function main(): Promise<void> {
  console.log("== example geometry ==");
  check(
    "example tapes are 420 and 360",
    TAPE_A === 420 && TAPE_B === 360,
    `${EXAMPLE_TAPE_A} x ${EXAMPLE_TAPE_B}`,
  );
  const byImage = loadDemoAnswers();
  check(
    "the demo store holds segment answers",
    byImage.size >= 4,
    `${String(byImage.size)} image(s)`,
  );
  const photos: PhotoInput[] = [];
  for (const letter of LETTERS) {
    const photo = await photoFor(letter, byImage);
    check(
      `demo store replays wall ${letter}`,
      photo !== null && photo.instances.length > 0,
      photo === null
        ? "no recorded answer for the example image"
        : `${String(photo.instances.length)} instances`,
    );
    if (photo !== null) photos.push(photo);
  }
  if (photos.length !== 4) {
    console.log(`check:example-geometry: ${String(failures)} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  const draft = solveRoomFromPhotos({ photos, tapeA: TAPE_A, tapeB: TAPE_B });
  printTable("example room from demo-store replay", draft);

  for (const letter of LETTERS) {
    const want = letter === "A" || letter === "C" ? TAPE_A : TAPE_B;
    check(
      `example: taped wall ${letter} exact`,
      draft.wallLengths[letter].value === want,
      `${String(draft.wallLengths[letter].value)} vs ${String(want)}`,
    );
  }
  const cErrPct = Math.abs(draft.ceilingHeight.value - TRUTH_HEIGHT) / TRUTH_HEIGHT;
  // The example room is built from generated photos, not exact renders,
  // so the ceiling gets the same ±5 % tolerance as its estimated walls.
  check(
    "example: ceiling within ±5 %",
    cErrPct <= 0.05,
    `${String(draft.ceilingHeight.value)} vs ${String(TRUTH_HEIGHT)}`,
  );
  const truth = [...TRUTH_OPENINGS].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset - b.offset,
  );
  const got = [...draft.openings].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset.value - b.offset.value,
  );
  check(
    "example: opening count matches",
    got.length === truth.length,
    `got ${String(got.length)} want ${String(truth.length)}`,
  );
  const n = Math.min(got.length, truth.length);
  for (let i = 0; i < n; i += 1) {
    const g = got[i];
    const t = truth[i];
    if (g === undefined || t === undefined) continue;
    check(
      `example: opening ${String(i)} on the right wall`,
      g.wall === t.wall && g.type === t.type,
      `got ${g.wall}/${g.type} want ${t.wall}/${t.type}`,
    );
    if (g.wall === t.wall && g.type === t.type) {
      check(
        `example: opening ${String(i)} offset ±15 cm`,
        Math.abs(g.offset.value - t.offset) <= 15,
        `got ${String(g.offset.value)} want ${String(t.offset)}`,
      );
      check(
        `example: opening ${String(i)} width ±10 cm`,
        Math.abs(g.width.value - t.width) <= 10,
        `got ${String(g.width.value)} want ${String(t.width)}`,
      );
    }
  }
  for (const letter of LETTERS) {
    const gWalls = got
      .filter((g) => g.wall === letter)
      .map((g) => `${g.type}@${Math.round(g.offset.value)}`);
    const tWalls = truth.filter((t) => t.wall === letter).map((t) => `${t.type}@${t.offset}`);
    check(
      `example: wall ${letter} order [${gWalls.join(", ")}]`,
      gWalls.length === tWalls.length &&
        gWalls.every(
          (_, i) =>
            got.filter((g) => g.wall === letter)[i]?.type ===
            truth.filter((t) => t.wall === letter)[i]?.type,
        ),
    );
  }

  // Missing-tape probes: the flow estimates an unknown tape from the other
  // tape through the solved ratios (see `estimateMissingTape` above), so a
  // shopper measuring one wall still lands within ±5 % on the others.
  const firstB = solveRoomFromPhotos({ photos, tapeA: TAPE_A, tapeB: TAPE_A });
  const estB = estimateMissingTape(firstB, TAPE_A, "B", "A");
  const estD = estimateMissingTape(firstB, TAPE_A, "D", "C");
  console.log(
    `estimated with tape A only: B ${String(estB)}cm (truth 360), D ${String(estD)}cm (truth 360)`,
  );
  for (const [letter, est] of [
    ["B", estB],
    ["D", estD],
  ] as const) {
    check(
      `example: estimated wall ${letter} within ±5 %`,
      Math.abs(est - TAPE_B) <= TAPE_B * 0.05,
      `${String(est)} vs ${String(TAPE_B)}`,
    );
  }
  const firstA = solveRoomFromPhotos({ photos, tapeA: TAPE_B, tapeB: TAPE_B });
  const estA = estimateMissingTape(firstA, TAPE_B, "A", "B");
  const estC = estimateMissingTape(firstA, TAPE_B, "C", "D");
  console.log(
    `estimated with tape B only: A ${String(estA)}cm (truth 420), C ${String(estC)}cm (truth 420)`,
  );
  for (const [letter, est] of [
    ["A", estA],
    ["C", estC],
  ] as const) {
    check(
      `example: estimated wall ${letter} within ±5 %`,
      Math.abs(est - TAPE_A) <= TAPE_A * 0.05,
      `${String(est)} vs ${String(TAPE_A)}`,
    );
  }

  const vd = validateRoomDraft(draft);
  check("example: RoomDraft validates", vd.ok, vd.errors.join("; "));

  console.log(
    failures === 0
      ? "check:example-geometry: all checks passed"
      : `check:example-geometry: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(
    `check:example-geometry: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
