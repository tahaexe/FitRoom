/**
 * Recommendation panel: category advice, "What fits here?" for a free
 * wall run, or "Find a replacement" for the selected piece, powered by
 * `POST /api/recommend`.
 *
 * Flow: free-space analysis of the current scene → size-fitting candidates
 * with proposed spots (shared code) → when no candidate fits, a local
 * message with sizes and no model call → otherwise the request goes to
 * `/api/recommend` → each ranked item is placed virtually at its spot and
 * checked; failing items are dropped. "Place it" commits the spot as one
 * undo step (replacing a conflicting same-category accessory);
 * "Swap it" replaces the selected piece as one undo step.
 */

import type {
  CatalogCategory,
  CatalogItem,
  FitIssue,
  FreeRun,
  RecommendAnswer,
  RecommendCandidate,
  RecommendCategory,
  RecommendRequest,
  RoomLayout,
  SceneItem,
  SceneState,
} from "@fitroom/shared";
import {
  analyzeFreeSpace,
  buildRecommendRequest,
  isRecommendAnswer,
  nothingFitsMessage,
  recommendIgnoreIds,
  replacementOfferFor,
  runDisplayLabel,
  wallDisplayName,
  type CandidateQuery,
} from "@fitroom/shared";
import { LIVE_CHANGE_EVENT, isLive, postRecommend, requestLive, type ApiResult } from "../api";
import {
  AI_UNREACHABLE,
  CANCEL,
  CANCELLED,
  NOT_READY_MESSAGE,
  RECOMMEND_LOADING,
  TURN_ON_LIVE,
  USE_SAMPLE_ROOM,
} from "../copy";
import { formatCatalogPrice, formatCatalogSize } from "../catalog-ui";

const CATEGORIES: Array<Exclude<RecommendCategory, "any">> = [
  "sofa",
  "armchair",
  "dining-table",
  "dining-chair",
  "coffee-table",
  "side-table",
  "bed",
  "wardrobe",
  "cabinet",
  "bookcase",
  "storage",
  "tv-unit",
  "ottoman",
  "shelf",
  "decor",
];

/** Readable chip names (never the raw slugs). */
const CATEGORY_LABELS: Record<Exclude<RecommendCategory, "any">, string> = {
  sofa: "Sofas",
  armchair: "Armchairs",
  ottoman: "Ottomans",
  "coffee-table": "Coffee tables",
  "side-table": "Side tables",
  "tv-unit": "TV units",
  shelf: "Shelves",
  decor: "Decor",
  "dining-table": "Dining tables",
  "dining-chair": "Dining chairs",
  bed: "Beds",
  wardrobe: "Wardrobes",
  cabinet: "Cabinets",
  bookcase: "Bookcases",
  storage: "Storage",
  rug: "Rugs",
};

export interface RecommendDeps {
  room: RoomLayout;
  catalog: CatalogItem[];
  getScene: () => SceneState;
  checkItems: (items: SceneItem[]) => FitIssue[];
  placeItem: (productId: string, x: number, z: number, rotationY: number) => void;
  swapItem: (
    oldInstanceId: string,
    productId: string,
    x: number,
    z: number,
    rotationY: number,
  ) => void;
  selectItem: (instanceId: string | null) => void;
  /** Bring the Recommend panel back to the front (selection shows the Inspector). */
  showRecommend: () => void;
  resetDemoRoom: () => void;
  hoverRun: (run: FreeRun | null) => void;
}

interface ShownItem {
  candidate: RecommendCandidate;
  entry: CatalogItem;
  reason: string;
}

function issueKey(issue: FitIssue): string {
  return `${issue.type}|${[...issue.itemIds].sort().join(",")}`;
}

function modelLabel(model: string): string {
  return model.startsWith("muse-spark") ? "Muse Spark" : model;
}

export class RecommendPanel {
  private readonly deps: RecommendDeps;
  private readonly root: HTMLElement;
  private readonly catalogById: Map<string, CatalogItem>;
  private category: RecommendCategory = "sofa";
  private budget = "";
  private runs: FreeRun[] = [];
  private loading = false;
  private selected: SceneItem | null = null;

  constructor(host: HTMLElement, deps: RecommendDeps) {
    this.deps = deps;
    this.root = host;
    this.catalogById = new Map(deps.catalog.map((c) => [c.id, c]));
    this.root.classList.add("recommend-panel");
    this.render();
    window.addEventListener(LIVE_CHANGE_EVENT, () => this.syncMode());
  }

  /** Redraw the mode (runs + demo-miss card) without losing results. */
  syncMode(): void {
    const live = isLive();
    if (live) {
      for (const b of this.root.querySelectorAll("button.recommend-run")) {
        if (!(b instanceof HTMLButtonElement)) continue;
        if (b.title.includes("needs Live AI")) this.clearRunNeedsLive(b);
      }
    } else {
      this.applyDemoDisabled();
      void this.markUnavailableRuns(this.root);
    }
    for (const b of this.root.querySelectorAll("button.recommend-go")) {
      if (!(b instanceof HTMLButtonElement)) continue;
      if (b.textContent !== TURN_ON_LIVE) continue;
      b.toggleAttribute("hidden", live);
    }
  }

  /** Recompute the free runs (call after the scene changes). */
  refresh(): void {
    const scene = this.deps.getScene();
    const free = analyzeFreeSpace(this.deps.room, scene, this.catalogById);
    this.runs = [...free.runs].sort((a, b) => b.length_cm - a.length_cm);
    this.renderRunList();
  }

  /** Track the 3D selection, offering "Find a replacement" for it. */
  setSelected(item: SceneItem | null): void {
    this.selected = item === null ? null : { ...item, position: { ...item.position } };
    this.renderSelection();
  }

  /** True when adding the probe introduces no new fit error. */
  private passes(
    query: CandidateQuery,
    productId: string,
    position: { x: number; z: number },
    rotationY: number,
  ): boolean {
    const scene = this.deps.getScene();
    const ignore = new Set(recommendIgnoreIds(scene, this.deps.catalog, query));
    const base = new Set<string>();
    const items = scene.items.filter((i) => !ignore.has(i.instanceId));
    for (const issue of this.deps.checkItems(items)) {
      if (issue.severity === "error") base.add(issueKey(issue));
    }
    const probe: SceneItem = {
      instanceId: "recommend-probe",
      productId,
      position: { x: Math.round(position.x * 10) / 10, z: Math.round(position.z * 10) / 10 },
      rotationY,
      variant: "",
    };
    for (const issue of this.deps.checkItems([...items, probe])) {
      if (issue.severity !== "error") continue;
      if (!base.has(issueKey(issue))) return false;
    }
    return true;
  }

  private render(): void {
    this.root.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Recommend";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "recommend-close";
    close.textContent = "×";
    close.title = "Hide recommendations";
    close.addEventListener("click", () => {
      this.root.setAttribute("hidden", "");
      document.getElementById("tool-recommend")?.setAttribute("data-active", "false");
    });
    const head = document.createElement("div");
    head.className = "recommend-head";
    head.append(title, close);
    this.root.appendChild(head);

    const selection = document.createElement("div");
    selection.className = "recommend-selection";
    this.root.appendChild(selection);

    const chips = document.createElement("div");
    chips.className = "chips";
    for (const c of CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = CATEGORY_LABELS[c];
      b.dataset["category"] = c;
      b.dataset["active"] = String(c === this.category);
      b.addEventListener("click", () => {
        this.category = c as CatalogCategory;
        for (const other of chips.querySelectorAll("button")) {
          if (!(other instanceof HTMLButtonElement)) continue;
          other.dataset["active"] = String(other.dataset["category"] === c);
        }
      });
      chips.appendChild(b);
    }
    this.root.appendChild(chips);

    const row = document.createElement("div");
    row.className = "recommend-row";
    const budget = document.createElement("input");
    budget.type = "number";
    budget.name = "recommend-budget";
    budget.min = "0";
    budget.placeholder = "Budget $";
    budget.title = "Budget in USD (optional)";
    budget.setAttribute("aria-label", "Budget in USD (optional)");
    budget.value = this.budget;
    budget.addEventListener("input", () => {
      this.budget = budget.value;
    });
    const go = document.createElement("button");
    go.type = "button";
    go.className = "recommend-go";
    go.textContent = "Recommend";
    go.addEventListener("click", () => void this.askCategory());
    row.append(budget, go);
    this.root.appendChild(row);

    const spotTitle = document.createElement("h3");
    spotTitle.textContent = "What fits here?";
    this.root.appendChild(spotTitle);
    const runs = document.createElement("div");
    runs.className = "recommend-runs";
    this.root.appendChild(runs);

    const out = document.createElement("div");
    out.className = "recommend-results";
    this.root.appendChild(out);
    this.renderSelection();
    this.renderRunList();
  }

  private renderSelection(): void {
    const host = this.root.querySelector(".recommend-selection");
    if (host === null) return;
    host.innerHTML = "";
    if (this.selected === null) return;
    const entry = this.catalogById.get(this.selected.productId);
    const label = document.createElement("p");
    label.className = "recommend-selected";
    label.textContent = `Selected: ${entry?.name ?? this.selected.productId}`;
    const find = document.createElement("button");
    find.type = "button";
    find.className = "recommend-go";
    find.textContent = "Find a replacement";
    find.addEventListener("click", () => void this.askReplacement());
    host.append(label, find);
  }

  private renderRunList(): void {
    const host = this.root.querySelector(".recommend-runs");
    if (host === null) return;
    host.innerHTML = "";
    if (this.runs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "recommend-empty";
      empty.textContent = "No free wall runs right now.";
      host.appendChild(empty);
      return;
    }
    for (const run of this.runs.slice(0, 8)) {
      const name = runDisplayLabel(this.deps.room, run.wall, run.length_cm);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "recommend-run";
      b.textContent = name;
      b.dataset["label"] = name;
      b.title = `What fits on ${name}?`;
      b.dataset["wall"] = wallDisplayName(this.deps.room, run.wall);
      b.dataset["start"] = String(run.start_cm);
      b.dataset["end"] = String(run.end_cm);
      b.addEventListener("mouseenter", () => this.deps.hoverRun(run));
      b.addEventListener("mouseleave", () => this.deps.hoverRun(null));
      b.addEventListener("focus", () => this.deps.hoverRun(run));
      b.addEventListener("blur", () => this.deps.hoverRun(null));
      b.addEventListener("click", () => void this.askSpot(run, b));
      host.appendChild(b);
    }
    void this.markUnavailableRuns(host);
  }

  /** Demo-store spot requests, once loaded (demo mode disables the rest). */
  private recordedSpots: Array<{ wall: string; start_cm: number; end_cm: number }> | null = null;

  private async loadRecordedSpots(): Promise<Array<{
    wall: string;
    start_cm: number;
    end_cm: number;
  }> | null> {
    if (this.recordedSpots !== null) return this.recordedSpots;
    try {
      const res = await fetch("/api/recommend/demo-spots");
      const payload = (await res.json()) as unknown;
      if (
        typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as Record<string, unknown>)["spots"])
      ) {
        const spots = (payload as Record<string, unknown>)["spots"] as unknown[];
        this.recordedSpots = spots.filter(
          (entry): entry is { wall: string; start_cm: number; end_cm: number } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Record<string, unknown>)["wall"] === "string" &&
            typeof (entry as Record<string, unknown>)["start_cm"] === "number" &&
            typeof (entry as Record<string, unknown>)["end_cm"] === "number",
        );
        return this.recordedSpots;
      }
    } catch {
      // Fall through to leaving every entry enabled below.
    }
    return null;
  }

  /**
   * The visible second line under a run with no stored demo answer. The
   * reason never lives in the tooltip alone.
   */
  private setRunNeedsLive(button: HTMLButtonElement): void {
    button.toggleAttribute("disabled", true);
    button.setAttribute("aria-disabled", "true");
    const base = button.dataset["label"] ?? button.textContent ?? "";
    button.title = `${base} — needs Live AI (no stored demo answer)`;
    if (button.querySelector(":scope > .needs-live") === null) {
      const line = document.createElement("span");
      line.className = "needs-live";
      line.textContent = "Needs Live AI";
      button.appendChild(line);
    }
  }

  /** Drop the Live AI line where Live AI enables the run again. */
  private clearRunNeedsLive(button: HTMLButtonElement): void {
    const base = button.dataset["label"] ?? "";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    if (base !== "") button.title = `What fits on ${base}?`;
    button.querySelector(":scope > .needs-live")?.remove();
  }

  /** In demo mode an entry with no stored answer is disabled with a Live AI hint. */
  private async markUnavailableRuns(host: Element): Promise<void> {
    if (isLive()) return;
    const recorded = await this.loadRecordedSpots();
    if (recorded === null) return;
    for (const b of host.querySelectorAll("button.recommend-run")) {
      if (!(b instanceof HTMLButtonElement)) continue;
      const wall = b.dataset["wall"] ?? "";
      const start = Number(b.dataset["start"] ?? "NaN");
      const end = Number(b.dataset["end"] ?? "NaN");
      const known = recorded.some(
        (spot) =>
          spot.wall === wall &&
          Math.abs(spot.start_cm - start) <= 1 &&
          Math.abs(spot.end_cm - end) <= 1,
      );
      if (!known) this.setRunNeedsLive(b);
    }
  }

  /** Re-disable runs with no recorded answer after a send re-enables all. */
  private applyDemoDisabled(): void {
    if (isLive()) return;
    for (const b of this.root.querySelectorAll("button.recommend-run")) {
      if (!(b instanceof HTMLButtonElement)) continue;
      if (b.title.includes("needs Live AI")) this.setRunNeedsLive(b);
    }
  }

  /** Mark one entry as needing Live AI after a demo-miss. */
  private disableRun(button: HTMLButtonElement): void {
    this.setRunNeedsLive(button);
  }

  private loadTimer: ReturnType<typeof setInterval> | null = null;

  private setLoading(on: boolean, controller?: AbortController): void {
    this.loading = on;
    for (const b of this.root.querySelectorAll("button")) {
      // The Cancel button stays live while the request runs.
      if (b.classList.contains("recommend-close") || b.classList.contains("recommend-cancel")) {
        continue;
      }
      b.toggleAttribute("disabled", on);
    }
    if (this.loadTimer !== null) {
      clearInterval(this.loadTimer);
      this.loadTimer = null;
    }
    if (!on) this.applyDemoDisabled();
    const out = this.root.querySelector(".recommend-results");
    if (out !== null && !on) void this.markUnavailableRuns(this.root);
    if (out !== null && on) {
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "recommend-empty";
      p.textContent = RECOMMEND_LOADING;
      out.appendChild(p);
      // The wait line counts seconds like Visualise, with a Cancel button
      // that aborts the request through the signal `postGateway` takes.
      if (controller !== undefined) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "recommend-cancel";
        cancel.textContent = CANCEL;
        cancel.addEventListener("click", () => controller.abort());
        out.appendChild(cancel);
        const startedAt = Date.now();
        this.loadTimer = setInterval(() => {
          const secs = Math.floor((Date.now() - startedAt) / 1000);
          p.textContent = `${RECOMMEND_LOADING} ${String(secs)}s`;
        }, 500);
      }
    }
  }

  private budgetValue(): number | undefined {
    const raw = this.budget.trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private buildRequest(query: CandidateQuery): RecommendRequest {
    return buildRecommendRequest(
      this.deps.room,
      this.deps.getScene(),
      this.deps.catalog,
      query,
      (id, pos, rot) => this.passes(query, id, pos, rot),
    );
  }

  private async askCategory(): Promise<void> {
    if (this.loading) return;
    const query: CandidateQuery = {
      category: this.category,
      budget_usd: this.budgetValue(),
    };
    const request = this.buildRequest(query);
    if (request.candidates.length === 0) {
      this.showNothingFits(this.category, true);
      return;
    }
    await this.ask(request, `No fitting ${this.category} right now.`, { kind: "place" });
  }

  private async askSpot(run: FreeRun, button?: HTMLButtonElement): Promise<void> {
    if (this.loading) return;
    this.deps.hoverRun(run);
    const query: CandidateQuery = {
      category: "any",
      budget_usd: this.budgetValue(),
      spot: { wall: run.wall, start_cm: run.start_cm, end_cm: run.end_cm },
    };
    const request = this.buildRequest(query);
    if (request.candidates.length === 0) {
      this.deps.hoverRun(null);
      this.showSpotEmpty(run);
      return;
    }
    const result = await this.ask(request, "Nothing fits this run right now.", { kind: "place" });
    if (result === null) {
      this.deps.hoverRun(null);
      return;
    }
    if ((result.status === "demo-miss" || result.status === "capped") && button !== undefined) {
      this.disableRun(button);
    }
    this.deps.hoverRun(null);
  }

  private async askReplacement(): Promise<void> {
    if (this.loading || this.selected === null) return;
    const scene = this.deps.getScene();
    const live = scene.items.find((i) => i.instanceId === this.selected?.instanceId);
    if (live === undefined) {
      this.setSelected(null);
      return;
    }
    const entry = this.catalogById.get(live.productId);
    if (entry === undefined) return;
    const query: CandidateQuery = {
      category: entry.category,
      budget_usd: this.budgetValue(),
      replace: {
        productId: live.productId,
        position: { ...live.position },
        rotationY: live.rotationY,
      },
    };
    const request = this.buildRequest(query);
    if (request.candidates.length === 0) {
      this.showNothingFits(entry.category, false);
      return;
    }
    await this.ask(request, `No fitting ${entry.category} right now.`, {
      kind: "swap",
      oldInstanceId: live.instanceId,
    });
  }

  /** Replace-flow entry for the "Replace the <name>" offer. */
  private async askReplacementFor(instanceId: string): Promise<void> {
    if (this.loading) return;
    const scene = this.deps.getScene();
    const live = scene.items.find((i) => i.instanceId === instanceId);
    if (live === undefined) return;
    this.deps.selectItem(instanceId);
    this.setSelected(live);
    // Selecting shows the Inspector; bring Recommend back so the
    // replacements render in place, in this panel, at once.
    this.deps.showRecommend();
    await this.askReplacement();
  }

  private async ask(
    request: RecommendRequest,
    emptyText: string,
    mode: { kind: "place" } | { kind: "swap"; oldInstanceId: string },
  ): Promise<ApiResult | null> {
    const controller = new AbortController();
    this.setLoading(true, controller);
    let result: ApiResult;
    try {
      result = await postRecommend(request as unknown as Record<string, unknown>, {
        signal: controller.signal,
      });
    } catch {
      result = { status: "error", message: AI_UNREACHABLE };
    }
    this.setLoading(false);
    if (controller.signal.aborted) {
      // An aborted request leaves no answer applied; the typed budget kept.
      this.showNotice(CANCELLED, false);
      return null;
    }
    if (result.status === "ok") {
      this.showAnswer(result.data, result.model, emptyText, request, mode);
    } else if (result.status === "demo-miss" || result.status === "capped") {
      this.showNotice(result.message, true);
    } else if (result.status === "not-ready") {
      this.showNotice(NOT_READY_MESSAGE, true);
    } else {
      this.showNotice(result.message, false);
    }
    return result;
  }

  /** No candidates: local message with sizes, no model call. */
  private showNothingFits(category: string, offerReplace: boolean): void {
    const out = this.root.querySelector(".recommend-results");
    if (out === null) return;
    out.innerHTML = "";
    const scene = this.deps.getScene();
    const free = analyzeFreeSpace(this.deps.room, scene, this.catalogById);
    const p = document.createElement("p");
    p.className = "recommend-empty";
    p.textContent = nothingFitsMessage(category, this.deps.room, free, this.deps.catalog);
    out.appendChild(p);
    if (!offerReplace) return;
    const offer = replacementOfferFor(category, scene, this.deps.catalog);
    if (offer === null) return;
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "recommend-go";
    replace.textContent = `Replace the ${offer.name}`;
    replace.addEventListener("click", () => void this.askReplacementFor(offer.instanceId));
    out.appendChild(replace);
  }

  /** A "What fits here?" run with no candidates: local message, no model call. */
  private showSpotEmpty(run: FreeRun): void {
    const out = this.root.querySelector(".recommend-results");
    if (out === null) return;
    out.innerHTML = "";
    const p = document.createElement("p");
    p.className = "recommend-empty";
    p.textContent =
      `Nothing fits this run right now. ${runDisplayLabel(this.deps.room, run.wall, run.length_cm)} ` +
      `is ${String(Math.round(run.length_cm))} cm long and ${String(Math.round(run.depth_cm))} cm deep.`;
    out.appendChild(p);
  }

  private showAnswer(
    data: unknown,
    model: string,
    emptyText: string,
    request: RecommendRequest,
    mode: { kind: "place" } | { kind: "swap"; oldInstanceId: string },
  ): void {
    const out = this.root.querySelector(".recommend-results");
    if (out === null) return;
    out.innerHTML = "";
    const label = document.createElement("p");
    label.className = "recommend-model";
    label.textContent = modelLabel(model);
    out.appendChild(label);
    if (!isRecommendAnswer(data)) {
      this.showNotice("The advisor answered oddly. Please try again.", false);
      return;
    }
    const shown = this.toShown(data, request);
    if (shown.length === 0) {
      const p = document.createElement("p");
      p.className = "recommend-empty";
      p.textContent = data.note ?? emptyText;
      out.appendChild(p);
      return;
    }
    for (const item of shown) {
      out.appendChild(this.card(item, mode));
    }
  }

  /** Ranked items, re-checked at their spots; failing items are dropped. */
  private toShown(answer: RecommendAnswer, request: RecommendRequest): ShownItem[] {
    const spots = new Map(request.candidates.map((c) => [c.productId, c] as const));
    // The re-check must leave out exactly what the candidate check left out.
    const wireReplace = request.request.replace;
    const query: CandidateQuery = {
      category: request.request.category,
      ...(request.request.budget_usd !== undefined
        ? { budget_usd: request.request.budget_usd }
        : {}),
      ...(wireReplace !== undefined
        ? {
            replace: {
              productId: wireReplace.productId,
              position: { x: wireReplace.centre_cm[0] ?? 0, z: wireReplace.centre_cm[1] ?? 0 },
              rotationY: wireReplace.rotationY,
            },
          }
        : {}),
    };
    const out: ShownItem[] = [];
    for (const rec of answer.recommendations.slice(0, 3)) {
      const candidate = spots.get(rec.productId);
      const entry = this.catalogById.get(rec.productId);
      if (candidate === undefined || entry === undefined) continue;
      const [x, z] = candidate.spot.centre_cm;
      if (
        x === undefined ||
        z === undefined ||
        !this.passes(query, rec.productId, { x, z }, candidate.spot.rotationY)
      ) {
        continue;
      }
      out.push({ candidate, entry, reason: rec.reason });
    }
    return out;
  }

  private card(
    item: ShownItem,
    mode: { kind: "place" } | { kind: "swap"; oldInstanceId: string },
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "recommend-card";
    const top = document.createElement("div");
    top.className = "recommend-card-top";
    const thumb = document.createElement("img");
    thumb.src = item.entry.thumbnail;
    thumb.alt = item.entry.name;
    thumb.loading = "lazy";
    const meta = document.createElement("span");
    meta.className = "catalog-meta";
    const name = document.createElement("span");
    name.className = "catalog-name";
    name.textContent = item.entry.name;
    const dims = document.createElement("span");
    dims.className = "catalog-dims";
    dims.textContent = formatCatalogSize(item.entry.size.w, item.entry.size.d, item.entry.size.h);
    const price = document.createElement("span");
    price.className = "catalog-price";
    price.textContent = formatCatalogPrice(item.entry.price);
    meta.append(name, dims, price);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "recommend-go";
    const placed = this.deps.getScene().items.some((i) => i.productId === item.candidate.productId);
    if (placed) {
      go.textContent = "Placed";
      go.toggleAttribute("disabled", true);
    } else {
      go.textContent = mode.kind === "swap" ? "Swap it" : "Place it";
      go.addEventListener("click", () => {
        const [x, z] = item.candidate.spot.centre_cm;
        if (x === undefined || z === undefined) return;
        if (mode.kind === "swap") {
          this.deps.swapItem(
            mode.oldInstanceId,
            item.candidate.productId,
            x,
            z,
            item.candidate.spot.rotationY,
          );
        } else {
          this.deps.placeItem(item.candidate.productId, x, z, item.candidate.spot.rotationY);
        }
        go.textContent = "Placed";
        go.toggleAttribute("disabled", true);
      });
    }
    top.append(thumb, meta);
    const reason = document.createElement("p");
    reason.className = "recommend-reason";
    reason.textContent = item.reason;
    // The single primary action lives on its own row under the text, so it
    // can never cover the size line on a narrow panel.
    const actions = document.createElement("div");
    actions.className = "recommend-card-actions";
    actions.appendChild(go);
    card.append(top, reason, actions);
    return card;
  }

  private showNotice(message: string, withActions: boolean): void {
    const out = this.root.querySelector(".recommend-results");
    if (out === null) return;
    out.innerHTML = "";
    const p = document.createElement("p");
    p.className = "recommend-empty";
    p.textContent = message;
    out.appendChild(p);
    if (!withActions) return;
    const row = document.createElement("div");
    row.className = "recommend-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn-quiet";
    reset.textContent = USE_SAMPLE_ROOM;
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "recommend-go";
      live.textContent = TURN_ON_LIVE;
      live.addEventListener("click", () => void requestLive());
      row.appendChild(live);
    }
    out.appendChild(row);
  }
}
