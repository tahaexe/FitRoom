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

const LIVE_STORAGE_KEY = "fitroom.live-ai";

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

export function setLive(live: boolean): void {
  try {
    window.localStorage.setItem(LIVE_STORAGE_KEY, live ? "1" : "0");
  } catch {
    // Private mode: the switch still works for this visit.
  }
  updateLiveSwitch();
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

async function postGateway(
  route: "recommend" | "assistant" | "render",
  body: Record<string, unknown>,
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(`/api/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isLive() ? { "X-FitRoom-Live": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: "error", message: "The AI service is unreachable." };
  }
  let payload: unknown;
  try {
    payload = (await res.json()) as unknown;
  } catch {
    return { status: "error", message: `The AI service answered HTTP ${String(res.status)}.` };
  }
  if (!isGatewayResponse(payload)) {
    return { status: "error", message: `The AI service answered HTTP ${String(res.status)}.` };
  }
  if (res.status === 429 && payload.status !== "capped") {
    return { status: "capped", message: "The live AI is resting; try the demo room." };
  }
  return toResult(payload);
}

export function postRecommend(body: Record<string, unknown>): Promise<ApiResult> {
  return postGateway("recommend", body);
}

export function postAssistant(body: Record<string, unknown>): Promise<ApiResult> {
  return postGateway("assistant", body);
}

export function postRender(body: Record<string, unknown>): Promise<ApiResult> {
  return postGateway("render", body);
}

/** Bind the top bar's Live AI switch (off = "Demo"). */
export function initLiveSwitch(): void {
  const root = document.getElementById("live-switch");
  if (root === null) return;
  root.addEventListener("click", () => {
    setLive(!isLive());
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setLive(!isLive());
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
      (option.dataset["value"] === "live" && live) ||
      (option.dataset["value"] === "demo" && !live);
    option.dataset["active"] = String(active);
  }
}
