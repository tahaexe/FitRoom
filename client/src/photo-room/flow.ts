/**
 * "From photos" flow: photograph four walls, check each instantly, type two
 * tape values, get a draft room to confirm in the plan editor.
 *
 * Steps (top line): Photograph → Check → Build room. Capture screens run
 * A to D (A is the entrance-door wall); each shows a floating card with a
 * mini plan (current wall coral), one framing line, and a photo picker
 * (`input[type=file accept=image/*]`, drag and drop on desktop). After each
 * photo the wall is segmented (`wall`, `floor`, `ceiling`, `door`, `window`
 * in parallel) and solved for an instant bottom-sheet check; the tape step
 * takes wall A and B lengths; the build step labels, solves and hands a
 * `RoomDraft` to the plan editor.
 */

import {
  blendWallTints,
  defaultRoomLabel,
  LETTER_TO_WALL_ID,
  pickFloorTexture,
  pickWallTexture,
  solveRoomFromPhotos,
  type DoorTap,
  type PhotoInput,
  type PhotoSolution,
  type RoomDraft,
  type RoomLabelAnswer,
  type SamInstance,
  type Uncertain,
  type WallLetter,
} from "@fitroom/shared";
import { isLive, postLabel, setLive } from "../api";
import {
  EXAMPLE_LABEL_SIZE,
  EXAMPLE_SEG_SIZE,
  EXAMPLE_TAPE_A,
  EXAMPLE_TAPE_B,
  EXAMPLE_TAPE_NOTE,
  EXAMPLE_ROOM_NAME,
  exampleBadge,
  exampleLabelUrl,
  exampleSegUrl,
  exampleWebpUrl,
} from "./example";
import { processPhotoFile, type IntakePhoto } from "./intake";
import { clearPhoto, loadPhoto, savePhoto, type StoredPhoto } from "./photo-store";
import {
  EDGE_AT_DOOR_COPY,
  TWO_WALLS_COPY,
  bothCornersOk,
  errorRecovery,
  nextIsPrimary,
} from "./cards";
import {
  analyseWallPhoto,
  cornersFound,
  floorLineFound,
  LABEL_TIMEOUT_MS,
  tiltDeg,
  TILT_AMBER_DEG,
  type WallAnalysis,
} from "./segment";

export const WALL_ORDER: WallLetter[] = ["A", "B", "C", "D"];

const WALL_BLURB: Record<WallLetter, string> = {
  A: "Wall A · the wall with the entrance door",
  B: "Wall B · on the right as you face wall A",
  C: "Wall C · opposite the entrance door",
  D: "Wall D · on the left as you face wall A",
};

export interface WallSourceMark {
  source: "measured" | "estimated";
  plusMinus?: number;
}

export interface OpeningSourceMarks {
  offset: WallSourceMark;
  width: WallSourceMark;
  height: WallSourceMark;
  sill: WallSourceMark;
}

/** Per-value sources the plan editor renders beside every field. */
export interface PhotoDraftMeta {
  walls: Record<string, WallSourceMark>;
  ceiling: { value: number } & WallSourceMark;
  openings: Record<string, OpeningSourceMarks>;
  estimatedWallCount: number;
  estimatedWallPm: number;
}

export interface PhotoFlowDone {
  draft: RoomDraft;
  meta: PhotoDraftMeta;
}

interface WallState {
  photo: StoredPhoto | null;
  intake: IntakePhoto | null;
  instances: SamInstance[];
  analysis: WallAnalysis | null;
  demoMiss: boolean;
  error: string | null;
  analysing: boolean;
  reading: boolean;
  progress: { done: number; total: number };
  tap: { x: number; y: number } | null;
  tapping: boolean;
  doorMarked: boolean;
  example: boolean;
}

function emptyWallState(): WallState {
  return {
    photo: null,
    intake: null,
    instances: [],
    analysis: null,
    demoMiss: false,
    error: null,
    analysing: false,
    reading: false,
    progress: { done: 0, total: 0 },
    tap: null,
    tapping: false,
    doorMarked: false,
    example: false,
  };
}

function fetchDataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`The example photo is missing (${url}).`);
      return res.blob();
    })
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("The example photo could not be read."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        }),
    );
}

function toMark(source: Uncertain["source"], plusMinus: number): WallSourceMark {
  return source === "taped" ? { source: "measured" } : { source: "estimated", plusMinus };
}

export function draftMeta(
  draft: RoomDraft,
  estimated: Partial<Record<WallLetter, number>>,
): PhotoDraftMeta {
  const walls: Record<string, WallSourceMark> = {};
  for (const letter of WALL_ORDER) {
    const wallId = draft.letterToWallId[letter] ?? LETTER_TO_WALL_ID[letter];
    const pm = estimated[letter];
    walls[wallId] =
      pm === undefined
        ? toMark(draft.wallLengths[letter].source, 0)
        : { source: "estimated", plusMinus: pm };
  }
  const openings: Record<string, OpeningSourceMarks> = {};
  for (const opening of draft.openings) {
    openings[opening.id] = {
      offset: toMark(opening.offset.source, opening.offset.plusMinus),
      width: toMark(opening.width.source, opening.width.plusMinus),
      height: toMark(opening.height.source, opening.height.plusMinus),
      sill: toMark(opening.sillHeight.source, opening.sillHeight.plusMinus),
    };
  }
  const estimatedLetters = (Object.keys(estimated) as WallLetter[]).filter(
    (letter) => estimated[letter] !== undefined,
  );
  const pms = estimatedLetters.map((letter) => estimated[letter] ?? 0);
  return {
    walls,
    ceiling: {
      value: draft.ceilingHeight.value,
      ...toMark(draft.ceilingHeight.source, draft.ceilingHeight.plusMinus),
    },
    openings,
    estimatedWallCount: estimatedLetters.length * 2 > 4 ? 4 : estimatedLetters.length * 2,
    estimatedWallPm: pms.length > 0 ? Math.max(...pms) : 0,
  };
}

/** Mini plan: rectangle with the current wall in coral, letters on edges. */
export function miniPlanSvg(current: WallLetter): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 96");
  svg.setAttribute("class", "photo-mini-plan");
  svg.setAttribute("aria-hidden", "true");
  const x0 = 18;
  const y0 = 14;
  const w = 84;
  const h = 60;
  const edges: Array<{
    letter: WallLetter;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    lx: number;
    ly: number;
  }> = [
    { letter: "A", x1: x0, y1: y0 + h, x2: x0 + w, y2: y0 + h, lx: x0 + w / 2, ly: y0 + h + 12 },
    { letter: "B", x1: x0, y1: y0 + h, x2: x0, y2: y0, lx: x0 - 10, ly: y0 + h / 2 },
    { letter: "C", x1: x0 + w, y1: y0, x2: x0, y2: y0, lx: x0 + w / 2, ly: y0 - 6 },
    { letter: "D", x1: x0 + w, y1: y0, x2: x0 + w, y2: y0 + h, lx: x0 + w + 10, ly: y0 + h / 2 },
  ];
  for (const edge of edges) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(edge.x1));
    line.setAttribute("y1", String(edge.y1));
    line.setAttribute("x2", String(edge.x2));
    line.setAttribute("y2", String(edge.y2));
    line.setAttribute("stroke", edge.letter === current ? "#f54e49" : "#2b2c30");
    line.setAttribute("stroke-width", edge.letter === current ? "5" : "3");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(edge.lx));
    label.setAttribute("y", String(edge.ly));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("class", "photo-mini-letter");
    label.setAttribute("fill", edge.letter === current ? "#f54e49" : "#6b7078");
    label.textContent = edge.letter;
    svg.appendChild(label);
  }
  return svg;
}

function tapeIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const tape = document.createElementNS(NS, "path");
  tape.setAttribute("d", "M1 5h10a3 3 0 0 1 3 3v3H4a3 3 0 0 1-3-3V5z");
  tape.setAttribute("fill", "none");
  tape.setAttribute("stroke", "currentColor");
  tape.setAttribute("stroke-width", "1.5");
  svg.appendChild(tape);
  for (const x of [5, 8, 11]) {
    const tick = document.createElementNS(NS, "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("y1", "5");
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y2", "7.5");
    tick.setAttribute("stroke", "currentColor");
    tick.setAttribute("stroke-width", "1.2");
    svg.appendChild(tick);
  }
  return svg;
}

export type FlowStep = "capture" | "tape" | "build";

export class PhotoFlow {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private walls = new Map<WallLetter, WallState>();
  private wallIndex = 0;
  private step: FlowStep = "capture";
  private tapeA = "";
  private tapeB = "";
  private tapeError: string | null = null;
  private exampleMode = false;
  private exampleLoading = false;
  private readonly exampleDisplay = new Map<WallLetter, string>();
  private buildMessage = "Solving your room…";
  private buildError: string | null = null;

  constructor(
    private readonly callbacks: {
      onDone: (result: PhotoFlowDone) => void;
      onClose: () => void;
    },
  ) {
    for (const letter of WALL_ORDER) this.walls.set(letter, emptyWallState());
    this.element = document.createElement("div");
    this.element.className = "photo-flow";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Build a room from photos");
    const head = document.createElement("div");
    head.className = "photo-head";
    this.stepsEl = document.createElement("ol");
    this.stepsEl.className = "photo-steps";
    head.appendChild(this.stepsEl);
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "photo-leave";
    leave.textContent = "Leave";
    leave.addEventListener("click", () => this.callbacks.onClose());
    head.appendChild(leave);
    this.element.appendChild(head);
    this.body = document.createElement("div");
    this.body.className = "photo-body";
    this.element.appendChild(this.body);
    void this.restore();
  }

  /** Reload saved downscaled photos (a reload keeps the run). */
  private async restore(): Promise<void> {
    for (const letter of WALL_ORDER) {
      try {
        const stored = await loadPhoto(letter);
        if (stored === null) continue;
        const state = this.walls.get(letter);
        if (state === undefined) continue;
        state.photo = stored;
        state.intake = stored;
      } catch (error) {
        console.error(`Restoring the photo for wall ${letter} failed.`, error);
      }
    }
    this.render();
  }

  private anyIntake(): boolean {
    return WALL_ORDER.some((letter) => this.stateOf(letter).intake !== null);
  }

  private refreshExampleMode(): void {
    this.exampleMode = WALL_ORDER.some((letter) => this.stateOf(letter).example);
  }

  /**
   * "Try the example room": load the four generated example photos, prefill
   * the tapes from the example's tape measurements, and replay every
   * analysis from the demo store (no upstream call in demo mode).
   */
  async tryExample(): Promise<void> {
    if (this.exampleLoading) return;
    this.exampleLoading = true;
    this.exampleMode = true;
    this.tapeA = EXAMPLE_TAPE_A;
    this.tapeB = EXAMPLE_TAPE_B;
    this.tapeError = null;
    this.step = "capture";
    this.wallIndex = 0;
    for (const letter of WALL_ORDER) {
      const state = this.stateOf(letter);
      state.error = null;
      state.demoMiss = false;
      state.reading = true;
    }
    this.render();
    for (const letter of WALL_ORDER) {
      const state = this.stateOf(letter);
      try {
        const [segUrl, labelUrl] = await Promise.all([
          fetchDataUrl(exampleSegUrl(letter)),
          fetchDataUrl(exampleLabelUrl(letter)),
        ]);
        try {
          const webp = await fetch(exampleWebpUrl(letter));
          if (webp.ok) {
            const blob = await webp.blob();
            if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
              this.exampleDisplay.set(letter, URL.createObjectURL(blob));
            }
          }
        } catch {
          // The preview falls back to the labelled photo below.
        }
        const stored: StoredPhoto = {
          segUrl,
          segWidth: EXAMPLE_SEG_SIZE.width,
          segHeight: EXAMPLE_SEG_SIZE.height,
          labelUrl,
          labelWidth: EXAMPLE_LABEL_SIZE.width,
          labelHeight: EXAMPLE_LABEL_SIZE.height,
          orientation: 1,
          focal35mm: undefined,
          wall: letter,
          savedAt: Date.now(),
        };
        try {
          await savePhoto(stored);
        } catch (saveError) {
          console.warn("Keeping the example photo in memory: saving it failed.", saveError);
        }
        state.photo = stored;
        state.intake = {
          segUrl,
          segWidth: EXAMPLE_SEG_SIZE.width,
          segHeight: EXAMPLE_SEG_SIZE.height,
          labelUrl,
          labelWidth: EXAMPLE_LABEL_SIZE.width,
          labelHeight: EXAMPLE_LABEL_SIZE.height,
          orientation: 1,
          focal35mm: undefined,
        };
        state.analysis = null;
        state.tap = null;
        state.doorMarked = false;
        state.example = true;
      } catch (error) {
        console.error(`Loading the example photo for wall ${letter} failed.`, error);
        state.error = "The example room could not be loaded. Please try again.";
        state.example = false;
      } finally {
        state.reading = false;
      }
      this.render();
    }
    for (const letter of WALL_ORDER) {
      if (this.stateOf(letter).intake !== null) {
        await this.analyse(letter, null);
      }
    }
    this.exampleLoading = false;
    this.refreshExampleMode();
    this.step = "tape";
    this.wallIndex = 0;
    this.render();
  }

  private currentLetter(): WallLetter {
    return WALL_ORDER[this.wallIndex] ?? "A";
  }

  private render(): void {
    this.renderSteps();
    this.body.innerHTML = "";
    if (this.step === "capture") this.renderCapture(this.body, this.currentLetter());
    else if (this.step === "tape") this.renderTape(this.body);
    else this.renderBuild(this.body);
  }

  private renderSteps(): void {
    const steps: Array<{ id: FlowStep; label: string }> = [
      { id: "capture", label: "Photograph" },
      { id: "tape", label: "Check" },
      { id: "build", label: "Build room" },
    ];
    const order: FlowStep[] = ["capture", "tape", "build"];
    const currentAt = order.indexOf(this.step);
    this.stepsEl.innerHTML = "";
    steps.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = "photo-step";
      if (index < currentAt) {
        li.dataset["state"] = "done";
        li.innerHTML = "";
        const check = document.createElement("span");
        check.className = "photo-step-check";
        check.textContent = "✓";
        li.append(check, document.createTextNode(item.label));
      } else {
        li.dataset["state"] = index === currentAt ? "current" : "todo";
        li.textContent = item.label;
      }
      this.stepsEl.appendChild(li);
      if (index < steps.length - 1) {
        const arrow = document.createElement("li");
        arrow.className = "photo-step-arrow";
        arrow.textContent = "→";
        arrow.setAttribute("aria-hidden", "true");
        this.stepsEl.appendChild(arrow);
      }
    });
  }

  // ---- capture screens ----

  private stateOf(letter: WallLetter): WallState {
    const state = this.walls.get(letter);
    if (state === undefined) throw new Error(`Unknown wall ${letter}.`);
    return state;
  }

  private renderCapture(host: HTMLElement, letter: WallLetter): void {
    const state = this.stateOf(letter);
    const card = document.createElement("div");
    card.className = "photo-card";
    card.appendChild(miniPlanSvg(letter));
    const meta = document.createElement("div");
    meta.className = "photo-card-meta";
    const count = document.createElement("p");
    count.className = "photo-count";
    count.textContent = `Wall ${String(this.wallIndex + 1)} of 4`;
    const blurb = document.createElement("p");
    blurb.className = "photo-blurb";
    blurb.textContent = WALL_BLURB[letter] ?? letter;
    meta.append(count, blurb);
    card.appendChild(meta);
    host.appendChild(card);

    const framing = document.createElement("p");
    framing.className = "photo-framing";
    framing.textContent = "Get both corners and the floor line in view";
    host.appendChild(framing);
    const lens = document.createElement("p");
    lens.className = "photo-lens";
    lens.textContent = "Landscape · normal 1x camera";
    host.appendChild(lens);

    if (state.intake === null) {
      const privacy = document.createElement("p");
      privacy.className = "photo-privacy";
      privacy.textContent =
        "Your photos are sent to Meta's AI models for analysis and may be used to improve them.";
      host.appendChild(privacy);
      if (!isLive()) {
        const demo = document.createElement("p");
        demo.className = "photo-sheet-note";
        demo.textContent = "Measuring your photos uses Live AI (it calls Meta's models).";
        host.appendChild(demo);
        const live = document.createElement("button");
        live.type = "button";
        live.className = "photo-primary";
        live.textContent = "Turn on Live AI";
        live.addEventListener("click", () => setLive(true));
        host.appendChild(live);
      }
      if (this.wallIndex === 0 && !this.anyIntake() && !this.exampleLoading) {
        const exampleHint = document.createElement("p");
        exampleHint.className = "photo-sheet-note";
        exampleHint.textContent =
          "Or try four generated photos of a 420 × 360 cm room, analysed free from the demo store.";
        const example = document.createElement("button");
        example.type = "button";
        example.className = "photo-example";
        example.textContent = this.exampleLoading ? "Loading the example…" : "Try the example room";
        example.disabled = this.exampleLoading;
        example.addEventListener("click", () => void this.tryExample());
        host.append(exampleHint, example);
      }
      host.appendChild(this.picker(letter));
      if (state.error !== null) {
        const message = document.createElement("p");
        message.className = "photo-sheet-bad";
        message.textContent = state.error;
        host.appendChild(message);
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "photo-quiet";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => {
          state.error = null;
          this.render();
        });
        host.appendChild(retry);
      }
      if (this.wallIndex > 0)
        host.appendChild(this.backButton("Back to previous wall", () => this.prevWall()));
      return;
    }
    host.appendChild(this.preview(letter, state));
    host.appendChild(this.sheet(letter, state));
  }

  private picker(letter: WallLetter): HTMLElement {
    const state = this.stateOf(letter);
    const zone = document.createElement("div");
    zone.className = "photo-drop";
    const inputId = `photo-file-${letter}`;
    const input = document.createElement("input");
    input.type = "file";
    input.id = inputId;
    input.accept = "image/*";
    input.className = "photo-file";
    if (state.reading) input.disabled = true;
    input.addEventListener("change", () => {
      if (this.stateOf(letter).reading) {
        input.value = "";
        return;
      }
      const file = input.files?.[0];
      if (file !== undefined) void this.takeFile(letter, file);
      input.value = "";
    });
    const label = document.createElement("label");
    label.className = "photo-pick";
    label.setAttribute("for", inputId);
    label.textContent = state.reading ? "Reading your photo…" : "Take or pick a photo";
    const hint = document.createElement("p");
    hint.className = "photo-drop-hint";
    hint.textContent = "Camera or library on a phone · drag and drop on a desktop";
    zone.append(input, label, hint);
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.dataset["over"] = "true";
    });
    zone.addEventListener("dragleave", () => {
      zone.dataset["over"] = "false";
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.dataset["over"] = "false";
      if (this.stateOf(letter).reading) return;
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined && file.type.startsWith("image/")) void this.takeFile(letter, file);
    });
    return zone;
  }

  private async takeFile(letter: WallLetter, file: File): Promise<void> {
    const state = this.stateOf(letter);
    if (state.reading) return;
    state.error = null;
    state.demoMiss = false;
    state.analysis = null;
    state.tap = null;
    state.doorMarked = false;
    state.example = false;
    this.exampleDisplay.delete(letter);
    this.refreshExampleMode();
    state.reading = true;
    this.render();
    try {
      const intake = await processPhotoFile(file);
      const stored: StoredPhoto = { ...intake, wall: letter, savedAt: Date.now() };
      try {
        await savePhoto(stored);
      } catch (saveError) {
        console.warn("Keeping the photo in memory: saving it failed.", saveError);
      }
      state.photo = stored;
      state.intake = intake;
    } catch (error) {
      console.error(`Reading the photo for wall ${letter} failed.`, error);
      state.error =
        error instanceof Error && error.message.includes("timed out")
          ? error.message
          : "That photo could not be read. Please try another.";
    } finally {
      state.reading = false;
    }
    // Demo mode measures nothing: explain now instead of failing later.
    if (state.intake !== null && !isLive()) {
      state.error = null;
      state.demoMiss = true;
      this.render();
      return;
    }
    this.render();
    if (state.intake !== null) void this.analyse(letter, null);
  }

  private backButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "photo-back";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private prevWall(): void {
    this.wallIndex = Math.max(0, this.wallIndex - 1);
    this.render();
  }

  private preview(letter: WallLetter, state: WallState): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "photo-preview";
    const intake = state.intake;
    if (intake === null) return wrap;
    const img = document.createElement("img");
    img.className = "photo-img";
    img.src = this.exampleDisplay.get(letter) ?? intake.labelUrl;
    img.alt = state.example ? `Wall ${letter} generated example photo` : `Wall ${letter} photo`;
    if (state.example) {
      const badge = document.createElement("span");
      badge.className = "photo-example-badge";
      badge.textContent = exampleBadge(letter);
      wrap.appendChild(badge);
    }
    if (state.tapping) {
      img.classList.add("tapping");
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute(
        "aria-label",
        `Wall ${letter} photo: arrow keys move the door marker, Enter sets it`,
      );
      img.addEventListener("click", (event) => this.tapPhoto(letter, event, img));
      img.addEventListener("keydown", (event) => {
        const tapState = this.stateOf(letter);
        const current = tapState.tap ?? {
          x: Math.round(intake.segWidth / 2),
          y: Math.round(intake.segHeight / 2),
        };
        const step = event.shiftKey ? 50 : 10;
        let next: { x: number; y: number };
        if (event.key === "ArrowLeft") next = { x: current.x - step, y: current.y };
        else if (event.key === "ArrowRight") next = { x: current.x + step, y: current.y };
        else if (event.key === "ArrowUp") next = { x: current.x, y: current.y - step };
        else if (event.key === "ArrowDown") next = { x: current.x, y: current.y + step };
        else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          tapState.tapping = false;
          void this.analyse(letter, this.tapFor(letter));
          return;
        } else return;
        event.preventDefault();
        tapState.tap = {
          x: Math.min(Math.max(0, Math.round(next.x)), Math.max(1, intake.segWidth - 1)),
          y: Math.min(Math.max(0, Math.round(next.y)), Math.max(1, intake.segHeight - 1)),
        };
        this.render();
        const again = this.body.querySelector(".photo-img") as HTMLElement | null;
        again?.focus();
      });
    }
    wrap.appendChild(img);
    const overlay = document.createElement("div");
    overlay.className = "photo-dots";
    const solution = state.analysis?.solution;
    if (solution !== undefined && state.demoMiss === false) {
      for (const key of ["m1", "m2", "m3", "m4"] as const) {
        const [x, y] = solution.corners[key];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const dot = document.createElement("span");
        dot.className = "photo-dot";
        dot.style.left = `${String((x / intake.segWidth) * 100)}%`;
        dot.style.top = `${String((y / intake.segHeight) * 100)}%`;
        overlay.appendChild(dot);
      }
    }
    if (state.tap !== null) {
      const marker = document.createElement("span");
      marker.className = "photo-tap";
      marker.style.left = `${String((state.tap.x / intake.segWidth) * 100)}%`;
      marker.style.top = `${String((state.tap.y / intake.segHeight) * 100)}%`;
      overlay.appendChild(marker);
    }
    wrap.appendChild(overlay);
    if (state.analysing) {
      const progress = document.createElement("div");
      progress.className = "photo-progress";
      const bar = document.createElement("div");
      bar.className = "photo-progress-bar";
      const total = Math.max(1, state.progress.total);
      bar.style.width = `${String(Math.round((state.progress.done / total) * 100))}%`;
      const text = document.createElement("p");
      text.className = "photo-progress-text";
      text.textContent = `Analysing wall ${letter}: ${String(state.progress.done)} of ${String(state.progress.total)}`;
      progress.append(bar, text);
      wrap.appendChild(progress);
    }
    return wrap;
  }

  private sheet(letter: WallLetter, state: WallState): HTMLElement {
    const sheet = document.createElement("div");
    sheet.className = "photo-sheet";
    if (state.analysing) {
      const waiting = document.createElement("p");
      waiting.className = "photo-sheet-note";
      waiting.textContent = "Analysing your photo…";
      sheet.appendChild(waiting);
      return sheet;
    }
    if (state.error !== null) {
      const message = document.createElement("p");
      message.className = "photo-sheet-bad";
      message.textContent = state.error;
      // An empty wall/floor answer says what to retake: no "Try again"
      // (it would send the same request for the same answer). Time-outs,
      // network errors and caps keep it.
      if (errorRecovery(state.error) === "retake") {
        const retake = document.createElement("button");
        retake.type = "button";
        retake.className = "photo-primary";
        retake.textContent = "Retake";
        retake.addEventListener("click", () => void this.retake(letter));
        sheet.append(message, retake);
      } else {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "photo-primary";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => void this.analyse(letter, this.tapFor(letter)));
        const retake = document.createElement("button");
        retake.type = "button";
        retake.className = "photo-quiet";
        retake.textContent = "Retake";
        retake.addEventListener("click", () => void this.retake(letter));
        sheet.append(message, retry, retake);
      }
      return sheet;
    }
    if (state.demoMiss) {
      const message = document.createElement("p");
      message.className = "photo-sheet-note";
      message.textContent = "Measuring your photos uses Live AI (it calls Meta's models).";
      const live = document.createElement("button");
      live.type = "button";
      live.className = "photo-primary";
      live.textContent = "Turn on Live AI";
      live.addEventListener("click", () => {
        setLive(true);
        void this.analyse(letter, this.tapFor(letter));
      });
      sheet.append(message, live);
      return sheet;
    }
    const analysis = state.analysis;
    if (analysis === null) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "photo-primary";
      start.textContent = "Analyse this photo";
      start.addEventListener("click", () => void this.analyse(letter, this.tapFor(letter)));
      sheet.appendChild(start);
      return sheet;
    }
    const solution = analysis.solution;
    const bothRaw = cornersFound(
      solution,
      state.intake?.segWidth ?? 0,
      state.intake?.segHeight ?? 0,
    );
    const floor = floorLineFound(solution);
    const tilt = tiltDeg(solution);
    const twoWalls = analysis.draft.flags.some(
      (flag) =>
        flag.code === "two-walls-in-view" && (flag.wall === letter || flag.wall === undefined),
    );
    const edgeAtDoor = analysis.draft.flags.some(
      (flag) => flag.code === "edge-at-door" && (flag.wall === letter || flag.wall === undefined),
    );
    const both = bothCornersOk(bothRaw, twoWalls);
    if (twoWalls) {
      sheet.appendChild(this.checkRow(false, "Both corners found", TWO_WALLS_COPY));
    } else {
      sheet.appendChild(
        this.checkRow(both, "Both corners found", "Both corners missing — step back and retake"),
      );
    }
    sheet.appendChild(
      this.checkRow(floor, "Floor line found", "Floor line hidden — clear the view and retake"),
    );
    if (edgeAtDoor) sheet.appendChild(this.checkRow(null, EDGE_AT_DOOR_COPY));
    if (tilt > TILT_AMBER_DEG) sheet.appendChild(this.checkRow(null, "Hold the phone level"));
    const tapFlag =
      analysis.draft.flags.some((flag) => flag.code === "tap-the-door" && flag.wall === letter) &&
      state.doorMarked === false;
    if (tapFlag && state.tapping === false) {
      const tapRow = document.createElement("div");
      tapRow.className = "photo-tap-row";
      const ask = document.createElement("p");
      ask.className = "photo-sheet-note";
      ask.textContent = "A door is visible but no opening was found.";
      const tapButton = document.createElement("button");
      tapButton.type = "button";
      tapButton.className = "photo-quiet";
      tapButton.textContent = "Tap the door";
      tapButton.addEventListener("click", () => {
        state.tapping = true;
        this.render();
      });
      tapRow.append(ask, tapButton);
      sheet.appendChild(tapRow);
    }
    if (state.tapping) {
      const ask = document.createElement("p");
      ask.className = "photo-sheet-note";
      ask.textContent = "Tap the door in the photo above.";
      const actions = document.createElement("div");
      actions.className = "photo-row";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "photo-quiet";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        state.tapping = false;
        state.tap = null;
        this.render();
      });
      const use = document.createElement("button");
      use.type = "button";
      use.className = "photo-primary";
      use.textContent = "Analyse with this point";
      use.disabled = state.tap === null;
      use.addEventListener("click", () => {
        state.tapping = false;
        void this.analyse(letter, this.tapFor(letter));
      });
      actions.append(cancel, use);
      sheet.append(ask, actions);
    }
    if (state.doorMarked) {
      sheet.appendChild(this.checkRow(true, "Door marked"));
    }
    const actions = document.createElement("div");
    actions.className = "photo-row";
    // Any ✕ makes "Retake" the primary button and "Next wall" secondary;
    // with every check passing "Next wall" stays primary.
    const failed = !nextIsPrimary({ bothCornersFound: both, floorLineFound: floor });
    const retake = document.createElement("button");
    retake.type = "button";
    retake.className = failed ? "photo-primary" : "photo-quiet";
    retake.textContent = "Retake";
    retake.addEventListener("click", () => void this.retake(letter));
    const next = document.createElement("button");
    next.type = "button";
    next.className = failed ? "photo-quiet" : "photo-primary";
    next.textContent = letter === "D" ? "Continue to tape" : "Next wall";
    next.addEventListener("click", () => this.next(letter));
    actions.append(retake, next);
    sheet.appendChild(actions);
    if (this.wallIndex > 0)
      sheet.appendChild(this.backButton("Back to previous wall", () => this.prevWall()));
    return sheet;
  }

  private checkRow(ok: boolean | null, good: string, bad?: string): HTMLElement {
    const row = document.createElement("p");
    if (ok === true) {
      row.className = "photo-check-good";
      row.textContent = `✓ ${good}`;
    } else if (ok === null) {
      row.className = "photo-check-amber";
      row.textContent = `! ${good}`;
    } else {
      row.className = "photo-check-bad";
      row.textContent = `✕ ${bad ?? good}`;
    }
    return row;
  }

  private tapFor(letter: WallLetter): DoorTap | null {
    const tap = this.stateOf(letter).tap;
    if (tap === null) return null;
    return { wall: letter, x: tap.x, y: tap.y };
  }

  private tapPhoto(letter: WallLetter, event: MouseEvent, img: HTMLImageElement): void {
    const state = this.stateOf(letter);
    const intake = state.intake;
    if (intake === null) return;
    const rect = img.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    state.tap = {
      x: Math.round(fx * intake.segWidth),
      y: Math.round(fy * intake.segHeight),
    };
    this.render();
  }

  private async retake(letter: WallLetter): Promise<void> {
    try {
      await clearPhoto(letter);
    } catch (error) {
      console.error(`Discarding the photo for wall ${letter} failed.`, error);
    }
    this.walls.set(letter, emptyWallState());
    this.exampleDisplay.delete(letter);
    this.refreshExampleMode();
    this.render();
  }

  private next(letter: WallLetter): void {
    if (letter === "D") {
      this.step = "tape";
      this.render();
      return;
    }
    this.wallIndex = Math.min(WALL_ORDER.length - 1, this.wallIndex + 1);
    this.render();
  }

  private async analyse(letter: WallLetter, doorTap: DoorTap | null): Promise<void> {
    const state = this.stateOf(letter);
    const intake = state.intake;
    if (intake === null || state.analysing) return;
    state.analysing = true;
    state.error = null;
    state.demoMiss = false;
    state.progress = { done: 0, total: 5 };
    this.render();
    try {
      const result = await analyseWallPhoto(
        letter,
        intake.segUrl,
        intake.segWidth,
        intake.segHeight,
        intake.focal35mm,
        doorTap,
        (done, total) => {
          state.progress = { done, total };
          this.renderProgress(letter, done, total);
        },
      );
      if ("demoMiss" in result) {
        state.demoMiss = true;
        state.analysis = null;
      } else {
        state.analysis = result;
        state.instances = result.instances;
        state.demoMiss = false;
        if (doorTap !== null) {
          state.doorMarked = result.draft.openings.some(
            (opening) => opening.type === "door" && opening.wall === letter,
          );
        }
      }
    } catch (error) {
      console.error(`Analysing the photo for wall ${letter} failed.`, error);
      state.error = error instanceof Error ? error.message : "The room scanner failed just now.";
    } finally {
      state.analysing = false;
      this.render();
    }
  }

  private renderProgress(letter: WallLetter, done: number, total: number): void {
    if (this.step !== "capture" || this.currentLetter() !== letter) return;
    const bar = this.body.querySelector(".photo-progress-bar");
    if (bar instanceof HTMLElement)
      bar.style.width = `${String(Math.round((done / Math.max(1, total)) * 100))}%`;
    const text = this.body.querySelector(".photo-progress-text");
    if (text !== null)
      text.textContent = `Analysing wall ${letter}: ${String(done)} of ${String(total)}`;
  }

  // ---- tape step ----

  private renderTape(host: HTMLElement): void {
    const title = document.createElement("h2");
    title.className = "photo-title";
    title.textContent = "Two tape values";
    host.appendChild(title);
    host.appendChild(this.tapeDrawing());
    const note = document.createElement("p");
    note.className = "photo-note";
    note.textContent =
      "Measure at floor level, corner to corner. Leave one empty to estimate it from the photos.";
    host.appendChild(note);
    if (this.exampleMode) {
      const exampleNote = document.createElement("p");
      exampleNote.className = "photo-example-note";
      exampleNote.textContent = EXAMPLE_TAPE_NOTE;
      host.appendChild(exampleNote);
    }
    const form = document.createElement("div");
    form.className = "photo-tape-form";
    form.appendChild(
      this.tapeField("Wall A length (cm)", this.tapeA, (value) => {
        this.tapeA = value;
      }),
    );
    form.appendChild(
      this.tapeField("Wall B length (cm)", this.tapeB, (value) => {
        this.tapeB = value;
      }),
    );
    host.appendChild(form);
    if (this.tapeError !== null) {
      const error = document.createElement("p");
      error.className = "photo-sheet-bad";
      error.textContent = this.tapeError;
      host.appendChild(error);
    }
    const actions = document.createElement("div");
    actions.className = "photo-row";
    actions.appendChild(
      this.backButton("Back to photos", () => {
        this.step = "capture";
        this.wallIndex = WALL_ORDER.length - 1;
        this.render();
      }),
    );
    const build = document.createElement("button");
    build.type = "button";
    build.className = "photo-primary";
    build.textContent = "Build room";
    build.addEventListener("click", () => void this.build());
    actions.appendChild(build);
    host.appendChild(actions);
  }

  private tapeField(label: string, value: string, onInput: (value: string) => void): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "photo-tape-field";
    const icon = tapeIcon();
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "50";
    input.max = "2000";
    input.step = "1";
    input.inputMode = "numeric";
    input.value = value;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(input.value));
    wrap.append(icon, text, input);
    return wrap;
  }

  /** Which wall, at floor level, corner to corner: A along the bottom, B up the side. */
  private tapeDrawing(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 200 130");
    svg.setAttribute("class", "photo-tape-drawing");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Measure wall A along the bottom and wall B up the side, at floor level",
    );
    const floor = document.createElementNS(NS, "rect");
    floor.setAttribute("x", "50");
    floor.setAttribute("y", "20");
    floor.setAttribute("width", "110");
    floor.setAttribute("height", "70");
    floor.setAttribute("class", "photo-tape-room");
    svg.appendChild(floor);
    const lineA1 = document.createElementNS(NS, "line");
    lineA1.setAttribute("x1", "50");
    lineA1.setAttribute("y1", "104");
    lineA1.setAttribute("x2", "160");
    lineA1.setAttribute("y2", "104");
    lineA1.setAttribute("class", "photo-tape-line");
    const labelA = document.createElementNS(NS, "text");
    labelA.setAttribute("x", "105");
    labelA.setAttribute("y", "120");
    labelA.setAttribute("text-anchor", "middle");
    labelA.setAttribute("class", "photo-tape-label");
    labelA.textContent = "A · corner to corner";
    const lineB1 = document.createElementNS(NS, "line");
    lineB1.setAttribute("x1", "36");
    lineB1.setAttribute("y1", "90");
    lineB1.setAttribute("x2", "36");
    lineB1.setAttribute("y2", "20");
    lineB1.setAttribute("class", "photo-tape-line");
    const labelB = document.createElementNS(NS, "text");
    labelB.setAttribute("x", "28");
    labelB.setAttribute("y", "58");
    labelB.setAttribute("text-anchor", "middle");
    labelB.setAttribute("class", "photo-tape-label");
    labelB.setAttribute("transform", "rotate(-90 28 58)");
    labelB.textContent = "B · corner to corner";
    svg.append(lineA1, labelA, lineB1, labelB);
    return svg;
  }

  private parseTape(raw: string): number | null {
    if (raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 50 || value > 2000) return null;
    return Math.round(value);
  }

  // ---- build step ----

  private renderBuild(host: HTMLElement): void {
    const title = document.createElement("h2");
    title.className = "photo-title";
    title.textContent = "Build room";
    host.appendChild(title);
    const message = document.createElement("p");
    message.className = "photo-note";
    message.textContent = this.buildError ?? this.buildMessage;
    if (this.buildError !== null) message.classList.add("photo-sheet-bad");
    host.appendChild(message);
    if (this.buildError !== null) {
      const actions = document.createElement("div");
      actions.className = "photo-row";
      actions.appendChild(
        this.backButton("Back to tape values", () => {
          this.step = "tape";
          this.buildError = null;
          this.render();
        }),
      );
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "photo-primary";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => void this.build());
      actions.appendChild(retry);
      host.appendChild(actions);
    }
  }

  private collectPhotos(): PhotoInput[] | null {
    const photos: PhotoInput[] = [];
    for (const letter of WALL_ORDER) {
      const state = this.stateOf(letter);
      const intake = state.intake;
      if (intake === null || state.analysis === null) return null;
      photos.push({
        wall: letter,
        width: intake.segWidth,
        height: intake.segHeight,
        focal35mm: intake.focal35mm,
        instances: state.instances,
      });
    }
    return photos;
  }

  /** A tap for the final solve: wall A wins, else the first tapped wall. */
  private finalTap(): DoorTap | undefined {
    const tapA = this.tapFor("A");
    if (tapA !== null) return tapA;
    for (const letter of WALL_ORDER) {
      const tap = this.tapFor(letter);
      if (tap !== null) return tap;
    }
    return undefined;
  }

  /**
   * Estimate a missing tape from the other tape via the solved width/height
   * ratios (both walls share one ceiling height, so lengths scale as the
   * ratios). Returns the estimate with its ±.
   */
  private estimateMissingTape(
    solutions: PhotoSolution[],
    known: number,
    missingLetter: WallLetter,
    knownLetter: WallLetter,
  ): { value: number; plusMinus: number } {
    const missing = solutions.find((solution) => solution.wall === missingLetter);
    const knownSol = solutions.find((solution) => solution.wall === knownLetter);
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
      return { value: known, plusMinus: 15 };
    }
    const value = Math.max(50, Math.min(2000, Math.round((known * ratioM) / ratioK)));
    const rel =
      Math.abs(missing.ratioPlusMinus / ratioM) + Math.abs(knownSol.ratioPlusMinus / ratioK);
    return { value, plusMinus: Math.max(4, Math.round(value * rel + 2)) };
  }

  private async build(): Promise<void> {
    const photos = this.collectPhotos();
    if (photos === null) {
      this.tapeError = "Every wall still needs its analysed photo.";
      this.step = "capture";
      this.render();
      return;
    }
    const tapeA = this.parseTape(this.tapeA);
    const tapeB = this.parseTape(this.tapeB);
    if (tapeA === null && tapeB === null) {
      this.tapeError = "Type at least one wall length (A or B).";
      this.render();
      return;
    }
    this.tapeError = null;
    this.buildError = null;
    this.step = "build";
    this.buildMessage = "Solving your room…";
    this.render();
    try {
      // First pass with placeholders where a tape is missing, so the width
      // ratios can estimate it; the final pass solves with real tapes.
      const first = solveRoomFromPhotos({
        photos,
        tapeA: tapeA ?? tapeB ?? 400,
        tapeB: tapeB ?? tapeA ?? 350,
        ...(this.finalTap() === undefined ? {} : { doorTap: this.finalTap() }),
      });
      const estimated: Partial<Record<WallLetter, number>> = {};
      let finalA = tapeA ?? 0;
      let finalB = tapeB ?? 0;
      if (tapeA === null && tapeB !== null) {
        const est = this.estimateMissingTape(first.photos, tapeB, "A", "B");
        finalA = est.value;
        estimated["A"] = est.plusMinus;
        estimated["C"] = est.plusMinus;
      }
      if (tapeB === null && tapeA !== null) {
        const est = this.estimateMissingTape(first.photos, tapeA, "B", "A");
        finalB = est.value;
        estimated["B"] = est.plusMinus;
        estimated["D"] = est.plusMinus;
      }
      if (tapeA !== null) finalA = tapeA;
      if (tapeB !== null) finalB = tapeB;
      this.buildMessage = "Labelling your room…";
      this.render();
      // The label never blocks: on failure the defaults stand in.
      const labelPromise = this.labelPhotos().catch((error: unknown) => {
        console.error("Labelling the room failed; using defaults.", error);
        return defaultRoomLabel(["A", "B", "C", "D"]);
      });
      const draft = solveRoomFromPhotos({
        photos,
        tapeA: finalA,
        tapeB: finalB,
        ...(this.finalTap() === undefined ? {} : { doorTap: this.finalTap() }),
      });
      if (this.exampleMode) draft.layout.name = EXAMPLE_ROOM_NAME;
      const label = await labelPromise;
      this.applyLabel(draft, label);
      this.buildMessage = "Opening the plan editor…";
      this.render();
      this.callbacks.onDone({ draft, meta: draftMeta(draft, estimated) });
    } catch (error) {
      console.error("Building the room failed.", error);
      this.buildError = error instanceof Error ? error.message : "Solving failed just now.";
      this.render();
    }
  }

  private async labelPhotos(): Promise<RoomLabelAnswer> {
    const labelPhotos: Array<{ wall: string; image: string }> = [];
    for (const letter of WALL_ORDER) {
      const intake = this.stateOf(letter).intake;
      if (intake === null) continue;
      labelPhotos.push({ wall: letter, image: intake.labelUrl });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof postLabel>>;
    try {
      result = await postLabel({ photos: labelPhotos }, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (result.status !== "ok") return defaultRoomLabel(["A", "B", "C", "D"]);
    const data = result.data as RoomLabelAnswer;
    if (typeof data !== "object" || data === null || !Array.isArray(data.photos)) {
      return defaultRoomLabel(["A", "B", "C", "D"]);
    }
    return data;
  }

  /** Per-photo surface colours kept with each analysed wall. */
  private surfaceColors(): { wallTints: Array<string | null>; floorColors: Array<string | null> } {
    const wallTints: Array<string | null> = [];
    const floorColors: Array<string | null> = [];
    for (const letter of WALL_ORDER) {
      const analysis = this.stateOf(letter).analysis;
      wallTints.push(analysis?.wallTint ?? null);
      floorColors.push(analysis?.floorColor ?? null);
    }
    return { wallTints, floorColors };
  }

  private applyLabel(draft: RoomDraft, label: RoomLabelAnswer): void {
    draft.layout.style = {
      tags: [...label.style.tags],
      dominantColors: [...label.style.dominantColors],
    };
    // Finishes from the label + the mask medians: the floor family picks an
    // on-disk texture (wood closest by floor colour), the wall family picks
    // paint or wallpaper, and the per-photo wall medians blend into one tint.
    const { wallTints, floorColors } = this.surfaceColors();
    const floorMedian = blendWallTints(floorColors);
    draft.layout.surfaces = {
      floor: pickFloorTexture(label.floor.family, floorMedian),
      wall: pickWallTexture(label.walls.family),
      ...(blendWallTints(wallTints) === null
        ? {}
        : { wallTint: blendWallTints(wallTints) as string }),
    };
  }
}
