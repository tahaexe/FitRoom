/**
 * First-open overlay: "Set up your room" over the softly blurred sample
 * room, plus the one-short-screen room size form.
 *
 * Pure unit work lives in `room-units.ts`; this module only builds DOM and
 * reports the shopper's choice through callbacks.
 */

import {
  ceilingLimitMessage,
  detectDefaultUnit,
  detectSlip,
  echoForRaw,
  formatCmAsFtIn,
  parseLengthToCm,
  sideLimitMessage,
  sidesLimitLine,
  validateCeiling,
  validateSide,
  type SizeUnit,
  type SlipSuggestion,
} from "./room-units";

export interface RoomSize {
  widthCm: number;
  lengthCm: number;
  ceilingCm: number;
}

export interface FirstOpenCallbacks {
  onUsePhotos: () => void;
  onExploreSample: () => void;
  onBuildRoom: (size: RoomSize) => void;
  onShapeInEditor: (size: RoomSize | null) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Small furnished-sample picture: top-view plan of the 420 x 360 room. */
function sampleThumb(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 210 180");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Top view of the furnished sample room, 420 by 360 centimetres");
  svg.classList.add("setup-thumb");
  const room = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  room.setAttribute("x", "8");
  room.setAttribute("y", "8");
  room.setAttribute("width", "194");
  room.setAttribute("height", "164");
  room.setAttribute("rx", "8");
  room.setAttribute("class", "setup-thumb-room");
  svg.appendChild(room);
  const blocks: Array<[number, number, number, number, string]> = [
    [18, 18, 84, 34, "setup-thumb-sofa"],
    [18, 60, 60, 44, "setup-thumb-bed"],
    [120, 18, 72, 52, "setup-thumb-table"],
    [120, 120, 40, 40, "setup-thumb-chair"],
    [164, 120, 28, 40, "setup-thumb-chair"],
  ];
  for (const [x, y, w, h, cls] of blocks) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    r.setAttribute("rx", "4");
    r.setAttribute("class", cls);
    svg.appendChild(r);
  }
  return svg;
}

export class FirstOpen {
  readonly element: HTMLElement;
  private readonly cardsView: HTMLElement;
  private readonly sizeView: HTMLElement;
  private unit: SizeUnit;
  private widthInput!: HTMLInputElement;
  private lengthInput!: HTMLInputElement;
  private ceilingInput!: HTMLInputElement;
  private widthEcho!: HTMLElement;
  private lengthEcho!: HTMLElement;
  private ceilingEcho!: HTMLElement;
  private widthError!: HTMLElement;
  private lengthError!: HTMLElement;
  private ceilingError!: HTMLElement;
  private slipRow!: HTMLElement;
  private buildBtn!: HTMLButtonElement;
  private buildReason!: HTMLElement;
  private planSvg!: SVGSVGElement;
  private planRect!: SVGRectElement;
  private planW!: SVGTextElement;
  private planL!: SVGTextElement;
  private unitCmBtn!: HTMLButtonElement;
  private unitFtBtn!: HTMLButtonElement;

  constructor(private readonly callbacks: FirstOpenCallbacks) {
    this.unit =
      typeof navigator === "undefined" ? "cm" : detectDefaultUnit(navigator.language ?? "");
    this.element = el("div", "first-open");
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Set up your room");
    this.element.setAttribute("hidden", "");

    const panel = el("div", "setup-panel");
    this.cardsView = el("div", "setup-cards");
    this.sizeView = el("div", "setup-size");
    this.sizeView.setAttribute("hidden", "");
    panel.append(this.cardsView, this.sizeView);
    this.element.appendChild(panel);
    this.buildCards();
    this.buildSize();
  }

  showCards(): void {
    this.element.removeAttribute("hidden");
    this.cardsView.removeAttribute("hidden");
    this.sizeView.setAttribute("hidden", "");
  }

  showSize(): void {
    this.element.removeAttribute("hidden");
    this.cardsView.setAttribute("hidden", "");
    this.sizeView.removeAttribute("hidden");
    this.refreshEchoes();
    window.setTimeout(() => this.widthInput.focus(), 0);
  }

  hide(): void {
    this.element.setAttribute("hidden", "");
  }

  get visible(): boolean {
    return !this.element.hasAttribute("hidden");
  }

  private buildCards(): void {
    this.cardsView.innerHTML = "";
    const title = el("h2", "setup-title", "Set up your room");
    const sub = el(
      "p",
      "setup-sub",
      "Tell us your room size, use photos, or explore the sample room.",
    );
    const grid = el("div", "setup-grid");

    const sizeCard = el("article", "setup-card setup-card-main");
    sizeCard.append(
      el("h3", "setup-card-title", "Enter my room size"),
      el("p", "setup-card-text", "Type your width and length; build in seconds."),
    );
    const sizeBtn = el("button", "setup-go", "Enter my room size");
    sizeBtn.type = "button";
    sizeBtn.addEventListener("click", () => this.showSize());
    sizeCard.appendChild(sizeBtn);

    const photoCard = el("article", "setup-card");
    photoCard.append(
      el("h3", "setup-card-title", "Use photos"),
      el("p", "setup-card-text", "Uses Live AI to measure your walls from photos."),
    );
    const photoBtn = el("button", "setup-secondary", "Use photos");
    photoBtn.type = "button";
    photoBtn.addEventListener("click", () => this.callbacks.onUsePhotos());
    photoCard.appendChild(photoBtn);

    const sampleCard = el("article", "setup-card");
    sampleCard.append(
      el("h3", "setup-card-title", "Explore a sample room · 420 × 360 cm"),
      sampleThumb(),
      el("p", "setup-card-text", "See the furnished demo right away."),
    );
    const sampleBtn = el("button", "setup-secondary", "Explore the sample");
    sampleBtn.type = "button";
    sampleBtn.addEventListener("click", () => this.callbacks.onExploreSample());
    sampleCard.appendChild(sampleBtn);

    grid.append(sizeCard, photoCard, sampleCard);
    this.cardsView.append(title, sub, grid);
  }

  private unitToggle(): HTMLElement {
    const wrap = el("div", "size-units");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Size units");
    this.unitCmBtn = el("button", "size-unit", "cm");
    this.unitCmBtn.type = "button";
    this.unitFtBtn = el("button", "size-unit", "ft-in");
    this.unitFtBtn.type = "button";
    this.unitCmBtn.addEventListener("click", () => this.setUnit("cm"));
    this.unitFtBtn.addEventListener("click", () => this.setUnit("ftin"));
    wrap.append(this.unitCmBtn, this.unitFtBtn);
    this.paintUnit();
    return wrap;
  }

  private setUnit(unit: SizeUnit): void {
    this.unit = unit;
    this.paintUnit();
    this.refreshEchoes();
  }

  private paintUnit(): void {
    if (this.unitCmBtn === undefined) return;
    this.unitCmBtn.dataset["active"] = String(this.unit === "cm");
    this.unitFtBtn.dataset["active"] = String(this.unit === "ftin");
    this.unitCmBtn.setAttribute("aria-pressed", String(this.unit === "cm"));
    this.unitFtBtn.setAttribute("aria-pressed", String(this.unit === "ftin"));
  }

  private field(
    labelText: string,
    placeholder: string,
    errorId: string,
  ): { wrap: HTMLElement; input: HTMLInputElement; echo: HTMLElement; error: HTMLElement } {
    const wrap = el("div", "size-field");
    const label = el("label", "size-label", labelText);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("aria-label", labelText);
    const echo = el("p", "size-echo");
    echo.setAttribute("aria-live", "polite");
    const error = el("p", "size-error");
    error.id = errorId;
    label.appendChild(input);
    wrap.append(label, echo, error);
    return { wrap, input, echo, error };
  }

  private buildSize(): void {
    this.sizeView.innerHTML = "";
    const form = document.createElement("form");
    form.className = "size-form";
    form.noValidate = true;

    const head = el("div", "size-head");
    head.append(el("h2", "setup-title", "Enter my room size"), this.unitToggle());
    form.appendChild(head);

    const width = this.field("Width", "e.g. 420", "size-width-error");
    const length = this.field("Length", "e.g. 420", "size-length-error");
    this.widthInput = width.input;
    this.lengthInput = length.input;
    this.widthEcho = width.echo;
    this.lengthEcho = length.echo;
    this.widthError = width.error;
    this.lengthError = length.error;
    this.widthInput.required = true;
    this.lengthInput.required = true;
    const row = el("div", "size-row");
    row.append(width.wrap, length.wrap);
    form.appendChild(row);

    const more = document.createElement("details");
    more.className = "size-more";
    const summary = document.createElement("summary");
    summary.textContent = "More";
    more.appendChild(summary);
    const ceiling = this.field("Ceiling height", "e.g. 250", "size-ceiling-error");
    this.ceilingInput = ceiling.input;
    this.ceilingEcho = ceiling.echo;
    this.ceilingError = ceiling.error;
    this.ceilingInput.value = this.unit === "cm" ? "250" : `8'2"`;
    more.appendChild(ceiling.wrap);
    form.appendChild(more);

    const hint = el("p", "size-hint", "Measure wall to wall at floor level.");
    form.appendChild(hint);

    this.slipRow = el("div", "size-slip");
    this.slipRow.setAttribute("hidden", "");
    form.appendChild(this.slipRow);

    const planWrap = el("div", "size-plan");
    planWrap.setAttribute("aria-label", "Top view of your room size");
    this.planSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.planSvg.setAttribute("viewBox", "0 0 320 220");
    this.planSvg.classList.add("size-plan-svg");
    this.planSvg.setAttribute("role", "img");
    this.planSvg.setAttribute("aria-label", "Top view of the typed rectangle");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("rx", "8");
    rect.setAttribute("class", "size-plan-rect");
    this.planRect = rect;
    this.planW = document.createElementNS("http://www.w3.org/2000/svg", "text");
    this.planW.setAttribute("text-anchor", "middle");
    this.planW.setAttribute("class", "size-plan-label");
    this.planL = document.createElementNS("http://www.w3.org/2000/svg", "text");
    this.planL.setAttribute("text-anchor", "start");
    this.planL.setAttribute("class", "size-plan-label");
    this.planSvg.append(rect, this.planW, this.planL);
    planWrap.appendChild(this.planSvg);
    form.appendChild(planWrap);

    const build = el("button", "setup-go setup-sticky", "Build my room");
    build.type = "submit";
    this.buildBtn = build;
    form.appendChild(build);
    this.buildReason = el("p", "size-build-reason");
    this.buildReason.setAttribute("aria-live", "polite");
    form.appendChild(this.buildReason);

    const shape = el("button", "setup-link", "Not a rectangle? Shape it in the plan editor");
    shape.type = "button";
    shape.addEventListener("click", () => {
      this.callbacks.onShapeInEditor(this.currentSize());
    });
    form.appendChild(shape);

    for (const input of [this.widthInput, this.lengthInput, this.ceilingInput]) {
      input.addEventListener("input", () => this.refreshEchoes());
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.sizeView.appendChild(form);
    this.paintUnit();
    this.refreshEchoes();
  }

  private parsed(input: HTMLInputElement): number | null {
    return parseLengthToCm(input.value);
  }

  private currentSize(): RoomSize | null {
    const w = this.parsed(this.widthInput);
    const l = this.parsed(this.lengthInput);
    const c = this.parsed(this.ceilingInput);
    if (w === null || l === null || c === null) return null;
    if (
      validateSide("width", w, this.unit) !== null ||
      validateSide("length", l, this.unit) !== null ||
      validateCeiling(c, this.unit) !== null
    ) {
      return null;
    }
    return { widthCm: w, lengthCm: l, ceilingCm: c };
  }

  /** Live limit message under a side field: empty while typing, else at once. */
  private sideError(field: "width" | "length", raw: string, cm: number | null): string {
    if (raw.trim() === "") return "";
    if (cm === null) return sideLimitMessage(field, this.unit);
    return validateSide(field, cm, this.unit) ?? "";
  }

  private refreshEchoes(): void {
    const wRaw = this.widthInput.value;
    const lRaw = this.lengthInput.value;
    const cRaw = this.ceilingInput.value;
    const w = this.parsed(this.widthInput);
    const l = this.parsed(this.lengthInput);
    const c = this.parsed(this.ceilingInput);
    // The echo always shows the other unit of what was typed.
    this.widthEcho.textContent = w === null ? "" : echoForRaw(wRaw, w);
    this.lengthEcho.textContent = l === null ? "" : echoForRaw(lRaw, l);
    if (c === null && cRaw.trim() === "") {
      const prefill = this.unit === "cm" ? "250" : `8'2"`;
      this.ceilingEcho.textContent = echoForRaw(prefill, 250);
    } else {
      this.ceilingEcho.textContent = c === null ? "" : echoForRaw(cRaw, c);
    }
    // Limits show under the field at once, in the visitor's unit.
    this.widthError.textContent = this.sideError("width", wRaw, w);
    this.lengthError.textContent = this.sideError("length", lRaw, l);
    if (cRaw.trim() === "") {
      this.ceilingError.textContent = "";
    } else if (c === null) {
      this.ceilingError.textContent = ceilingLimitMessage(this.unit);
    } else {
      this.ceilingError.textContent = validateCeiling(c, this.unit) ?? "";
    }
    // A likely slip asks with a "Use …" button, never changing the value.
    const wSlip = w === null ? null : detectSlip(wRaw, w, "side", this.unit);
    const lSlip = l === null ? null : detectSlip(lRaw, l, "side", this.unit);
    if (wSlip !== null) {
      this.showSlip(this.widthInput, wSlip);
    } else if (lSlip !== null) {
      this.showSlip(this.lengthInput, lSlip);
    } else {
      this.slipRow.setAttribute("hidden", "");
      this.slipRow.innerHTML = "";
    }
    // "Build my room" stays disabled until both sides are valid, saying why.
    const wOk = w !== null && validateSide("width", w, this.unit) === null;
    const lOk = l !== null && validateSide("length", l, this.unit) === null;
    const ready = wOk && lOk;
    this.buildBtn.toggleAttribute("disabled", !ready);
    if (ready) {
      this.buildReason.textContent = "";
    } else if (wRaw.trim() === "" && lRaw.trim() === "") {
      this.buildReason.textContent = "Enter your width and length to build your room.";
    } else {
      this.buildReason.textContent = `${sidesLimitLine(this.unit)} to build your room.`;
    }
    // Live top view with both sizes; falls back to the sample 420 x 360.
    const showW = w ?? 420;
    const showL = l ?? 360;
    this.planW.textContent = this.unit === "cm" ? `${String(showW)} cm` : formatCmAsFtIn(showW);
    this.planL.textContent = this.unit === "cm" ? `${String(showL)} cm` : formatCmAsFtIn(showL);
    this.paintPlan(showW, showL);
  }

  /**
   * The top view draws the rectangle to scale (both sides in proportion),
   * centred in the frame with both labels outside the shape.
   */
  private paintPlan(showW: number, showL: number): void {
    const left = 24;
    const top = 30;
    const areaW = 216;
    const areaH = 160;
    const scale = Math.min(areaW / Math.max(1, showW), areaH / Math.max(1, showL));
    const rectW = Math.max(1, showW * scale);
    const rectH = Math.max(1, showL * scale);
    const x = left + (areaW - rectW) / 2;
    const y = top + (areaH - rectH) / 2;
    const round1 = (value: number): string => String(Math.round(value * 10) / 10);
    this.planRect.setAttribute("x", round1(x));
    this.planRect.setAttribute("y", round1(y));
    this.planRect.setAttribute("width", round1(rectW));
    this.planRect.setAttribute("height", round1(rectH));
    this.planW.setAttribute("x", round1(x + rectW / 2));
    this.planW.setAttribute("y", round1(y - 8));
    this.planL.setAttribute("x", round1(x + rectW + 8));
    this.planL.setAttribute("y", round1(y + rectH / 2 + 5));
  }

  private submit(): void {
    this.widthError.textContent = "";
    this.lengthError.textContent = "";
    this.ceilingError.textContent = "";
    this.slipRow.innerHTML = "";
    this.slipRow.setAttribute("hidden", "");

    const wRaw = this.widthInput.value;
    const lRaw = this.lengthInput.value;
    const cRaw = this.ceilingInput.value.trim() === "" ? "250" : this.ceilingInput.value;
    const w = parseLengthToCm(wRaw);
    const l = parseLengthToCm(lRaw);
    const c = parseLengthToCm(cRaw);

    let failed = false;
    if (wRaw.trim() === "") {
      this.widthError.textContent = "Width is required";
      failed = true;
    } else if (w === null) {
      this.widthError.textContent = sideLimitMessage("width", this.unit);
      failed = true;
    } else {
      const slip = detectSlip(wRaw, w, "side", this.unit);
      if (slip !== null) {
        this.showSlip(this.widthInput, slip);
        failed = true;
      } else {
        const err = validateSide("width", w, this.unit);
        if (err !== null) {
          this.widthError.textContent = err;
          failed = true;
        }
      }
    }
    if (lRaw.trim() === "") {
      this.lengthError.textContent = "Length is required";
      failed = true;
    } else if (l === null) {
      this.lengthError.textContent = sideLimitMessage("length", this.unit);
      failed = true;
    } else {
      const slip = detectSlip(lRaw, l, "side", this.unit);
      if (slip !== null && this.slipRow.hasAttribute("hidden")) {
        this.showSlip(this.lengthInput, slip);
        failed = true;
      } else if (slip === null) {
        const err = validateSide("length", l, this.unit);
        if (err !== null) {
          this.lengthError.textContent = err;
          failed = true;
        } else if (this.slipRow.hasAttribute("hidden") === false) {
          failed = true;
        }
      } else {
        failed = true;
      }
    }
    if (c === null) {
      this.ceilingError.textContent = ceilingLimitMessage(this.unit);
      failed = true;
    } else {
      const err = validateCeiling(c, this.unit);
      if (err !== null) {
        this.ceilingError.textContent = err;
        failed = true;
      }
    }
    if (failed || w === null || l === null || c === null) return;
    this.callbacks.onBuildRoom({ widthCm: w, lengthCm: l, ceilingCm: c });
  }

  private showSlip(input: HTMLInputElement, slip: SlipSuggestion): void {
    const suggestedCm = slip.suggestedCm;
    const message = slip.message;
    const action = slip.action;
    this.slipRow.innerHTML = "";
    this.slipRow.removeAttribute("hidden");
    const text = el("span", "size-slip-text", message);
    const btn = el("button", "setup-secondary", action);
    btn.type = "button";
    btn.addEventListener("click", () => {
      input.value = String(suggestedCm);
      this.slipRow.setAttribute("hidden", "");
      this.slipRow.innerHTML = "";
      this.refreshEchoes();
      input.focus();
    });
    this.slipRow.append(text, btn);
  }
}
