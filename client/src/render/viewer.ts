/**
 * Photoreal visualisation viewer: before/after slider (capture vs result),
 * download, the "AI visualisation by Muse Image" label, and a progress
 * indicator with elapsed seconds. One request at a time per viewer; guest
 * answers (demo-miss, capped, error) render as their message in the viewer.
 */

import { buildRenderPrompt } from "@fitroom/shared";
import type { CatalogItem, RenderWallView, RoomLayout, SceneState } from "@fitroom/shared";
import { LIVE_CHANGE_EVENT, isLive, postRender, setLive } from "../api";
import { captureView } from "./capture";
import {
  AI_UNREACHABLE,
  NOT_READY_MESSAGE,
  RENDER_CAPTURE_FAILED,
  RENDER_FAILED,
  RENDER_HIDE,
  RENDER_STILL_BUSY,
  RETRY,
  TURN_ON_LIVE,
  USE_SAMPLE_ROOM,
  VISUALISING_PREFIX,
} from "../copy";

export interface RenderViewerDeps {
  room: RoomLayout;
  catalog: CatalogItem[];
  getScene: () => SceneState;
  getCapture: () => { dataUrl: string; base64: string; width: number; height: number };
  cameraPreset: () => string;
  wallView: () => RenderWallView | undefined;
  /** Load the demo room as one undo step. */
  resetDemoRoom: () => void;
  /**
   * Move the camera back to the recorded view when it wandered (after an
   * orbit in the sample room). Returns true when it moved, so the viewer
   * can name the recorded view it renders.
   */
  resetToRecordedView?: () => boolean;
}

/** One line naming the recorded view an orbited sample room renders. */
export const RECORDED_VIEW_LINE = "Showing the recorded view";

const MODEL_LABEL = "AI visualisation by Muse Image";

function messageFor(result: { status: string; message?: string }): string {
  if (result.status === "demo-miss" || result.status === "capped") {
    return (result as { message: string }).message;
  }
  if (result.status === "error") return (result as { message: string }).message;
  if (result.status === "not-ready") {
    return NOT_READY_MESSAGE;
  }
  return RENDER_FAILED;
}

export class RenderViewer {
  private readonly deps: RenderViewerDeps;
  private readonly root: HTMLElement;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(host: HTMLElement, deps: RenderViewerDeps) {
    this.deps = deps;
    this.root = host;
    this.root.classList.add("render-viewer");
    this.root.setAttribute("hidden", "");
    window.addEventListener(LIVE_CHANGE_EVENT, () => this.syncMode());
  }

  /** Redraw the demo-miss card's Live AI button for the current mode. */
  syncMode(): void {
    const live = isLive();
    for (const b of this.root.querySelectorAll("button.render-quiet")) {
      if (!(b instanceof HTMLButtonElement)) continue;
      if (b.textContent !== TURN_ON_LIVE) continue;
      b.toggleAttribute("hidden", live);
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  open(): void {
    this.root.removeAttribute("hidden");
    if (this.busy) this.showStillBusy();
  }

  close(): void {
    this.root.setAttribute("hidden", "");
  }

  /** One click: capture, prompt, send, show. Reopens while busy. */
  async visualise(): Promise<void> {
    if (this.busy) {
      this.open();
      return;
    }
    this.busy = true;
    this.open();
    // After an orbit the sample room renders its recorded view: move the
    // camera back first so the capture matches the stored visualisation.
    let recordedView = false;
    try {
      if (this.deps.resetToRecordedView?.() === true) recordedView = true;
    } catch {
      // Keep rendering the live view.
    }
    let capture: { dataUrl: string; base64: string; width: number; height: number };
    try {
      capture = this.deps.getCapture();
    } catch {
      this.busy = false;
      this.showNotice(RENDER_CAPTURE_FAILED);
      return;
    }
    const scene = this.deps.getScene();
    const prompt = buildRenderPrompt(
      scene,
      this.deps.room,
      this.deps.catalog,
      this.deps.wallView(),
    );
    this.showProgress(capture);
    let result: Awaited<ReturnType<typeof postRender>>;
    try {
      result = await postRender({
        prompt,
        scene: JSON.parse(JSON.stringify(scene)) as SceneState,
        referenceImage: capture.base64,
        cameraPreset: this.deps.cameraPreset(),
        ...(isLive() ? { live: true } : {}),
      });
    } catch {
      result = { status: "error", message: AI_UNREACHABLE };
    }
    this.stopProgress();
    this.busy = false;
    if (result.status === "ok") {
      this.showAnswer(capture.dataUrl, result.data, capture.width, capture.height, recordedView);
    } else if (result.status === "demo-miss" || result.status === "capped") {
      this.showDemoMiss(messageFor(result));
    } else {
      this.showNotice(messageFor(result));
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stopProgress(): void {
    this.clearTimer();
  }

  private showStillBusy(): void {
    if (this.root.querySelector("[data-still-busy]") !== null) return;
    const card = this.root.querySelector(".render-card");
    if (card === null) return;
    const note = document.createElement("p");
    note.className = "render-still";
    note.dataset["stillBusy"] = "true";
    note.textContent = RENDER_STILL_BUSY;
    card.appendChild(note);
  }

  private showProgress(capture: { dataUrl: string; width: number; height: number }): void {
    this.clearTimer();
    this.root.innerHTML = "";
    this.startedAt = Date.now();
    const wrap = document.createElement("div");
    wrap.className = "render-card";
    const title = document.createElement("h2");
    title.textContent = "Visualise";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "render-close";
    close.textContent = "×";
    close.setAttribute("aria-label", RENDER_HIDE);
    close.title = RENDER_HIDE;
    close.addEventListener("click", () => this.close());
    const head = document.createElement("div");
    head.className = "render-head";
    head.append(title, close);
    wrap.appendChild(head);
    const thumb = document.createElement("img");
    thumb.className = "render-progress-thumb";
    thumb.src = capture.dataUrl;
    thumb.alt = "Current 3D view";
    thumb.style.aspectRatio = `${String(capture.width)} / ${String(capture.height)}`;
    wrap.appendChild(thumb);
    const status = document.createElement("p");
    status.className = "render-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = `${VISUALISING_PREFIX} 0s`;
    wrap.appendChild(status);
    const bar = document.createElement("div");
    bar.className = "render-progress";
    const fill = document.createElement("div");
    fill.className = "render-progress-fill";
    bar.appendChild(fill);
    wrap.appendChild(bar);
    const model = document.createElement("p");
    model.className = "render-model";
    model.textContent = MODEL_LABEL;
    wrap.appendChild(model);
    this.root.appendChild(wrap);
    this.timer = setInterval(() => {
      const secs = Math.floor((Date.now() - this.startedAt) / 1000);
      status.textContent = `${VISUALISING_PREFIX} ${String(secs)}s`;
    }, 500);
  }

  /**
   * Demo miss: the message plus a way out in the same card — use the
   * sample room (one undo step) and, where it applies, Live AI. No "Try
   * again" that would repeat the same miss.
   */
  private showDemoMiss(message: string): void {
    this.clearTimer();
    this.root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "render-card";
    const title = document.createElement("h2");
    title.textContent = "Visualise";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "render-close";
    close.textContent = "×";
    close.setAttribute("aria-label", RENDER_HIDE);
    close.title = RENDER_HIDE;
    close.addEventListener("click", () => this.close());
    const head = document.createElement("div");
    head.className = "render-head";
    head.append(title, close);
    wrap.appendChild(head);
    const note = document.createElement("p");
    note.className = "render-empty";
    note.textContent = message;
    wrap.appendChild(note);
    const row = document.createElement("div");
    row.className = "render-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "render-go";
    reset.textContent = USE_SAMPLE_ROOM;
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "render-quiet";
      live.textContent = TURN_ON_LIVE;
      live.addEventListener("click", () => setLive(true));
      row.appendChild(live);
    }
    wrap.appendChild(row);
    const model = document.createElement("p");
    model.className = "render-model";
    model.textContent = MODEL_LABEL;
    wrap.appendChild(model);
    this.root.appendChild(wrap);
  }

  private showNotice(message: string): void {
    this.clearTimer();
    this.root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "render-card";
    const title = document.createElement("h2");
    title.textContent = "Visualise";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "render-close";
    close.textContent = "×";
    close.setAttribute("aria-label", RENDER_HIDE);
    close.title = RENDER_HIDE;
    close.addEventListener("click", () => this.close());
    const head = document.createElement("div");
    head.className = "render-head";
    head.append(title, close);
    wrap.appendChild(head);
    const note = document.createElement("p");
    note.className = "render-empty";
    note.textContent = message;
    wrap.appendChild(note);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "render-go";
    retry.textContent = RETRY;
    retry.addEventListener("click", () => void this.visualise());
    wrap.appendChild(retry);
    const model = document.createElement("p");
    model.className = "render-model";
    model.textContent = MODEL_LABEL;
    wrap.appendChild(model);
    this.root.appendChild(wrap);
  }

  private showAnswer(
    captureUrl: string,
    data: unknown,
    width: number,
    height: number,
    recordedView = false,
  ): void {
    this.clearTimer();
    this.root.innerHTML = "";
    const record =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const imageBase64 = typeof record["imageBase64"] === "string" ? record["imageBase64"] : null;
    if (imageBase64 === null || imageBase64 === "") {
      this.showNotice(RENDER_FAILED);
      return;
    }
    const resultUrl = `data:image/webp;base64,${imageBase64}`;
    const wrap = document.createElement("div");
    wrap.className = "render-card";
    const title = document.createElement("h2");
    title.textContent = "Visualise";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "render-close";
    close.textContent = "×";
    close.setAttribute("aria-label", RENDER_HIDE);
    close.title = RENDER_HIDE;
    close.addEventListener("click", () => this.close());
    const head = document.createElement("div");
    head.className = "render-head";
    head.append(title, close);
    wrap.appendChild(head);
    if (recordedView) {
      const recorded = document.createElement("p");
      recorded.className = "render-recorded";
      recorded.textContent = RECORDED_VIEW_LINE;
      wrap.appendChild(recorded);
    }

    const slider = document.createElement("div");
    slider.className = "render-compare";
    // Both frames share the capture's box, whole and aligned: neither image
    // is cropped (see `object-fit: contain`), so the slider wipes across the
    // same view on both sides.
    slider.style.aspectRatio = `${String(width)} / ${String(height)}`;
    const before = document.createElement("img");
    before.src = captureUrl;
    before.alt = "3D view before";
    before.className = "render-before";
    const after = document.createElement("img");
    after.src = resultUrl;
    after.alt = "Photoreal visualisation after";
    after.className = "render-after";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "50";
    range.name = "before-after";
    range.setAttribute("aria-label", "Before and after slider");
    range.className = "render-slider";
    const apply = (): void => {
      after.style.clipPath = `inset(0 0 0 ${range.value}%)`;
    };
    range.addEventListener("input", apply);
    apply();
    // The handle sits on the image itself (bottom overlay), never under it.
    slider.append(before, after, range);
    wrap.appendChild(slider);

    const row = document.createElement("div");
    row.className = "render-row";
    const download = document.createElement("a");
    download.className = "render-go";
    download.href = resultUrl;
    download.download = "fitroom-visualisation.webp";
    download.textContent = "Download";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "render-quiet";
    retry.textContent = "Render again";
    retry.addEventListener("click", () => void this.visualise());
    row.append(download, retry);
    wrap.appendChild(row);

    const model = document.createElement("p");
    model.className = "render-model";
    model.textContent = MODEL_LABEL;
    wrap.appendChild(model);
    this.root.appendChild(wrap);
  }
}

export { captureView };
