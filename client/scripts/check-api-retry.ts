/**
 * `npm run check:api-retry` — demo rounds retry once, live never retries.
 *
 * With a stubbed `fetch` over `client/src/api.ts`:
 * - demo: one network failure then the demo answer gives the answer (2 sends);
 * - demo: two failures give today's error copy (2 sends);
 * - demo: HTTP 500 then the demo answer gives the answer (2 sends);
 * - live: a failing request is sent once;
 * - never a retry on demo-miss, capped, not-ready, an ok answer or the
 *   caller's own time-out.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 * No browser, no live Meta calls.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_UNREACHABLE } from "../src/copy.js";

const clientSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const panelSrc = (relative: string): string => readFileSync(join(clientSrcDir, relative), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function demoOk(): Record<string, unknown> {
  return { status: "ok", source: "demo", route: "recommend", model: "muse-spark-1.3", data: {} };
}

function stubResponse(status: number, payload: unknown): Response {
  return { status, json: async () => payload } as unknown as Response;
}

async function main(): Promise<void> {
  const api = await import("../src/api.js");
  const globalScope = globalThis as unknown as {
    fetch: typeof fetch;
    window?: unknown;
  };
  const realFetch = globalScope.fetch;
  const realWindow = globalScope.window;

  const setLive = (live: boolean): void => {
    globalScope.window = {
      localStorage: { getItem: () => (live ? "1" : "0"), setItem: () => {} },
    };
  };

  try {
    // 1. Demo: one network failure then the demo answer gives the answer.
    {
      setLive(false);
      let calls = 0;
      let liveHeaderSeen = false;
      globalScope.fetch = (async (_url: unknown, init?: unknown) => {
        calls += 1;
        const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
        if (headers?.["X-FitRoom-Live"] === "1") liveHeaderSeen = true;
        if (calls === 1) throw new Error("offline");
        return stubResponse(200, demoOk());
      }) as unknown as typeof fetch;
      const started = Date.now();
      const result = await api.postRecommend({ hello: "world" });
      const elapsed = Date.now() - started;
      check(
        "demo network failure retries then answers",
        result.status === "ok" && calls === 2 && !liveHeaderSeen,
        JSON.stringify({ result, calls }),
      );
      check("demo retry waits about 500 ms", elapsed >= 400, `${String(elapsed)} ms`);
    }

    // 2. Demo: two failures give today's error copy.
    {
      setLive(false);
      let calls = 0;
      globalScope.fetch = (async () => {
        calls += 1;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const result = await api.postRecommend({ hello: "world" });
      check(
        "demo two failures give today's error",
        result.status === "error" &&
          (result as { message?: string }).message === AI_UNREACHABLE &&
          calls === 2,
        JSON.stringify({ result, calls }),
      );
    }

    // 3. Demo: HTTP 500 then the demo answer gives the answer.
    {
      setLive(false);
      let calls = 0;
      globalScope.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return stubResponse(500, {
            status: "error",
            message: "The live AI is unavailable.",
          });
        }
        return stubResponse(200, demoOk());
      }) as unknown as typeof fetch;
      const result = await api.postRecommend({ hello: "world" });
      check(
        "demo HTTP 500 retries then answers",
        result.status === "ok" && calls === 2,
        JSON.stringify({ result, calls }),
      );
    }

    // 4. Demo: two HTTP 500s give today's error.
    {
      setLive(false);
      let calls = 0;
      globalScope.fetch = (async () => {
        calls += 1;
        return stubResponse(500, {
          status: "error",
          message: "The live AI is unavailable.",
        });
      }) as unknown as typeof fetch;
      const result = await api.postRecommend({ hello: "world" });
      check(
        "demo two HTTP 500s give today's error",
        result.status === "error" && calls === 2,
        JSON.stringify({ result, calls }),
      );
    }

    // 5. Live: a failing request is sent once.
    {
      setLive(true);
      let calls = 0;
      let liveHeaderSeen = false;
      globalScope.fetch = (async (_url: unknown, init?: unknown) => {
        calls += 1;
        const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
        if (headers?.["X-FitRoom-Live"] === "1") liveHeaderSeen = true;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const result = await api.postRecommend({ hello: "world" });
      check(
        "live network failure is sent once",
        calls === 1 && liveHeaderSeen && result.status === "error",
        JSON.stringify({ result, calls }),
      );
    }

    // 6. Live: HTTP 500 is sent once (a second send could bill twice).
    {
      setLive(true);
      let calls = 0;
      globalScope.fetch = (async () => {
        calls += 1;
        return stubResponse(500, {
          status: "error",
          message: "The live AI is unavailable.",
        });
      }) as unknown as typeof fetch;
      const result = await api.postRecommend({ hello: "world" });
      check("live HTTP 500 is sent once", calls === 1, JSON.stringify({ result, calls }));
      check("live HTTP 500 stays an error", result.status === "error");
    }

    // 7-10. Never a retry on demo-miss, capped, not-ready or ok.
    {
      const cases: Array<{ name: string; status: number; payload: unknown }> = [
        {
          name: "demo-miss",
          status: 200,
          payload: { status: "demo-miss", message: "Use the sample room." },
        },
        {
          name: "capped",
          status: 429,
          payload: { status: "capped", message: "The live AI is resting." },
        },
        { name: "not-ready", status: 501, payload: { status: "not-ready" } },
        { name: "ok", status: 200, payload: demoOk() },
      ];
      for (const entry of cases) {
        setLive(false);
        let calls = 0;
        globalScope.fetch = (async () => {
          calls += 1;
          return stubResponse(entry.status, entry.payload);
        }) as unknown as typeof fetch;
        const result = await api.postRecommend({ hello: "world" });
        const want =
          entry.name === "demo-miss"
            ? "demo-miss"
            : entry.name === "capped"
              ? "capped"
              : entry.name === "not-ready"
                ? "not-ready"
                : "ok";
        check(
          `${entry.name} is sent once`,
          calls === 1 && result.status === want,
          JSON.stringify({ result, calls }),
        );
      }
    }

    // 11. The caller's own time-out never retries.
    {
      setLive(false);
      let calls = 0;
      globalScope.fetch = (async () => {
        calls += 1;
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch;
      const controller = new AbortController();
      controller.abort();
      const result = await api.postSegment({ hello: "world" }, { signal: controller.signal });
      check(
        "caller time-out is sent once with today's copy",
        calls === 1 &&
          result.status === "error" &&
          (result as { message?: string }).message === "The request timed out. Try again.",
        JSON.stringify({ result, calls }),
      );
    }

    // 12. postRecommend and postAssistant take the caller's abort signal:
    // an aborted live request is sent once with today's copy (no retry,
    // so no second send that could bill twice).
    {
      setLive(true);
      const calls: Array<{ name: string; call: (signal: AbortSignal) => Promise<unknown> }> = [
        {
          name: "postRecommend",
          call: (signal) => api.postRecommend({ hello: "world" }, { signal }),
        },
        {
          name: "postAssistant",
          call: (signal) => api.postAssistant({ hello: "world" }, { signal }),
        },
      ];
      for (const entry of calls) {
        let sends = 0;
        let seenAborted: boolean | null = null;
        globalScope.fetch = (async (_url: unknown, init?: unknown) => {
          sends += 1;
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          seenAborted = signal?.aborted ?? null;
          throw new DOMException("aborted", "AbortError");
        }) as unknown as typeof fetch;
        const controller = new AbortController();
        controller.abort();
        const result = (await entry.call(controller.signal)) as {
          status?: string;
          message?: string;
        };
        check(
          `${entry.name} aborted is sent once with today's copy`,
          sends === 1 &&
            seenAborted === true &&
            result.status === "error" &&
            result.message === "The request timed out. Try again.",
          JSON.stringify({ result, sends }),
        );
      }
    }

    // 13. Arrange, Furnish and Recommend count seconds like Visualise and
    // offer Cancel; an aborted request leaves no answer applied.
    {
      const assistant = panelSrc("assistant/panel.ts");
      const recommend = panelSrc("recommend/panel.ts");
      check(
        "assistant passes the abort signal",
        assistant.includes("new AbortController()") && assistant.includes("{ signal }"),
        "assistant/panel.ts",
      );
      check(
        "assistant wait counts seconds",
        assistant.includes("`${ASSISTANT_LOADING} ${String(secs)}s`"),
        "assistant/panel.ts",
      );
      check(
        "assistant Cancel aborts the request",
        assistant.includes("assistant-cancel") && assistant.includes("controller.abort()"),
        "assistant/panel.ts",
      );
      check(
        "assistant abort leaves no answer applied",
        assistant.includes("An aborted request leaves no answer applied") &&
          assistant.includes("this.addCancelled(request)"),
        "assistant/panel.ts",
      );
      check(
        "assistant keeps the typed text after Cancel",
        assistant.includes("input.value = request") && assistant.includes("CANCELLED"),
        "assistant/panel.ts",
      );
      check(
        "recommend passes the abort signal",
        recommend.includes("new AbortController()") &&
          recommend.includes("signal: controller.signal"),
        "recommend/panel.ts",
      );
      check(
        "recommend wait counts seconds",
        recommend.includes("`${RECOMMEND_LOADING} ${String(secs)}s`"),
        "recommend/panel.ts",
      );
      check(
        "recommend Cancel aborts the request",
        recommend.includes("recommend-cancel") && recommend.includes("controller.abort()"),
        "recommend/panel.ts",
      );
      check(
        "recommend abort leaves no answer applied",
        recommend.includes("An aborted request leaves no answer applied") &&
          recommend.includes("showNotice(CANCELLED, false)"),
        "recommend/panel.ts",
      );
    }
  } finally {
    globalScope.fetch = realFetch;
    if (realWindow === undefined) {
      delete globalScope.window;
    } else {
      globalScope.window = realWindow;
    }
  }

  console.log(
    failures === 0
      ? "check:api-retry: all checks passed"
      : `check:api-retry: ${String(failures)} failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:api-retry: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
