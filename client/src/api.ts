/**
 * Gateway client: posts to `/api/*` (same origin; the Vite proxy in
 * development) and returns typed results for ok, demo-miss, capped,
 * not-ready and error answers.
 *
 * Demo mode is the default for every new visitor. The top bar's "Live AI"
 * switch is remembered in localStorage and sent with each request as the
 * `X-FitRoom-Live` header; off means "Demo".
 */

import { isGatewayResponse, type GatewayResponse, type GatewaySource } from "@fitroom/shared";
import {
  AI_UNREACHABLE,
  CAPPED_MESSAGE,
  LIVE_COST_QUESTION,
  STAY_IN_DEMO,
  TURN_ON_LIVE,
} from "./copy";

const LIVE_STORAGE_KEY = "fitroom.live-ai";

/** Asked once per visit: the cost question shows only on the first switch-on. */
let liveAskedThisVisit = false;

/** Test hook: forget the visit's answer so the first-ask case can run again. */
export function __resetLiveAskForTest(): void {
  liveAskedThisVisit = false;
}

/** True when turning on must ask first (first switch-on of the visit, still in Demo). */
export function liveAskNeeded(): boolean {
  return !liveAskedThisVisit && !isLive();
}

export type ApiResult =
  | { status: "ok"; source: GatewaySource; route: string; model: string; data: unknown }
  | { status: "demo-miss"; message: string }
  | { status: "capped"; message: string }
  | { status: "not-ready" }
  | { status: "error"; message: string };

/** True when the visitor switched Live AI on (default: demo). */
export function isLive(): boolean {
  try {
    return window.localStorage.getItem(LIVE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export const LIVE_CHANGE_EVENT = "fitroom:live-change";

export function setLive(live: boolean): void {
  try {
    window.localStorage.setItem(LIVE_STORAGE_KEY, live ? "1" : "0");
  } catch {
    // Private mode: the switch still works for this visit.
  }
  updateLiveSwitch();
  window.dispatchEvent(new CustomEvent(LIVE_CHANGE_EVENT, { detail: { live } }));
}

/**
 * The one way to turn Live AI on: asks the cost question once per visit.
 * Turning off never asks. Stay in Demo (the default; Esc stays) leaves
 * `isLive()` false.
 */
export function requestLive(): Promise<boolean> {
  if (isLive()) return Promise.resolve(true);
  if (liveAskedThisVisit) {
    setLive(true);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "live-confirm-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "live-confirm";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", LIVE_COST_QUESTION);
    const question = document.createElement("p");
    question.className = "live-confirm-question";
    question.textContent = LIVE_COST_QUESTION;
    const row = document.createElement("div");
    row.className = "live-confirm-row";
    const stay = document.createElement("button");
    stay.type = "button";
    stay.className = "live-confirm-stay";
    stay.textContent = STAY_IN_DEMO;
    stay.setAttribute("autofocus", "");
    const go = document.createElement("button");
    go.type = "button";
    go.className = "live-confirm-go";
    go.textContent = TURN_ON_LIVE;
    row.append(stay, go);
    dialog.append(question, row);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const done = (on: boolean): void => {
      liveAskedThisVisit = true;
      backdrop.remove();
      if (on) setLive(true);
      resolve(on);
    };
    stay.addEventListener("click", () => done(false));
    go.addEventListener("click", () => done(true));
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
    });
    stay.focus();
  });
}

function toResult(payload: GatewayResponse): ApiResult {
  switch (payload.status) {
    case "ok":
      return {
        status: "ok",
        source: payload.source,
        route: payload.route,
        model: payload.model,
        data: payload.data,
      };
    case "demo-miss":
      return { status: "demo-miss", message: payload.message };
    case "capped":
      return { status: "capped", message: payload.message };
    case "not-ready":
      return { status: "not-ready" };
    case "error":
      return { status: "error", message: payload.message };
  }
}

function isCallerTimeout(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof DOMException && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postGateway(
  route: "recommend" | "assistant" | "render" | "room/segment" | "room/label",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ApiResult> {
  // Demo requests (no live header) retry once after ~500 ms on a network
  // error or an HTTP 5xx, then show today's error. Live requests never
  // retry (a second send could bill twice), nor do demo-miss, capped,
  // not-ready, ok or the caller's own time-out.
  const live = isLive();
  const send = (): Promise<Response> =>
    fetch(`/api/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(live ? { "X-FitRoom-Live": "1" } : {}),
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
  const readResult = async (res: Response): Promise<ApiResult | null> => {
    let payload: unknown;
    try {
      payload = (await res.json()) as unknown;
    } catch {
      return null;
    }
    if (!isGatewayResponse(payload)) return null;
    if (res.status === 429 && payload.status !== "capped") {
      return { status: "capped", message: CAPPED_MESSAGE };
    }
    return toResult(payload);
  };
  const retryableHttp = (res: Response, result: ApiResult | null): boolean => {
    if (live) return false;
    if (res.status < 500 || res.status > 599) return false;
    // Only the error shape retries: ok, demo-miss, capped and not-ready
    // never do (not-ready arrives as HTTP 501).
    return result === null || result.status === "error";
  };
  let res: Response;
  try {
    res = await send();
  } catch (error) {
    if (isCallerTimeout(error, signal)) {
      return { status: "error", message: "The request timed out. Try again." };
    }
    if (live) return { status: "error", message: AI_UNREACHABLE };
    await sleep(500);
    try {
      res = await send();
    } catch (retryError) {
      if (isCallerTimeout(retryError, signal)) {
        return { status: "error", message: "The request timed out. Try again." };
      }
      return { status: "error", message: AI_UNREACHABLE };
    }
  }
  let result = await readResult(res);
  if (result === null) {
    if (retryableHttp(res, null)) {
      await sleep(500);
      try {
        res = await send();
      } catch (retryError) {
        if (isCallerTimeout(retryError, signal)) {
          return { status: "error", message: "The request timed out. Try again." };
        }
        return { status: "error", message: AI_UNREACHABLE };
      }
      result = await readResult(res);
      if (result === null) {
        return { status: "error", message: AI_UNREACHABLE };
      }
    } else {
      return { status: "error", message: AI_UNREACHABLE };
    }
  }
  if (retryableHttp(res, result)) {
    await sleep(500);
    let retryRes: Response;
    try {
      retryRes = await send();
    } catch (retryError) {
      if (isCallerTimeout(retryError, signal)) {
        return { status: "error", message: "The request timed out. Try again." };
      }
      return { status: "error", message: AI_UNREACHABLE };
    }
    const retryResult = await readResult(retryRes);
    return retryResult ?? result;
  }
  return result;
}

export function postRecommend(
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ApiResult> {
  return postGateway("recommend", body, options?.signal);
}

export function postAssistant(
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ApiResult> {
  return postGateway("assistant", body, options?.signal);
}

export function postRender(body: Record<string, unknown>): Promise<ApiResult> {
  return postGateway("render", body);
}

export function postSegment(
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ApiResult> {
  return postGateway("room/segment", body, options?.signal);
}

export function postLabel(
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ApiResult> {
  return postGateway("room/label", body, options?.signal);
}

/** Bind the top bar's Live AI switch (off = "Demo"). */
export function initLiveSwitch(): void {
  const root = document.getElementById("live-switch");
  if (root === null) return;
  root.addEventListener("click", () => {
    if (isLive()) setLive(false);
    else void requestLive();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (isLive()) setLive(false);
      else void requestLive();
    }
  });
  updateLiveSwitch();
}

function updateLiveSwitch(): void {
  const root = document.getElementById("live-switch");
  if (!(root instanceof HTMLElement)) return;
  const live = isLive();
  root.setAttribute("aria-checked", String(live));
  root.title = live
    ? "Live AI is on: requests may call the metered Meta API"
    : "Demo mode: answers come from stored responses at zero cost";
  for (const option of root.querySelectorAll(".live-option")) {
    if (!(option instanceof HTMLElement)) continue;
    const active =
      (option.dataset["value"] === "live" && live) || (option.dataset["value"] === "demo" && !live);
    option.dataset["active"] = String(active);
  }
}
