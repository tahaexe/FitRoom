# FitRoom

FitRoom is a true-scale 3D fitting room for furniture stores, in the browser. A shopper builds a model of their room from four wall photos and one or two tape measurements, or draws it as a plan, and tries the store's furniture in it before buying. Every placement is checked in centimetres, and Meta's models recommend, arrange, furnish and picture the room.

- Live demo: https://fitroom.fitroom-demo.workers.dev (opens in Demo mode: no sign-in, no model calls)

## Try it in Demo mode

1. Open the live demo. A first visit opens "Set up your room" with the first step of a short guide (**Skip tour** closes it; **?**, or ⋯ › **Show the guide again** on a phone, brings it back); choose **Open the furnished sample**. The sample living room (420 × 360 cm) opens with four pieces and the badge "✓ Everything fits". Demo mode replays recorded answers, so nothing below calls a model.
2. Press **Visualise**. Muse Image's photoreal picture of this layout appears with a before/after slider. Close it.
3. Drag a piece in front of the door. The badge turns red and the room shows how far the piece reaches into the door's swing, in centimetres. Press **Undo**.
4. Press **Arrange** and pick "Put the sofa under the window and keep 80 cm free in front of the door." Muse Spark's tool calls replay, each one checked by the fit engine, and the room stays "✓ Everything fits".
5. Open the **Furnish** tab and pick "4 seats · Classic · up to $2,500" (confirm if asked). The room is furnished from the catalog, and the card adds up the seats and the prices against the budget.
6. Press **Add to cart** (on a phone, the cart total in the bottom bar). The cart panel lists each piece with its size and price, the total and the room's fit, and **Copy link** copies a link to this layout.

For your own room on a computer, open the room menu at the top left and choose **From photos** (needs Live AI) or **Build a room**; a phone offers both on its first-visit screen.

## What it does

- A true-scale room in centimetres, shown as a 3D dollhouse in warm daylight and as a plan with wall lengths and each door's swing. The first view frames the whole room and turns toward its windows.
- A sample store's catalog of 34 CC0 furniture models, 3 rugs and 4 simple pieces built in code, from sofas and dining sets to beds and wardrobes. Each piece has a size, a price and a seat count. The Provence loveseat and armchair come in six fabrics, the Bloom chair in two.
- Fit verdicts in centimetres. Each one names the other piece or wall and the amount. The checks cover overlaps, pieces outside the walls and the door's swing. They also cover walkways (an 80 cm path from the door, then 45 cm to each seat) and tall pieces in front of a window. Clearance shades the floor a walkway can't use.
- Recommend (Muse Spark): "What fits here?" for a free wall and "Find a replacement" for a selected piece. Only pieces that fit are offered.
- Arrange (Muse Spark with tool calls): layout requests in plain words. A turn is applied only when the fit engine finds no error. A request the room can't take is refused with the sizes, for example "The Heritage Grand Sofa is 273 cm wide but the Door wall between the door and the corner is only 30 cm, so it can't fit there." The list of tool calls gives each refused call its own line.
- Furnish (Muse Spark with tool calls): seats, a style and a budget. Muse Spark furnishes the room from the catalog, the code refuses any piece that would pass the budget, and the result card computes the seats and the prices. "Keep the pieces already here" completes a room instead of starting over.
- Visualise (Muse Image): a photoreal picture of the layout, with a before/after slider and a download.
- From photos (SAM 3.1 and Muse Spark): one photo per wall and two walls taped corner to corner give a draft plan to confirm. Each wall length is marked measured or estimated, with its margin in centimetres.
- Build a room: type the room's width and length in centimetres or feet and inches, then add its doors and windows in the plan editor.
- Undo and redo, and autosave in the browser. **Add to cart** opens a cart panel under the line "Demo store · invented products and prices". It lists each piece with its size and price, the total and "✓ Everything fits", or how many pieces don't fit yet with those pieces marked. **Download list** saves it as JSON, and the shareable link (**Copy link**) rebuilds the room and its pieces from the address alone.
- A demo product page for every catalog piece at `/store?id=<catalog id>`. Under the line "Demo store · invented products and prices" it shows the piece's picture and its model's credit, then its size and price. Its **See it in your room** button opens FitRoom with the piece's catalog card ringed and the hint "Press + Add to put the … in your room"; on a first visit the ring waits until the first-use guide has ended and a room is open. Nothing is placed by itself.
- Confirming a photo room: each wall photo shows its corners as handles, with a magnifier while dragging, and its doors and windows as boxes with their sizes and margins ("Door 100 ± 3 × 210"). A small plan names each wall with its length, and a wall keeps one name from the tape step on ("Wall A · door wall"). The flow's three steps, Photograph, Measure and Confirm, show on every screen. Dragging a corner re-solves the room, a length typed from the tape becomes measured (± 0.5 cm), and Undo takes either back. "Found by SAM 3.1" under each photo's checks names the model at work.
- Floor and wall finishes from the photos: Muse Spark labels the materials, and code measures each surface's colour inside SAM 3.1's masks. It picks the closest CC0 floor texture and tints the walls, and the shopper can change both under Finishes.
- A generated example room, labelled as such, runs the photo path in Demo mode with no model calls. Its four wall photos were made with Muse Image from the sample room, and SAM 3.1's and Muse Spark's answers for them are recorded. Its tape step fills in only wall A, so wall B is estimated from the photos and shown beside its true length. Once it is built, **See it in your photo** draws the placed pieces into its four wall photos at true size, with the camera measured from each photo. It counts any piece the photo can't show.
- A phone layout, with the catalog in a sheet, the main actions in a bottom bar and touch targets of at least 44 px. A "Set up your room" screen on the first visit, with a four-step guide that shows once. Every step has **Skip tour**, and the **?** button (on a phone, ⋯ › **Show the guide again**) brings it back.
- An empty room says "This room is empty. Add furniture from the catalog, or Furnish it for me", and the fit badge appears with the first piece. The AI actions sit together in the toolbar under an AI tag, and one side panel opens at a time.

## How it works

FitRoom is one web app and one small server.

The room is a JSON layout in centimetres (walls, openings, fixtures) that Three.js draws as a dollhouse and as a plan. The fit engine is deterministic TypeScript shared by the browser, the server and the checks. It tests oriented footprints at any angle with the separating-axis test and finds pieces outside the walls. Each door's swing is a quarter disc, walkways run on a 1 cm grid, and tall pieces in front of a window get a warning. Every issue names the other piece or wall and the amount.

Muse Spark proposes and the fit engine checks. An assistant turn runs on a draft copy of the room and is applied as one undo step only if the draft has no fit error. When the engine reports a problem, it returns the errors to the model, for up to eight rounds.

A room from photos: each wall photo is downscaled in the browser. SAM 3.1 marks its walls, floor, ceiling, doors and windows, one request per concept. The browser decodes the masks with Meta's `@meta-sam/parser`, and code fits straight lines to the mask boundaries to find the wall's four corners. The wall's true proportions come from perspective and the camera's focal length (Zhang and He, 2007). Doors and windows are mapped onto the wall through its homography, and one least-squares fit over the four walls gives the room, with the taped walls exact. The same homography and focal length give each photo's camera position and angle, so the built example room can draw its pieces into its own photos at true size. Muse Spark reads smaller copies of the photos and labels the room's style, colours and materials. The materials pick the finishes: code measures each surface's colour inside SAM 3.1's masks, picks the closest CC0 floor texture and tints the walls. The shopper confirms the draft in the plan editor; when the masks miss a door, the app asks them to tap it.

Visualise sends Muse Image a capture of the 3D view from the current direction, framed to the whole room.

On a first visit the setup screen paints a 640 px picture of the sample room before the room's 3D files load. The room then builds one heavy step per task, from WebP colour and roughness maps, 512 px normal maps and a 512 × 256 environment map.

## Meta models

| Model      | Id               | Where FitRoom uses it                                                                                                                     | What the code does around it                                                                                                     |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Muse Spark | `muse-spark-1.3` | Recommend (fixed JSON schema); Arrange and Furnish (ten tools); labels for a photographed room (style, colours, floor and wall materials) | Free-space analysis picks the candidates; the fit engine checks every tool call; the budget, the seats and the card are computed |
| SAM 3.1    | `sam-3.1`        | Walls, floor, ceiling, doors and windows in each wall photo                                                                               | The browser decodes the masks; geometry turns them into centimetres; the finishes' colours are measured inside them              |
| Muse Image | `muse-image-1.0` | Visualise; the generated example room's wall photos                                                                                       | A capture of the 3D view and a description of the layout                                                                         |
| Muse Code  | coding agent     | Wrote all of FitRoom's own code                                                                                                           |                                                                                                                                  |

## How it was built

All of FitRoom's own code was written by Meta's Muse Code agent. SAM 3.1 and Muse Spark read the photos, Muse Spark recommends, arranges and furnishes, and Muse Image makes the pictures.

## Architecture

```text
client/  Vite + TypeScript + Three.js, plain DOM: room, catalog, plan editor,
         photo capture, assistant panel, Visualise
shared/  types and JSON schemas, the fit engine, free-space analysis,
         the assistant's tools, the photo-to-room geometry
server/  Hono API: /api/recommend, /api/assistant, /api/render,
         /api/room/segment, /api/room/label, /api/health
         one gateway for every Meta call:
         demo answers → cache → rate limit and caps → Meta → metering
```

Development runs on Node. Production is one Cloudflare Worker on the free plan that serves the built client and the API, with D1 for the cache, the caps and the cost log.

## Demo mode and Live AI

- **Demo** (the default) replays recorded answers. For the sample room it has six Arrange requests and three Furnish briefs, Recommend on its free walls, a replacement for its sofa and Visualise. For the example room it replays the analysis of its four photos and Recommend on its free walls. It also replays the example room's two Arrange requests, the brief "2 seats · Modern · up to $1,500" and Visualise after that brief. It makes no model call and costs nothing. Anything else answers "This answer isn't in the demo yet. Use the sample room or turn on Live AI." with two buttons, **Use the sample room** and **Turn on Live AI**. A demo request that meets a network error or an HTTP 5xx is sent once more after about half a second; a Live AI request never is.
- **Live AI** (the switch at the top) sends requests through FitRoom's server to Meta's Model API.
  - The API key is a Worker secret and never reaches the browser.
  - Identical requests are answered from the cache.
  - Calls and spending are capped: per browser session 20 model calls and USD 0.50; per visitor 30 requests a minute; in total USD 10, counted from 3 November 2026, 00:00 UTC. A SAM 3.1 request counts as a fifth of a call. Demo and cache answers never count.
  - A capped request answers "The live AI is resting. Use the sample room or try again later." So does a call that Meta's API refuses with HTTP 401, 402 or 429 or with a quota, credit or billing error. The recorded demo answers keep working.
  - Every answered request is metered (tokens and USD) in D1. When the server asks Meta again after an unusable answer, that line carries every billed try, so the spending caps count them all. By the price list, a room from photos costs about USD 0.06 (20 SAM 3.1 requests and one Muse Spark call).

## Run it locally

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

Client: http://localhost:5173 (proxies `/api` to the server). Server: http://localhost:8787 (API only in dev; try `/api/health`). Demo mode works without a key. For Live AI, copy `.env.example` to `.env` and set `META_API_KEY`; only the server reads it. `META_MOCK=1` answers from fixtures with no model call. Five variables set the caps: `META_SESSION_MAX_CALLS`, `META_SESSION_MAX_USD`, `META_RATE_PER_MIN`, `META_BUDGET_USD` and `META_BUDGET_FROM`. The total budget `META_BUDGET_USD` counts from the time in `META_BUDGET_FROM`; before that time, or when the variable is empty or invalid, the total is USD 5.

- `npm run build`, then `npm start`: the built client and the API from one Node process.
- `npm run dev:worker`: the Cloudflare Worker locally with D1, no account needed.
- `npm run typecheck`, `npm run lint` and `npm run validate` (the 14 fit-test scenes with known answers).
- One `check:` script per area, such as `npm run check:geometry`, `npm run check:assistant` or `npm run check:states` (`npm run` lists them; the client-only ones run with `npm run <name> -w @fitroom/client`). `npm run check:worker` runs the whole Worker locally with no model call and no account.

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

Deploying needs three values in the environment:
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

- `camx`, `camz`: camera position in plan centimetres (default: room centre)
- `cameye`: eye height in centimetres (default 160)
- `camyaw`: yaw in degrees, clockwise from north, so 0 faces the north
  wall and 180 faces the south wall (default 0)
- `campitch`: pitch in degrees, positive looks up (default 0, level)
- `camfov`: vertical field of view in degrees (default 60)
- `camitems`: `0` hides every piece, leaving the empty room shell
- `camroom`: `manual` renders the plan-editor room instead of the sample
  room: the saved manual layout when one survives the reload, else the
  starter manual room

A room built in the plan editor ("Build a room" in the room menu) survives
a reload: every committed plan edit saves its layout in the browser's local
storage beside the scene autosave, and reopening the manual room (or the dev
camera hook with `camroom=manual`) restores it.

Example: stand in the doorway at eye height and face the back wall:

```sh
# with `npm run dev` running:
http://localhost:5173/?dev=1&camx=75&camz=45&cameye=160&camyaw=0&campitch=0&camfov=60
```

Example: frame the plan-editor room from the same spot:

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

## Empty, loading and error states

Every empty, loading and error state on the judge path, mirrored in
`client/src/copy.ts` (`STATES`, same order, same words). Each says plainly
what happened and what to do next, with a button for the next action where
one exists. `npm run check:states` renders each row's text from that same
module and asserts a next action (a button, or a sentence with a verb) and
no internal word. One name per action: every label below comes from the
same module (`npm run check:labels` pins it): the stepper reads
Photograph → Measure → Confirm on every screen of the flow, the confirm
view included; the tape step's button is "Next: confirm"; the confirm view
keeps "Build my room"; the flow's exit is "Leave" everywhere; the header's
"Add to cart" is hidden during the first-run dialog, the photo flow and the
confirm view; every demo-miss / capped card names the same action as its
button ("Use the sample room"); every accessible name starts with its
visible words.

| where              | what the screen says                                                                                                                                                                                             | next action                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| First-run dialog   | Set up your room. Tell us your room size, use photos, or explore the sample room.                                                                                                                                | Enter my room size              |
| Size form          | Enter your width and length to build your room.                                                                                                                                                                  | Build my room                   |
| Photo flow         | Get both corners and the floor line in view.                                                                                                                                                                     | Take or pick a photo            |
| Photo flow         | Reading your photo…                                                                                                                                                                                              | Wait while Reading your photo   |
| Photo flow         | Analysing your photo…                                                                                                                                                                                            | Wait while Analysing your photo |
| Photo check        | We couldn't find a solid wall. Photograph a wall that isn't all window or curtain, then retake.                                                                                                                  | Retake                          |
| Photo check        | We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.                                                                                                                | Retake                          |
| Photo check        | The request timed out. Try again.                                                                                                                                                                                | Try again                       |
| Photo check        | Measuring your photos uses Live AI (it calls Meta's models).                                                                                                                                                     | Turn on Live AI                 |
| Tape step          | Measure at floor level, corner to corner. Leave one empty to estimate it from the photos.                                                                                                                        | Next: confirm                   |
| Build step         | Solving your room…                                                                                                                                                                                               | Wait while Solving your room    |
| Build step         | Solving failed just now. Please try again.                                                                                                                                                                       | Try again                       |
| Confirm view       | Wall C · 1 window found. Select the wall to view it.                                                                                                                                                             | Wall C · 1 window found         |
| Confirm view       | Wall C photo is not available. Select another wall.                                                                                                                                                              | Select another wall             |
| Empty room         | This room is empty. Add furniture from the catalog, or Furnish it for me.                                                                                                                                        | Furnish it for me               |
| Catalog search     | No matches for “zzz-no-such-piece”. Try a category: Sofas, Armchairs, Dining tables, Dining chairs, Coffee tables, Side tables, Beds, Wardrobes, Cabinets, Bookcases, Storage, TV units, Shelves, Decor or Rugs. | Try a category                  |
| AI panel           | Asking Muse Spark…                                                                                                                                                                                               | Wait while Asking Muse Spark    |
| AI panel           | This answer isn't in the demo yet. Use the sample room or turn on Live AI.                                                                                                                                       | Use the sample room             |
| AI panel           | The AI service is unreachable. Please try again.                                                                                                                                                                 | Please try again                |
| AI panel           | The live AI is resting. Use the sample room or try again later.                                                                                                                                                  | Use the sample room             |
| Visualise          | Visualising… 0s                                                                                                                                                                                                  | Wait while Visualising          |
| Visualise          | The visualiser couldn't make an image just now. Please try again.                                                                                                                                                | Try again                       |
| Empty cart         | Your cart is empty. Add furniture from the catalog.                                                                                                                                                              | Add furniture to the room first |
| Cart panel         | Your cart is empty. Add furniture from the catalog.                                                                                                                                                              | Browse the catalog              |
| Shared layout link | That share link didn't work. Use the sample room to start again.                                                                                                                                                 | Use the sample room             |

## Privacy

- FitRoom has no accounts and runs no analytics scripts.
- FitRoom saves your room, your layout and your photos only in your browser's storage, and keeps the photos only while you build a room from them.
- Demo mode sends nothing to Meta.
- In Live AI, each wall photo goes through FitRoom's server to Meta's Model API: a 1280 px copy to SAM 3.1 and a 640 px copy to Muse Spark. The browser re-encodes both copies, so they carry none of the photo's metadata, such as its location. Before the first photo the app says: "Your photos are sent to Meta's AI models for analysis and may be used to improve them."
- The server never stores a photo. Its cache keeps a SHA-256 fingerprint of each photo with the model's answer (the masks as text, the labels), so a repeated photo's answer can come from the cache instead of a new call. Other requests, such as a room layout or a typed request, are cached as sent, with their answers.
- For the caps, the server sets a random session cookie. It logs each answered request's time, session, route, model, tokens and cost. For the per-minute limit it keeps a salted SHA-256 hash of the visitor's address (never the address itself) with the times of its recent requests, and deletes those rows after a day.
- A shareable layout link holds the room and its pieces in the address itself, after the `#`, so the server keeps nothing for it. It carries no photo and no name the shopper typed.

## Limitations

- Rooms are rectangles with four walls, from photos or from the plan editor.
- Fit is checked on the floor plan. Each piece is the rectangle of its width and depth, so a round table counts as its square and nothing slides under another piece, though pieces may stand on a rug; height matters only for the window warning.
- Measured so far: on a generated 420 × 360 cm example room with both walls taped, windows came within 1 cm; a door read 100 cm against 90 cm and one edit in the plan fixes it. With only wall A taped, as in the app's example, wall B read 362 ± 9 cm against 360 cm. On eight public-domain (CC0) room photos, FitRoom picked the right floor type on 6 and asked for a retake on the 2 it could not read; the wall colour came within ΔE 10 of the photo on 3 of the 6 rooms it built (on all 6 once the photo's exposure is set aside: the 3D view lights the room itself). Its accuracy on real phone photos against a tape measure has not been assessed.
- An open door leaf can hide its doorway in a photo; when no opening is found, the app asks the shopper to tap the door.
- Demo mode answers only its recorded requests on the sample room and the example room; everything else needs Live AI, which is capped.
- The catalog is a sample store: product names and prices are invented for the demo, and each size matches its model within 1 cm. A store can't upload its own catalog yet, so the "See it in your room" button exists only on the demo store's pages.

## What's next

- Sending a finished layout to the store with one link, pieces and prices included.
- The "See it in your room" button on a store's own product pages, beyond the demo store's.
- A catalog upload screen for stores, with Muse Spark tagging each product by style, colour and room type.
- A room from a floor-plan image, and styles from an inspiration photo.
- More room shapes (L-shaped, open plan) and room types (bedroom, dining).
- Bring your own piece: a photo plus its width, depth and height. The fit engine would check it, including whether it gets through the door.
- Erasing the furniture already standing in a photo.

## Credits

The downloaded 3D models, the textures and the HDRI are all CC0 (public domain); the credits are a courtesy. Per-file credits are in [CREDITS.md](CREDITS.md).

| Product in the app             | Model                     | Author                       | Source                                                                                                       |
| ------------------------------ | ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Chester Leather Sofa           | Sofa 02                   | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/sofa_02)                                                                |
| Heritage Grand Sofa            | Sofa 03                   | Fran Calvente                | [Poly Haven](https://polyhaven.com/a/sofa_03)                                                                |
| Provence Loveseat              | Sofa 01                   | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/Sofa_01)                                                                |
| Orbit Swivel Lounge Chair      | Mid Century Lounge Chair  | Kuutti Siitonen              | [Poly Haven](https://polyhaven.com/a/mid_century_lounge_chair)                                               |
| Nord Leather Armchair          | Modern Arm Chair 01       | Vibrant Nordic               | [Poly Haven](https://polyhaven.com/a/modern_arm_chair_01)                                                    |
| Bloom Velvet Lounge Chair      | Sheen Chair               | Eric Chadwick (Wayfair, LLC) | [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair) |
| Victoria Accent Chair          | Green Chair 01            | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/GreenChair_01)                                                          |
| Provence Armchair              | Arm Chair 01              | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/ArmChair_01)                                                            |
| Chester Ottoman                | Ottoman 01                | Caspian Fortune              | [Poly Haven](https://polyhaven.com/a/Ottoman_01)                                                             |
| Slate Coffee Table             | Modern Coffee Table 01    | Amin                         | [Poly Haven](https://polyhaven.com/a/modern_coffee_table_01)                                                 |
| Luna Marble Coffee Table       | Coffee Table Round 01     | Ulan Cabanilla               | [Poly Haven](https://polyhaven.com/a/coffee_table_round_01)                                                  |
| Pine Side Table                | Side Table 01             | James Ray Cock               | [Poly Haven](https://polyhaven.com/a/side_table_01)                                                          |
| Rhythm TV Unit                 | Modern Wooden Cabinet     | Patrik Pangerl               | [Poly Haven](https://polyhaven.com/a/modern_wooden_cabinet)                                                  |
| Cube Shelf 3×3                 | Wooden Display Shelves 01 | James Ray Cock               | [Poly Haven](https://polyhaven.com/a/wooden_display_shelves_01)                                              |
| Alocasia in Terracotta         | Potted Plant 02           | Rico Cilliers                | [Poly Haven](https://polyhaven.com/a/potted_plant_02)                                                        |
| Vintage Painted Settee         | Painted Wooden Sofa       | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/painted_wooden_sofa)                                                    |
| Vintage Wooden Daybed          | Vintage Day Bed           | Aron Łyczek                  | [Poly Haven](https://polyhaven.com/a/vintage_day_bed)                                                        |
| Classic Rocking Chair          | Rockingchair 01           | Jorge Camacho                | [Poly Haven](https://polyhaven.com/a/Rockingchair_01)                                                        |
| Round Oak Dining Table         | Round Wooden Table 01     | Ulan Cabanilla               | [Poly Haven](https://polyhaven.com/a/round_wooden_table_01)                                                  |
| Farmhouse Painted Dining Table | Painted Wooden Table      | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/painted_wooden_table)                                                   |
| Country Painted Dining Chair   | Painted Wooden Chair 01   | Kuutti Siitonen              | [Poly Haven](https://polyhaven.com/a/painted_wooden_chair_01)                                                |
| High-Back Painted Dining Chair | Painted Wooden Chair 02   | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/painted_wooden_chair_02)                                                |
| Duo Square Coffee Table        | Modern Coffee Table 02    | Amin                         | [Poly Haven](https://polyhaven.com/a/modern_coffee_table_02)                                                 |
| Industrial Loft Side Table     | Industrial Coffee Table   | Ulan Cabanilla               | [Poly Haven](https://polyhaven.com/a/industrial_coffee_table)                                                |
| Atelier Long Coffee Table      | Coffee Table 01           | Fernando Quinn               | [Poly Haven](https://polyhaven.com/a/CoffeeTable_01)                                                         |
| Gothic Carved Double Bed       | Gothic Bed 01             | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/GothicBed_01)                                                           |
| Gothic Carved Armoire          | Gothic Cabinet 01         | Kirill Sannikov              | [Poly Haven](https://polyhaven.com/a/GothicCabinet_01)                                                       |
| Vintage Panel Cabinet          | Vintage Cabinet 01        | Rico Cilliers                | [Poly Haven](https://polyhaven.com/a/vintage_cabinet_01)                                                     |
| Compact Oak Bookcase           | Shelf 01                  | Gabriel Radić                | [Poly Haven](https://polyhaven.com/a/Shelf_01)                                                               |
| Steel Frame Double Bookcase    | Steel Frame Shelves 01    | James Ray Cock               | [Poly Haven](https://polyhaven.com/a/steel_frame_shelves_01)                                                 |
| Steel Frame Single Bookcase    | Steel Frame Shelves 02    | James Ray Cock               | [Poly Haven](https://polyhaven.com/a/steel_frame_shelves_02)                                                 |
| Tall Drawer Chest              | Drawer Cabinet            | Ulan Cabanilla               | [Poly Haven](https://polyhaven.com/a/drawer_cabinet)                                                         |
| Oak Console TV Stand           | Wooden Table 03           | Gabriel Radić                | [Poly Haven](https://polyhaven.com/a/WoodenTable_03)                                                         |
| Vintage Chest TV Stand         | Vintage Wooden Drawer 01  | James Ray Cock               | [Poly Haven](https://polyhaven.com/a/vintage_wooden_drawer_01)                                               |

- The Oslo rugs, wardrobe, bed and sofa and the Aria floor lamp are built in code and are FitRoom's own (all rights reserved). The rugs, the sofa, the bed's linen and the lamp's shade use ambientCG textures.
- Textures from [ambientCG](https://ambientcg.com): WoodFloor039, WoodFloor051, WoodFloor064, WoodFloor070, WoodFloor071, Tiles107, Tiles139, Carpet012, Carpet015, Carpet016, PaintedPlaster017, Wallpaper002A, Concrete034, Fabric036, Fabric039, Fabric040, Fabric061, Fabric075.
- HDRI: [Lebombo](https://polyhaven.com/a/lebombo) by Greg Zaal, Poly Haven.
- Test data: SAM 3.1 answers recorded from eight CC0 room photos on Wikimedia Commons by Jarosław Ceborski, Carlos ZGZ, Artchapiz, Profpcde, Paikan06, Lo, Wilfredor and Andy Li. The photos are not in this repository.
- `@meta-sam/parser` by Meta, under the SAM License; a copy ships in `client/public/licenses/SAM-LICENSE.txt`.
- Libraries: three.js, Hono, Ajv and exifr (MIT), dotenv (BSD-2-Clause), Vite and TypeScript for the build. Typeface: Nunito, SIL Open Font License 1.1, via Fontsource. The licence texts of the nine npm packages in the browser bundle ship with the app at `/licenses/THIRD-PARTY-NOTICES.txt`, written by the build, and Nunito's at `/licenses/OFL-1.1-Nunito.txt`; the Credits dialog links both. The server's packages are listed in [CREDITS.md](CREDITS.md).

## License

Copyright © 2026 MUHAMMED TAHA AKTAŞ. All rights reserved: the source is published to be read, not reused (see `LICENSE`). Assets and libraries keep their own licences (Credits above).
