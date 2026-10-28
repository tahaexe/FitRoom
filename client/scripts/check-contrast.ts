/**
 * `npm run check:contrast` — readable-button contrast check (no browser,
 * no Meta calls).
 *
 * - Reads the live `--coral` / `--green` / `--muted` tokens from
 *   `client/src/style.css` (`:root`, the single source of truth);
 * - computes the WCAG 2.1 contrast ratio for every text/background token
 *   pair the CSS uses on filled buttons, chips, badges, pills and the
 *   header (white on each action fill + hover/pressed, the coral wordmark
 *   on white, green status text on white, muted text on white and on the
 *   side-panel grey);
 * - asserts each pair measures at least 4.5:1, and that the light coral
 *   accent still exists for outlines, rings and accents (never as text).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "style.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function token(name: string): string | null {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  return match?.[1]?.toLowerCase() ?? null;
}

function luminance(hex: string): number {
  const toLin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin(parseInt(hex.slice(1, 3), 16));
  const g = toLin(parseInt(hex.slice(3, 5), 16));
  const b = toLin(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const l1 = Math.max(luminance(a), luminance(b));
  const l2 = Math.min(luminance(a), luminance(b));
  return (l1 + 0.05) / (l2 + 0.05);
}

const coral = token("--coral");
const coralHover = token("--coral-hover");
const coralPressed = token("--coral-pressed");
const coralBright = token("--coral-bright");
const green = token("--green");
const muted = token("--muted");
const panelBg = token("--panel-bg") ?? "#f2f1f0";
const white = "#ffffff";

check("coral token is readable", coral !== null, coral ?? "missing --coral");
check("coral hover token is readable", coralHover !== null, coralHover ?? "missing");
check("coral pressed token is readable", coralPressed !== null, coralPressed ?? "missing");
check("green token is readable", green !== null, green ?? "missing --green");
check("muted token is readable", muted !== null, muted ?? "missing --muted");
check("light coral accent is kept", coralBright === "#f54e49", coralBright ?? "missing");

interface Pair {
  name: string;
  text: string;
  background: string;
  usedBy: string;
}

const pairs: Pair[] =
  coral === null || coralHover === null || coralPressed === null || green === null || muted === null
    ? []
    : [
        {
          name: "white on coral fill",
          text: white,
          background: coral,
          usedBy: "btn-primary, btn-cart, active chip, active toolbar pill",
        },
        {
          name: "white on coral hover",
          text: white,
          background: coralHover,
          usedBy: ":hover of the action fills",
        },
        {
          name: "white on coral pressed",
          text: white,
          background: coralPressed,
          usedBy: ":active of the action fills",
        },
        {
          name: "white on green fill",
          text: white,
          background: green,
          usedBy: "fit-badge[data-state=good] Everything fits",
        },
        {
          name: "coral wordmark on white",
          text: coral,
          background: white,
          usedBy: ".wordmark in the 64px top bar (24px desktop, 18px phone)",
        },
        {
          name: "green status on white",
          text: green,
          background: white,
          usedBy: ".api-status[data-state=ok], .fit-fits-label",
        },
        {
          name: "muted on white",
          text: muted,
          background: white,
          usedBy: "card/pill secondary text, .api-status",
        },
        {
          name: "muted on side-panel grey",
          text: muted,
          background: panelBg,
          usedBy: ".live-option inactive Live AI, .chips context",
        },
      ];

check(
  "contrast pairs cover buttons, chips, badges, pills and header",
  pairs.length === 8,
  `${String(pairs.length)} pairs`,
);

for (const pair of pairs) {
  const value = ratio(pair.text, pair.background);
  check(
    `${pair.name} is at least 4.5:1`,
    value >= 4.5,
    `${pair.text} on ${pair.background} = ${value.toFixed(2)}:1 (${pair.usedBy})`,
  );
}

check("guide ring keeps the light coral accent", css.includes("var(--coral-bright)"), "style.css");
check("toolbar markup exists for the width bar", html.includes("bottom-toolbar"), "index.html");

if (failures > 0) {
  console.log(`check:contrast: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:contrast: all checks passed");
}
