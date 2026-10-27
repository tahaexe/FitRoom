/**
 * Demo request lists, one per route. `npm run demo:record -- <route>` sends
 * the route's list through the live pipeline with recording on (the
 * assistant list holds the six scripted turns' first rounds; recording runs
 * the whole multi-round turn per request).
 *
 * The recommend list holds every recorded request for the demo room (the
 * sample room with `shared/samples/fit-tests/valid.json`): coffee tables
 * (in front of the sofa), shelves, "What fits here?" on every free run the
 * demo room lists, and "Find a replacement" for the Chester Leather Sofa.
 * Built with the shared code — see `src/recommend-demo.ts`
 * (`check:recommend` rebuilds and compares).
 */

import { buildAssistantDemoRequests } from "./assistant-demo.js";
import { buildRecommendDemoRequests } from "./recommend-demo.js";

export const DEMO_REQUESTS: Record<"recommend" | "assistant" | "render", unknown[]> = {
  recommend: buildRecommendDemoRequests(),
  assistant: buildAssistantDemoRequests(),
  render: [],
};
