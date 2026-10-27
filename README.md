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

Example — stand in the doorway at eye height and face the back wall:

```sh
# with `npm run dev` running:
http://localhost:5173/?dev=1&camx=75&camz=45&cameye=160&camyaw=0&campitch=0&camfov=60
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
