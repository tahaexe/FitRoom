/**
 * Demo request lists, one per route. `npm run demo:record -- <route>` sends
 * the route's list through the live pipeline with recording on (the
 * assistant list holds the six scripted turns' first rounds plus the three
 * brief turns; recording runs the whole multi-round turn per request;
 * `--only furnish` records just the brief turns).
 *
 * The recommend list holds every recorded request for the demo room (the
 * sample room with `shared/samples/fit-tests/valid.json`): coffee tables
 * (in front of the sofa), shelves, "What fits here?" on every free run the
 * demo room lists, and "Find a replacement" for the Chester Leather Sofa —
 * plus "What fits here?" on every fitting free run of the built (empty)
 * example room (`shared/samples/example-room.json`).
 * Built with the shared code — see `src/recommend-demo.ts`
 * (`check:recommend` rebuilds and compares).
 *
 * The assistant list holds the nine sample turns plus the three example
 * turns (the first brief and two arrange chips on the built example
 * layout); the render list holds the one example visualisation (the room
 * after the recorded Furnish, from the default view) once its furnished
 * scene fixture exists.
 */

import { buildAssistantDemoRequests, buildExampleAssistantDemoRequests } from "./assistant-demo.js";
import { buildExampleRecommendDemoRequests, buildRecommendDemoRequests } from "./recommend-demo.js";
import { buildRenderDemoRequests } from "./render-demo.js";
import { buildRoomLabelDemoRequests } from "./room-label-demo.js";

export const DEMO_REQUESTS: Record<"recommend" | "assistant" | "render" | "label", unknown[]> = {
  recommend: [...buildRecommendDemoRequests(), ...buildExampleRecommendDemoRequests()],
  assistant: [...buildAssistantDemoRequests(), ...buildExampleAssistantDemoRequests()],
  render: buildRenderDemoRequests(),
  label: buildRoomLabelDemoRequests(),
};
