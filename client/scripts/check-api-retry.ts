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
import { AI_UNREACHABLE } from "../src/copy.js";

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
