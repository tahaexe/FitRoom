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
