/**
 * Photoreal visualisation viewer: before/after slider (capture vs result),
 * download, the "AI visualisation by Muse Image" label, and a progress
 * indicator with elapsed seconds. One request at a time per viewer; guest
 * answers (demo-miss, capped, error) render as their message in the viewer.
 */

import { buildRenderPrompt } from "@fitroom/shared";
import type { CatalogItem, RenderWallView, RoomLayout, SceneState } from "@fitroom/shared";
import { isLive, postRender, setLive } from "../api";
import { captureView } from "./capture";

export interface RenderViewerDeps {
  room: RoomLayout;
  catalog: CatalogItem[];
  getScene: () => SceneState;
  getCapture: () => { dataUrl: string; base64: string; width: number; height: number };
  cameraPreset: () => string;
  wallView: () => RenderWallView | undefined;
  /** Load the demo room as one undo step. */
  resetDemoRoom: () => void;
}

const MODEL_LABEL = "AI visualisation by Muse Image";

function messageFor(result: { status: string; message?: string }): string {
  if (result.status === "demo-miss" || result.status === "capped") {
    return (result as { message: string }).message;
  }
  if (result.status === "error") return (result as { message: string }).message;
  if (result.status === "not-ready") {
    return "The visualiser isn't ready yet. Turn on Live AI or reset to the demo room.";
  }
  return "The visualiser couldn't make an image just now. Please try again.";
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
  }

  get isBusy(): boolean {
    return this.busy;
  }

  open(): void {
    this.root.removeAttribute("hidden");
  }

  close(): void {
    this.root.setAttribute("hidden", "");
  }

  /** One click: capture, prompt, send, show. Ignored while busy. */
  async visualise(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.open();
    let capture: { dataUrl: string; base64: string; width: number; height: number };
    try {
      capture = this.deps.getCapture();
    } catch {
      this.busy = false;
      this.showNotice("The visualiser couldn't capture the view. Please try again.");
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
      result = { status: "error", message: "The AI service is unreachable." };
    }
    this.stopProgress();
    this.busy = false;
    if (result.status === "ok") {
      this.showAnswer(capture.dataUrl, result.data, capture.width, capture.height);
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
    close.title = "Close visualisation";
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
    status.textContent = "Visualising… 0s";
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
      status.textContent = `Visualising… ${String(secs)}s`;
    }, 500);
  }

  /**
   * Demo miss: the message plus a way out in the same card — reset the demo
   * room (one undo step) and, where it applies, Live AI. No "Try again"
   * that would repeat the same miss.
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
    close.title = "Close visualisation";
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
    reset.textContent = "Reset demo room";
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "render-quiet";
      live.textContent = "Turn on Live AI";
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
    close.title = "Close visualisation";
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
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void this.visualise());
    wrap.appendChild(retry);
    const model = document.createElement("p");
    model.className = "render-model";
    model.textContent = MODEL_LABEL;
    wrap.appendChild(model);
    this.root.appendChild(wrap);
  }

  private showAnswer(captureUrl: string, data: unknown, width: number, height: number): void {
    this.clearTimer();
    this.root.innerHTML = "";
    const record =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const imageBase64 = typeof record["imageBase64"] === "string" ? record["imageBase64"] : null;
    if (imageBase64 === null || imageBase64 === "") {
      this.showNotice("The visualiser couldn't make an image just now. Please try again.");
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
    close.title = "Close visualisation";
    close.addEventListener("click", () => this.close());
    const head = document.createElement("div");
    head.className = "render-head";
    head.append(title, close);
    wrap.appendChild(head);

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
