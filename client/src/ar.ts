/**
 * "See it in AR": one `<model-viewer>` per selection, only where AR can
 * open. The module itself is side-effect-free at import (no element, no
 * fetch): `ensureARViewer()` dynamically imports `@google/model-viewer`
 * (its ES build) on the first AR-capable selection, never during boot, and
 * builds the full-screen layer outside `#inspector` that the tap opens.
 *
 * One element with `ar`, `ar-modes="scene-viewer webxr quick-look"`
 * (Android phones get Scene Viewer, Quest Browser WebXR, iPhone and iPad
 * Quick Look) and `ar-scale="fixed"` (true size everywhere); `src` is the
 * selected piece's `assets/ar/<id>.glb` on our own origin. Quick Look
 * needs no file from us: model-viewer builds it from the loaded `.glb`
 * when AR starts (nothing of ours is animated).
 */

import { AR_BACK_TO_ROOM, arLayerTitle } from "./copy";

/** Relative URL of a piece's packed AR file (same origin, never another). */
export function arSrcFor(productId: string): string {
  return `assets/ar/${productId}.glb`;
}

/**
 * Sync pre-gate: a browser that may open AR. Android and iOS/iPadOS open
 * their system viewers; a Mac user agent with more than one touch point is
 * an iPad running the desktop site.
 */
export function isARCapableBrowser(): boolean {
  try {
    const nav = window.navigator;
    const ua = nav.userAgent;
    if (/android/i.test(ua)) return true;
    if (/iphone|ipad|ipod/i.test(ua)) return true;
    if (/mac/i.test(ua) && nav.maxTouchPoints > 1) return true;
  } catch {
    return false;
  }
  return false;
}

interface XRNavigator {
  xr?: {
    isSessionSupported?: (mode: string) => Promise<boolean>;
  };
}

/**
 * Async gate: the UA pre-gate above, or a browser where WebXR
 * `immersive-ar` resolves supported (Quest Browser).
 */
export async function mayOpenAR(): Promise<boolean> {
  if (isARCapableBrowser()) return true;
  try {
    const xr = (window.navigator as unknown as XRNavigator).xr;
    if (xr?.isSessionSupported !== undefined) {
      return await xr.isSessionSupported("immersive-ar");
    }
  } catch {
    // No WebXR: not an AR browser.
  }
  return false;
}

/** The slice of the element API the app uses (no static package import). */
export interface ARViewerElement extends HTMLElement {
  src: string;
  canActivateAR: boolean;
  activateAR: () => Promise<void>;
  updateComplete?: Promise<unknown>;
}

let loadPromise: Promise<void> | null = null;
let layerHost: HTMLElement | null = null;
let layerName: HTMLElement | null = null;
let viewer: ARViewerElement | null = null;

/** Hide the AR layer wherever it is open (Back, status, return). */
export function hideARLayer(): void {
  layerHost?.setAttribute("hidden", "");
}

/** Show the AR layer the tap opens (WebXR presents inside it). */
export function showARLayer(): void {
  layerHost?.removeAttribute("hidden");
}

/** True while the AR layer is open. */
export function isARLayerOpen(): boolean {
  return layerHost !== null && !layerHost.hasAttribute("hidden");
}

/**
 * Load the element (once) and build its layer (once). Returns null when
 * the import fails: the Inspector then shows no button.
 */
export async function ensureARViewer(): Promise<ARViewerElement | null> {
  if (viewer !== null) return viewer;
  try {
    if (loadPromise === null) {
      loadPromise = import("@google/model-viewer").then(() => undefined);
    }
    await loadPromise;
  } catch {
    return null;
  }
  try {
    const host = document.createElement("div");
    host.id = "ar-layer";
    host.className = "ar-layer";
    host.setAttribute("hidden", "");
    const name = document.createElement("h2");
    name.className = "ar-layer-name";
    const el = document.createElement("model-viewer") as ARViewerElement;
    el.className = "ar-layer-viewer";
    el.setAttribute("ar", "");
    el.setAttribute("ar-modes", "scene-viewer webxr quick-look");
    el.setAttribute("ar-scale", "fixed");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ar-layer-back";
    back.textContent = AR_BACK_TO_ROOM;
    back.addEventListener("click", () => hideARLayer());
    el.addEventListener("ar-status", (event) => {
      const status = (event as CustomEvent<{ status?: unknown }>).detail?.status;
      if (status === "not-presenting" || status === "failed") hideARLayer();
    });
    document.addEventListener("visibilitychange", () => {
      // Scene Viewer and Quick Look leave the page: closing when it is
      // visible again lands back in the room.
      if (!document.hidden) hideARLayer();
    });
    host.append(name, el, back);
    document.body.appendChild(host);
    layerHost = host;
    layerName = name;
    viewer = el;
    return viewer;
  } catch {
    return null;
  }
}

/** Point the shared element at a piece (name for the layer, file to show). */
export function setARPiece(el: ARViewerElement, productId: string, name: string): void {
  el.src = arSrcFor(productId);
  el.setAttribute("alt", name);
  if (layerName !== null) layerName.textContent = arLayerTitle(name);
}

/**
 * The gate settles a moment after `src` changes: wait for the element's
 * update, then poll `canActivateAR` until it reads true or time runs out.
 */
export async function waitForARReady(
  el: ARViewerElement,
  isCurrent: () => boolean,
  timeoutMs = 2500,
): Promise<boolean> {
  try {
    await el.updateComplete;
  } catch {
    // Readiness is polled below either way.
  }
  const started = Date.now();
  while (isCurrent()) {
    try {
      if (el.canActivateAR) return true;
    } catch {
      return false;
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
