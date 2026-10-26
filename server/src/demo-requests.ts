/**
 * Demo request lists, one per route. `npm run demo:record -- <route>` sends
 * the route's list through the live pipeline with recording on. The next
 * tasks (real request, prompt and schema per route) fill these lists; they
 * start empty.
 */

export const DEMO_REQUESTS: Record<"recommend" | "assistant" | "render", unknown[]> = {
  recommend: [],
  assistant: [],
  render: [],
};
