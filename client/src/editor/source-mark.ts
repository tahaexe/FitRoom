/**
 * Source mark: where a length or size value came from.
 *
 * - "measured": typed by the shopper, tape icon, primary text.
 * - "estimated": muted grey with an optional "± n cm" tolerance, reserved
 *   for photo drafts (a later step); the manual editor always passes
 *   "measured".
 */

export type ValueSource = "measured" | "estimated";

export function sourceMark(source: ValueSource, toleranceCm?: number): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "source-mark";
  mark.dataset["source"] = source;
  if (source === "measured") {
    const label =
      toleranceCm === undefined ? "Measured" : `Measured ± ${String(Math.round(toleranceCm))} cm`;
    mark.setAttribute("title", `${label}: typed by you`);
    mark.appendChild(tapeIcon());
    const text = document.createElement("span");
    text.textContent = label;
    mark.appendChild(text);
  } else {
    const text =
      toleranceCm === undefined ? "Estimated" : `Estimated ± ${String(Math.round(toleranceCm))} cm`;
    mark.setAttribute("title", text);
    mark.textContent = text;
  }
  return mark;
}

function tapeIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const tape = document.createElementNS(NS, "path");
  tape.setAttribute("d", "M1 5h10a3 3 0 0 1 3 3v3H4a3 3 0 0 1-3-3V5z");
  tape.setAttribute("fill", "none");
  tape.setAttribute("stroke", "currentColor");
  tape.setAttribute("stroke-width", "1.5");
  svg.appendChild(tape);
  for (const x of [5, 8, 11]) {
    const tick = document.createElementNS(NS, "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("y1", "5");
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y2", "7.5");
    tick.setAttribute("stroke", "currentColor");
    tick.setAttribute("stroke-width", "1.2");
    svg.appendChild(tick);
  }
  return svg;
}
