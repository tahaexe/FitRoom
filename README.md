# FitRoom

FitRoom lets furniture stores offer a true-scale 3D fitting room in the browser. This repository holds the skeleton: a Vite + Three.js client, a Hono API server and a shared types package, wired together with npm workspaces.

## Requirements

- Node.js 22 or newer
- npm (ships with Node)

## Setup

```sh
npm ci
```

Copy `.env.example` to `.env` and fill in the values when needed. Only the server reads `META_API_KEY` from the environment; never commit a real key.

## Run

```sh
npm run dev
```

Client: http://localhost:5173 (proxies `/api` to the server). Server: http://localhost:8787 (`GET /api/health` returns `{ "ok": true, "version": "<server package version>" }`).

## Scripts

- `npm run dev` — run the client and the server together with one command.
- `npm run build` — build `shared`, then `server`, then `client`.
- `npm run typecheck` — strict TypeScript check for every workspace.
- `npm run lint` — ESLint plus a Prettier check.
- `npm start` — serve the built API and the built client from one process.
- `npm run dev:worker` — build everything and run the Cloudflare Worker locally.
- `npm run check:worker` — end-to-end Worker check, all local (no Meta call, no account).
- `npm run deploy` — ship the Worker to Cloudflare (needs Cloudflare credentials).

## Deploy

The app also runs on Cloudflare's free Workers plan as one Worker that
serves the built client and the API, with the gateway's durable state in
D1. `wrangler.jsonc` at the repo root names the Worker (`fitroom`) and the
D1 database (`fitroom`); `/api/*` runs the Worker first while every other
path serves the built client with single-page-application fallback.

Local Worker development needs no account:

```sh
npm run build
npm run dev:worker
```

`npm run check:worker` builds the client and the Worker, applies the D1
migrations locally, starts `wrangler dev` in-process with `META_MOCK=1`
and checks the app, the API, demo/mock/cache behaviour, caps, the budget
sum, restart persistence and the Worker's gzip size (under the free plan's
3 MB limit).

Deploying needs three values in the environment —
never in a file, log or commit:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `META_API_KEY` (becomes the Worker's `META_API_KEY` secret)

```sh
npm run deploy
```

The script finds the `fitroom` D1 database by name (or creates it),
writes its id into the generated, git-ignored `wrangler.deploy.jsonc` so
no account data is committed, applies `server/migrations/` remotely,
deploys, pipes the Meta key to `wrangler secret put` on standard input
(never on a command line, never printed), and prints the public URL.
Live AI routes may briefly answer unavailable until the secret lands;
demo mode answers throughout.

## Developer

The dev server (`npm run dev`) loads the twelve fit-test scenes into the
scene menu (`?dev=1`) and offers a camera hook for exact wall views. The
hook is dev-only: the production build contains no trace of it.

Add any of these URL parameters to frame an eye-level view:

- `camx`, `camz` — camera position in plan centimetres (default: room centre)
- `cameye` — eye height in centimetres (default 160)
- `camyaw` — yaw in degrees, clockwise from north, so 0 faces the north
  wall and 180 faces the south wall (default 0)
- `campitch` — pitch in degrees, positive looks up (default 0, level)
- `camfov` — vertical field of view in degrees (default 60)
- `camitems` — `0` hides every piece, leaving the empty room shell
- `camroom` — `manual` renders the plan-editor room instead of the sample
  room: the saved manual layout when one survives the reload, else the
  starter manual room

A room built in the plan editor ("Build a room" in the room menu) survives
a reload: every committed plan edit saves its layout in the browser's local
storage beside the scene autosave, and reopening the manual room (or the dev
camera hook with `camroom=manual`) restores it.

Example — stand in the doorway at eye height and face the back wall:

```sh
# with `npm run dev` running:
http://localhost:5173/?dev=1&camx=75&camz=45&cameye=160&camyaw=0&campitch=0&camfov=60
```

Example — frame the plan-editor room from the same spot:

```sh
# with `npm run dev` running:
http://localhost:5173/?dev=1&camroom=manual&camx=200&camz=300&cameye=160&camyaw=180&campitch=0&camfov=60&camitems=0
```

The hook renders a 4:3 frame, hides the interface panels and publishes
the calibrated camera on `window.__fitroomCamera` for reading from the
browser console: `width`, `height`, `fx`, `fy`, `cx`, `cy` in pixels,
`position` in metres, plus `yawDeg`, `pitchDeg`, `fovDeg` and the `room`
layout (walls, openings) the view was rendered from.

```js
window.__fitroomCamera;
// { width: 800, height: 600, fx: ..., fy: ..., cx: 400, cy: 300,
//   position: { x: 0.75, y: 1.6, z: 0.45 }, yawDeg: 0, pitchDeg: 0, fovDeg: 60,
//   room: { ... } }
```

## How it's built

All of the code in this repository was written by Meta's Muse Code agent. Recommendations and the layout assistant run on Muse Spark; the photoreal view runs on Muse Image.

## Photo-room conventions

Single table, mirrored in `shared/src/photo-room/types.ts`:

| #   | rule                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Walls are a closed counter-clockwise polygon from the inner south-west corner (origin).                                                                                                   |
| 2   | Letters run counter-clockwise seen from inside: A = wall-1 (the entrance door), B = wall-4 (on the left as you face A), C = wall-3 (opposite A), D = wall-2 (on the right as you face A). |
| 3   | Seen from inside, a wall runs from image left (its start) to image right (its end); an opening offset is measured from the wall start.                                                    |
| 4   | Plan (x, z) maps to three.js (x, z) with y up: facing +z, +x is on the left.                                                                                                              |
| 5   | A door hinge side is stored in room terms (viewed from inside facing the wall; left = wall-end side, the image-right side), never image terms.                                            |
| 6   | Every fixture has asymmetric openings and a hinged door so a consistent image/room flip fails the checks.                                                                                 |

Letter to wall id: A -> wall-1, B -> wall-4, C -> wall-3, D -> wall-2.
Tape: A and C use tape A (width); B and D use tape B (depth).

## Judge-path states

Every empty, loading and error state on the judge path, mirrored in
`client/src/copy.ts` (`STATES`, same order, same words). Each says plainly
what happened and what to do next, with a button for the next action where
one exists. `npm run check:states` renders each row's text from that same
module and asserts a next action (a button, or a sentence with a verb) and
no internal word. One name per action: every label below comes from the
same module (`npm run check:labels` pins it) — the stepper reads
Photograph → Measure → Confirm on every screen of the flow, the confirm
view included; the tape step's button is "Next: confirm"; the confirm view
keeps "Build my room"; the flow's exit is "Leave" everywhere; the header's
"Add to cart" is disabled during the photo flow and the confirm view; every
demo-miss / capped card names the same action as its button
("Use the sample room"); every accessible name starts with its visible
words.

| where            | what the screen says                                                                                                                                                                                             | next action                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| First-run dialog | Set up your room. Tell us your room size, use photos, or explore the sample room.                                                                                                                                | Enter my room size              |
| Size form        | Enter your width and length to build your room.                                                                                                                                                                  | Build my room                   |
| Photo flow       | Get both corners and the floor line in view.                                                                                                                                                                     | Take or pick a photo            |
| Photo flow       | Reading your photo…                                                                                                                                                                                              | Wait while Reading your photo   |
| Photo flow       | Analysing your photo…                                                                                                                                                                                            | Wait while Analysing your photo |
| Photo check      | We couldn't find a solid wall. Photograph a wall that isn't all window or curtain, then retake.                                                                                                                  | Retake                          |
| Photo check      | We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.                                                                                                                | Retake                          |
| Photo check      | The request timed out. Try again.                                                                                                                                                                                | Try again                       |
| Photo check      | Measuring your photos uses Live AI (it calls Meta's models).                                                                                                                                                     | Turn on Live AI                 |
| Tape step        | Measure at floor level, corner to corner. Leave one empty to estimate it from the photos.                                                                                                                        | Next: confirm                   |
| Build step       | Solving your room…                                                                                                                                                                                               | Wait while Solving your room    |
| Build step       | Solving failed just now. Please try again.                                                                                                                                                                       | Try again                       |
| Confirm view     | Wall C · 1 window found. Select the wall to view it.                                                                                                                                                             | Wall C · 1 window found         |
| Confirm view     | Wall C photo is not available. Select another wall.                                                                                                                                                              | Select another wall             |
| Empty room       | This room is empty. Add furniture from the catalog, or Furnish it for me.                                                                                                                                        | Furnish it for me               |
| Catalog search   | No matches for “zzz-no-such-piece”. Try a category: Sofas, Armchairs, Dining tables, Dining chairs, Coffee tables, Side tables, Beds, Wardrobes, Cabinets, Bookcases, Storage, TV units, Shelves, Decor or Rugs. | Try a category                  |
| AI panel         | Asking Muse Spark…                                                                                                                                                                                               | Wait while Asking Muse Spark    |
| AI panel         | This answer isn't in the demo yet. Use the sample room or turn on Live AI.                                                                                                                                       | Use the sample room             |
| AI panel         | The AI service is unreachable. Please try again.                                                                                                                                                                 | Please try again                |
| AI panel         | The live AI is resting. Use the sample room or try again later.                                                                                                                                                  | Use the sample room             |
| Visualise        | Visualising… 0s                                                                                                                                                                                                  | Wait while Visualising          |
| Visualise        | The visualiser couldn't make an image just now. Please try again.                                                                                                                                                | Try again                       |
| Empty cart       | Your cart is empty. Add furniture from the catalog.                                                                                                                                                              | Add furniture to the room first |
