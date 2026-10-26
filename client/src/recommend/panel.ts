/**
 * Recommendation panel: category advice or "What fits here?" for a free
 * wall run, powered by `POST /api/recommend`.
 *
 * Flow: free-space analysis of the current scene → size-fitting candidates
 * with proposed spots (shared code) → the request goes to `/api/recommend`
 * → each ranked item is placed virtually at its spot and checked; failing
 * items are dropped. "Place it" commits the spot as one undo step.
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
import { analyzeFreeSpace, buildRecommendRequest, isRecommendAnswer } from "@fitroom/shared";
import { isLive, postRecommend, setLive, type ApiResult } from "../api";

const CATEGORIES: RecommendCategory[] = [
  "sofa",
  "armchair",
  "ottoman",
  "coffee-table",
  "side-table",
  "tv-unit",
  "shelf",
  "decor",
];

export interface RecommendDeps {
  room: RoomLayout;
  catalog: CatalogItem[];
  getScene: () => SceneState;
  checkItems: (items: SceneItem[]) => FitIssue[];
  placeItem: (productId: string, x: number, z: number, rotationY: number) => void;
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

  constructor(host: HTMLElement, deps: RecommendDeps) {
    this.deps = deps;
    this.root = host;
    this.catalogById = new Map(deps.catalog.map((c) => [c.id, c]));
    this.root.classList.add("recommend-panel");
    this.render();
  }

  /** Recompute the free runs (call after the scene changes). */
  refresh(): void {
    const scene = this.deps.getScene();
    const free = analyzeFreeSpace(this.deps.room, scene, this.catalogById);
    this.runs = [...free.runs].sort((a, b) => b.length_cm - a.length_cm);
    this.renderRunList();
  }

  /** True when adding the probe introduces no new fit error. */
  private passes(
    productId: string,
    position: { x: number; z: number },
    rotationY: number,
  ): boolean {
    const scene = this.deps.getScene();
    const base = new Set<string>();
    for (const issue of this.deps.checkItems(scene.items)) {
      if (issue.severity === "error") base.add(issueKey(issue));
    }
    const probe: SceneItem = {
      instanceId: "recommend-probe",
      productId,
      position: { x: Math.round(position.x * 10) / 10, z: Math.round(position.z * 10) / 10 },
      rotationY,
      variant: "",
    };
    for (const issue of this.deps.checkItems([...scene.items, probe])) {
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

    const chips = document.createElement("div");
    chips.className = "chips";
    for (const c of CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c;
      b.dataset["active"] = String(c === this.category);
      b.addEventListener("click", () => {
        this.category = c as CatalogCategory;
        for (const other of chips.querySelectorAll("button")) {
          other.dataset["active"] = String(other.textContent === c);
        }
      });
      chips.appendChild(b);
    }
    this.root.appendChild(chips);

    const row = document.createElement("div");
    row.className = "recommend-row";
    const budget = document.createElement("input");
    budget.type = "number";
    budget.min = "0";
    budget.placeholder = "Budget $ (optional)";
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
    this.renderRunList();
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
      const b = document.createElement("button");
      b.type = "button";
      b.className = "recommend-run";
      b.textContent = `${run.wall} · ${Math.round(run.length_cm)} cm`;
      b.title = `What fits on ${run.wall} (${Math.round(run.length_cm)} cm)?`;
      b.addEventListener("mouseenter", () => this.deps.hoverRun(run));
      b.addEventListener("mouseleave", () => this.deps.hoverRun(null));
      b.addEventListener("focus", () => this.deps.hoverRun(run));
      b.addEventListener("blur", () => this.deps.hoverRun(null));
      b.addEventListener("click", () => void this.askSpot(run));
      host.appendChild(b);
    }
  }

  private setLoading(on: boolean): void {
    this.loading = on;
    for (const b of this.root.querySelectorAll("button")) {
      if (b.classList.contains("recommend-close")) continue;
      b.toggleAttribute("disabled", on);
    }
    const out = this.root.querySelector(".recommend-results");
    if (out !== null && on) {
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "recommend-empty";
      p.textContent = "Asking Muse Spark…";
      out.appendChild(p);
    }
  }

  private budgetValue(): number | undefined {
    const raw = this.budget.trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private async askCategory(): Promise<void> {
    if (this.loading) return;
    const scene = this.deps.getScene();
    const request = buildRecommendRequest(
      this.deps.room,
      scene,
      this.deps.catalog,
      {
        category: this.category,
        budget_usd: this.budgetValue(),
      },
      (id, pos, rot) => this.passes(id, pos, rot),
    );
    await this.ask(request, `No fitting ${this.category} right now.`);
  }

  private async askSpot(run: FreeRun): Promise<void> {
    if (this.loading) return;
    this.deps.hoverRun(run);
    const scene = this.deps.getScene();
    const request = buildRecommendRequest(
      this.deps.room,
      scene,
      this.deps.catalog,
      {
        category: "any",
        budget_usd: this.budgetValue(),
        spot: { wall: run.wall, start_cm: run.start_cm, end_cm: run.end_cm },
      },
      (id, pos, rot) => this.passes(id, pos, rot),
    );
    await this.ask(request, "Nothing fits this run right now.");
    this.deps.hoverRun(null);
  }

  private async ask(request: RecommendRequest, emptyText: string): Promise<void> {
    this.setLoading(true);
    let result: ApiResult;
    try {
      result = await postRecommend(request as unknown as Record<string, unknown>);
    } catch {
      result = { status: "error", message: "The AI service is unreachable." };
    }
    this.setLoading(false);
    if (result.status === "ok") {
      this.showAnswer(result.data, result.model, emptyText, request);
    } else if (result.status === "demo-miss" || result.status === "capped") {
      this.showNotice(result.message, true);
    } else if (result.status === "not-ready") {
      this.showNotice(
        "The advisor isn't ready yet. Turn on Live AI or reset to the demo room.",
        true,
      );
    } else {
      this.showNotice(result.message, false);
    }
  }

  private showAnswer(
    data: unknown,
    model: string,
    emptyText: string,
    request: RecommendRequest,
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
      out.appendChild(this.card(item));
    }
  }

  /** Ranked items, re-checked at their spots; failing items are dropped. */
  private toShown(answer: RecommendAnswer, request: RecommendRequest): ShownItem[] {
    const spots = new Map(request.candidates.map((c) => [c.productId, c] as const));
    const out: ShownItem[] = [];
    for (const rec of answer.recommendations.slice(0, 3)) {
      const candidate = spots.get(rec.productId);
      const entry = this.catalogById.get(rec.productId);
      if (candidate === undefined || entry === undefined) continue;
      const [x, z] = candidate.spot.centre_cm;
      if (!this.passes(rec.productId, { x, z }, candidate.spot.rotationY)) continue;
      out.push({ candidate, entry, reason: rec.reason });
    }
    return out;
  }

  private card(item: ShownItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "recommend-card";
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
    dims.textContent = `${Math.round(item.entry.size.w)}×${Math.round(item.entry.size.d)}×${Math.round(item.entry.size.h)}cm`;
    const price = document.createElement("span");
    price.className = "catalog-price";
    price.textContent = `$${item.entry.price}`;
    const reason = document.createElement("span");
    reason.className = "recommend-reason";
    reason.textContent = item.reason;
    meta.append(name, dims, price, reason);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "recommend-go";
    go.textContent = "Place it";
    go.addEventListener("click", () => {
      const [x, z] = item.candidate.spot.centre_cm;
      this.deps.placeItem(item.candidate.productId, x, z, item.candidate.spot.rotationY);
    });
    card.append(thumb, meta, go);
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
    reset.textContent = "Reset to the demo room";
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "recommend-go";
      live.textContent = "Turn on Live AI";
      live.addEventListener("click", () => setLive(true));
      row.appendChild(live);
    }
    out.appendChild(row);
  }
}
