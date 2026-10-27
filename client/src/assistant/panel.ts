/**
 * Layout assistant panel: plain-language room arranging with every move
 * checked against real geometry.
 *
 * Flow: the customer text goes to `POST /api/assistant`; each round's tool
 * calls run through the shared executor on a draft copy of the scene (each
 * followed by the fit engine) and the results go back as tool messages —
 * up to 8 rounds per turn. The whole turn is applied as one change (one undo
 * reverts it); a draft with fit errors is never applied. The chat shows the
 * model's short answer, a summary of what moved and the fit verdict, plus a
 * collapsible "What I did" list (one line per tool call, labelled
 * Muse Spark).
 *
 * In demo mode the six scripted requests appear as chips: choosing one first
 * loads the demo room, then replays the stored turn round by round through
 * the same executor. Typed requests that miss the store show the demo-miss
 * message.
 */

import type {
  AssistantBrief,
  AssistantMessage,
  AssistantToolRecord,
  BriefStyle,
  CatalogItem,
  RoomLayout,
  SceneState,
} from "@fitroom/shared";
import {
  ASSISTANT_MAX_ROUNDS,
  assistantToolMessages,
  briefError,
  briefResultCard,
  briefShortLabel,
  briefStartLine,
  briefStyleChip,
  buildBriefRequest,
  cloneScene,
  createAssistantContext,
  executeTurnRound,
  formatAssistantToolRecord,
  impossibleAnswer,
  isAssistantRoundData,
  isBriefStyle,
  startBriefDraft,
  summarizeAssistantTurn,
  turnErrors,
} from "@fitroom/shared";
import { isLive, postAssistant, setLive, type ApiResult } from "../api";

/** The six scripted demo requests (same list as the server demo store). */
export const ASSISTANT_DEMO_CHIPS: string[] = [
  "Put the sofa under the window and keep 80 cm free in front of the door.",
  "Swap the black sofa for the Provence loveseat, in navy.",
  "Add a side table on the right of the armchair.",
  "I want a second armchair facing the sofa.",
  "Move the TV unit to the west wall and turn the sofa to face it.",
  "Put the Heritage Grand Sofa on the wall between the door and the corner.",
];

export interface AssistantDeps {
  room: RoomLayout;
  catalog: CatalogItem[];
  getScene: () => SceneState;
  /** Apply the turn's end scene as one undo step. */
  applyTurn: (endScene: SceneState) => void;
  /** Load the demo room as one undo step. */
  resetDemoRoom: () => void;
  /** True when the live scene still matches the sample layout. */
  isSampleScene: () => boolean;
  /** Toast the applied furnish turn ("Furnished · Undo"). */
  onFurnished: () => void;
}

/** Demo brief chips start with the brief sentence the panel builds. */
const FURNISH_CHIP_PREFIX = "Furnish this room for";

/** Style chips on the Furnish tab (panel labels). */
const FURNISH_STYLES: Array<{ value: BriefStyle; label: string }> = [
  { value: "any", label: "Any" },
  { value: "modern", label: "Modern" },
  { value: "classic", label: "Classic" },
  { value: "scandinavian", label: "Scandinavian" },
];

export class AssistantPanel {
  private readonly deps: AssistantDeps;
  private readonly root: HTMLElement;
  private sending = false;

  constructor(host: HTMLElement, deps: AssistantDeps) {
    this.deps = deps;
    this.root = host;
    this.root.classList.add("assistant-panel");
    this.render();
  }

  private tab: "arrange" | "furnish" = "arrange";

  /** Open the panel on the Furnish tab (the empty-room "Furnish it for me"). */
  openFurnish(): void {
    this.tab = "furnish";
    this.render();
    this.syncMode();
  }

  /** Open the panel on the Arrange tab (the phone AI menu). */
  openArrange(): void {
    this.tab = "arrange";
    this.render();
    this.syncMode();
  }

  private render(): void {
    this.root.innerHTML = "";
    const head = document.createElement("div");
    head.className = "assistant-head";
    const tabs = document.createElement("div");
    tabs.className = "assistant-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Assistant mode");
    for (const name of ["arrange", "furnish"] as const) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "assistant-tab";
      tab.setAttribute("role", "tab");
      tab.textContent = name === "arrange" ? "Arrange" : "Furnish";
      tab.setAttribute("aria-selected", String(this.tab === name));
      tab.toggleAttribute("data-active", this.tab === name);
      tab.addEventListener("click", () => {
        this.tab = name;
        this.render();
        this.syncMode();
      });
      tabs.appendChild(tab);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "assistant-close";
    close.textContent = "×";
    close.title = "Hide the assistant";
    close.setAttribute("aria-label", "Hide the assistant");
    close.addEventListener("click", () => {
      this.root.setAttribute("hidden", "");
      document.getElementById("tool-assistant")?.setAttribute("data-active", "false");
    });
    head.append(tabs, close);
    this.root.appendChild(head);

    const arrangeView = document.createElement("div");
    arrangeView.className = "assistant-view";
    if (this.tab !== "arrange") arrangeView.setAttribute("hidden", "");
    if (!isLive()) {
      arrangeView.appendChild(this.buildChips());
    }
    const log = document.createElement("div");
    log.className = "assistant-log";
    arrangeView.appendChild(log);
    const row = document.createElement("div");
    row.className = "assistant-row";
    const input = document.createElement("input");
    input.type = "text";
    input.name = "arrange-request";
    input.placeholder = "Arrange the room…";
    input.title = "Ask the layout assistant in plain language";
    input.setAttribute("aria-label", "Ask the layout assistant");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.send(input.value);
    });
    const go = document.createElement("button");
    go.type = "button";
    go.className = "assistant-go";
    go.textContent = "Send";
    go.addEventListener("click", () => void this.send(input.value));
    row.append(input, go);
    arrangeView.appendChild(row);
    this.root.appendChild(arrangeView);

    const furnishView = document.createElement("div");
    furnishView.className = "assistant-view furnish-view";
    if (this.tab !== "furnish") furnishView.setAttribute("hidden", "");
    furnishView.appendChild(this.buildFurnishView());
    this.root.appendChild(furnishView);
  }

  /** Show or hide the demo chips without losing the chat log. */
  syncMode(): void {
    const arrangeView = this.root.querySelectorAll(".assistant-view")[0];
    const existing = arrangeView?.querySelector(":scope > .assistant-chips") ?? null;
    if (isLive()) {
      existing?.remove();
    } else if (existing === null && arrangeView !== undefined) {
      const chips = this.buildChips();
      arrangeView.prepend(chips);
    }
    this.syncFurnishMode();
  }

  /** Demo-store request texts, once loaded (demo mode shows no unrecorded chip). */
  private recordedChips: string[] | null = null;

  private async loadRecordedChips(): Promise<string[] | null> {
    if (this.recordedChips !== null) return this.recordedChips;
    try {
      const res = await fetch("/api/assistant/demo-chips");
      const payload = (await res.json()) as unknown;
      if (
        typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as Record<string, unknown>)["requests"])
      ) {
        const requests = (payload as Record<string, unknown>)["requests"] as unknown[];
        this.recordedChips = requests.filter((entry): entry is string => typeof entry === "string");
        return this.recordedChips;
      }
    } catch {
      // Fall through to showing every chip below.
    }
    return null;
  }

  private buildChips(): HTMLElement {
    const chips = document.createElement("div");
    chips.className = "assistant-chips";
    void this.fillChips(chips);
    return chips;
  }

  private async fillChips(host: HTMLElement): Promise<void> {
    const recorded = await this.loadRecordedChips();
    if (recorded !== null && recorded.length === 0) {
      host.remove();
      return;
    }
    for (const text of ASSISTANT_DEMO_CHIPS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "assistant-chip";
      // Full text, wrapping onto several lines: never cut with "…".
      chip.textContent = text;
      const stored = recorded === null || recorded.includes(text);
      if (stored) {
        chip.title = text;
        chip.addEventListener("click", () => void this.sendDemo(text));
      } else {
        // In demo mode a chip with no stored answer is disabled: Live AI only.
        chip.title = `${text} — needs Live AI (no stored demo answer)`;
        chip.toggleAttribute("disabled", true);
        chip.setAttribute("aria-disabled", "true");
      }
      host.appendChild(chip);
    }
  }

  // ---- Furnish tab ----

  private furnishSeats = 4;
  private furnishStyle: BriefStyle = "any";
  private furnishBudget = 2000;
  private furnishKeep = true;
  private furnishNote = "";

  private buildFurnishView(): HTMLElement {
    const view = document.createElement("div");
    view.className = "furnish-body";

    const chips = document.createElement("div");
    chips.className = "assistant-chips furnish-chips";
    view.appendChild(chips);

    const form = document.createElement("div");
    form.className = "furnish-form";

    // Seats stepper (1-8, default 4).
    const seatsField = document.createElement("div");
    seatsField.className = "furnish-field";
    const seatsLabel = document.createElement("label");
    seatsLabel.textContent = "Seats";
    seatsLabel.id = "furnish-seats-label";
    const stepper = document.createElement("div");
    stepper.className = "furnish-stepper";
    stepper.setAttribute("role", "group");
    stepper.setAttribute("aria-labelledby", "furnish-seats-label");
    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "furnish-step";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "Fewer seats");
    const value = document.createElement("output");
    value.className = "furnish-seats-value";
    value.setAttribute("aria-live", "polite");
    value.setAttribute("aria-label", "Seats");
    value.textContent = String(this.furnishSeats);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "furnish-step";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "More seats");
    const step = (delta: number): void => {
      this.furnishSeats = Math.min(8, Math.max(1, this.furnishSeats + delta));
      value.textContent = String(this.furnishSeats);
      minus.toggleAttribute("disabled", this.furnishSeats <= 1);
      plus.toggleAttribute("disabled", this.furnishSeats >= 8);
    };
    minus.addEventListener("click", () => step(-1));
    plus.addEventListener("click", () => step(1));
    minus.toggleAttribute("disabled", this.furnishSeats <= 1);
    stepper.append(minus, value, plus);
    seatsField.append(seatsLabel, stepper);
    form.appendChild(seatsField);

    // Style chips (default Any).
    const styleField = document.createElement("div");
    styleField.className = "furnish-field";
    const styleLabel = document.createElement("span");
    styleLabel.className = "furnish-label";
    styleLabel.id = "furnish-style-label";
    styleLabel.textContent = "Style";
    const styleChips = document.createElement("div");
    styleChips.className = "furnish-styles";
    styleChips.setAttribute("role", "group");
    styleChips.setAttribute("aria-labelledby", "furnish-style-label");
    const styleButtons: HTMLButtonElement[] = [];
    for (const option of FURNISH_STYLES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "furnish-style";
      chip.textContent = option.label;
      chip.setAttribute("aria-pressed", String(this.furnishStyle === option.value));
      chip.toggleAttribute("data-active", this.furnishStyle === option.value);
      chip.addEventListener("click", () => {
        this.furnishStyle = option.value;
        for (const other of styleButtons) {
          const active = other === chip;
          other.setAttribute("aria-pressed", String(active));
          other.toggleAttribute("data-active", active);
        }
      });
      styleButtons.push(chip);
      styleChips.appendChild(chip);
    }
    styleField.append(styleLabel, styleChips);
    form.appendChild(styleField);

    // Budget dollars (default 2,000).
    const budgetField = document.createElement("div");
    budgetField.className = "furnish-field";
    const budgetLabel = document.createElement("label");
    budgetLabel.textContent = "Budget";
    budgetLabel.htmlFor = "furnish-budget";
    const budgetRow = document.createElement("div");
    budgetRow.className = "furnish-budget-row";
    const dollar = document.createElement("span");
    dollar.className = "furnish-dollar";
    dollar.textContent = "$";
    dollar.setAttribute("aria-hidden", "true");
    const budget = document.createElement("input");
    budget.type = "number";
    budget.id = "furnish-budget";
    budget.name = "furnish-budget";
    budget.min = "300";
    budget.max = "20000";
    budget.step = "50";
    budget.value = String(this.furnishBudget);
    budget.setAttribute("aria-label", "Budget in dollars");
    budget.addEventListener("change", () => {
      const parsed = Math.round(Number(budget.value));
      this.furnishBudget = Number.isFinite(parsed) ? Math.min(20000, Math.max(300, parsed)) : 2000;
      budget.value = String(this.furnishBudget);
    });
    budgetRow.append(dollar, budget);
    budgetField.append(budgetLabel, budgetRow);
    form.appendChild(budgetField);

    // Keep existing pieces (on; only when the room has pieces).
    const keepRow = document.createElement("div");
    keepRow.className = "furnish-keep";
    const keep = document.createElement("input");
    keep.type = "checkbox";
    keep.id = "furnish-keep";
    keep.name = "furnish-keep";
    keep.checked = this.furnishKeep;
    keep.addEventListener("change", () => {
      this.furnishKeep = keep.checked;
    });
    const keepLabel = document.createElement("label");
    keepLabel.htmlFor = "furnish-keep";
    keepLabel.textContent = "Keep the pieces already here";
    keepRow.append(keep, keepLabel);
    form.appendChild(keepRow);

    // Optional note (at most 200 characters).
    const noteField = document.createElement("div");
    noteField.className = "furnish-field";
    const noteLabel = document.createElement("label");
    noteLabel.textContent = "Anything else? (optional)";
    noteLabel.htmlFor = "furnish-note";
    const note = document.createElement("input");
    note.type = "text";
    note.id = "furnish-note";
    note.name = "furnish-note";
    note.maxLength = 200;
    note.value = this.furnishNote;
    note.setAttribute("aria-label", "Anything else?");
    note.addEventListener("input", () => {
      this.furnishNote = note.value;
    });
    const hint = document.createElement("p");
    hint.className = "furnish-hint";
    hint.textContent = "For example: keep the window wall free.";
    noteField.append(noteLabel, note, hint);
    form.appendChild(noteField);

    const go = document.createElement("button");
    go.type = "button";
    go.className = "assistant-go furnish-go";
    go.textContent = "Furnish";
    go.addEventListener("click", () => void this.furnishSubmit());
    form.appendChild(go);

    const liveNote = document.createElement("p");
    liveNote.className = "furnish-live-note";
    liveNote.textContent = "Uses Live AI · about 30 s";
    form.appendChild(liveNote);

    const demoNote = document.createElement("p");
    demoNote.className = "furnish-demo-note";
    demoNote.textContent = "Other briefs use Live AI";
    form.appendChild(demoNote);
    const liveButton = document.createElement("button");
    liveButton.type = "button";
    liveButton.className = "assistant-quiet furnish-live-button";
    liveButton.textContent = "Turn on Live AI";
    liveButton.addEventListener("click", () => {
      setLive(true);
      this.syncMode();
    });
    form.appendChild(liveButton);

    view.appendChild(form);

    const log = document.createElement("div");
    log.className = "assistant-log furnish-log";
    view.appendChild(log);
    return view;
  }

  private furnishView(): HTMLElement | null {
    return this.root.querySelector(".furnish-view");
  }

  private furnishLogEl(): HTMLElement | null {
    return this.root.querySelector(".furnish-log");
  }

  /** Enable the form in live mode; disable it around the demo chips. */
  private syncFurnishMode(): void {
    const view = this.furnishView();
    if (view === null) return;
    const live = isLive();
    const chips = view.querySelector(".furnish-chips");
    if (live) {
      chips?.setAttribute("hidden", "");
    } else {
      chips?.removeAttribute("hidden");
      const host = chips instanceof HTMLElement ? chips : null;
      if (host !== null && host.childElementCount === 0) void this.fillFurnishChips(host);
    }
    for (const field of view.querySelectorAll(".furnish-form button, .furnish-form input")) {
      if (!(field instanceof HTMLButtonElement) && !(field instanceof HTMLInputElement)) continue;
      if (field.classList.contains("furnish-live-button")) {
        field.toggleAttribute("hidden", live);
        continue;
      }
      field.toggleAttribute("disabled", !live);
    }
    view.querySelector(".furnish-live-note")?.toggleAttribute("hidden", !live);
    view.querySelector(".furnish-demo-note")?.toggleAttribute("hidden", live);
    // "Keep the pieces already here" only reads when the room has pieces.
    const hasPieces = this.deps.getScene().items.length > 0;
    view.querySelector(".furnish-keep")?.toggleAttribute("hidden", !hasPieces);
  }

  private async fillFurnishChips(host: HTMLElement): Promise<void> {
    const recorded = await this.loadRecordedChips();
    const briefs = (recorded ?? []).filter((text) => text.startsWith(FURNISH_CHIP_PREFIX));
    if (briefs.length === 0) {
      host.setAttribute("hidden", "");
      return;
    }
    host.innerHTML = "";
    for (const text of briefs) {
      const parsed = parseBriefChip(text);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "assistant-chip";
      if (parsed === null) {
        chip.textContent = text;
        chip.title = `${text} — needs Live AI (no stored demo answer)`;
        chip.toggleAttribute("disabled", true);
        chip.setAttribute("aria-disabled", "true");
      } else {
        // Short label on the chip; the request sentence stays the chat
        // line and the demo-store key.
        chip.textContent = briefShortLabel(parsed.brief, parsed.note);
        chip.title = text;
        const brief = parsed.brief;
        const note = parsed.note;
        chip.addEventListener("click", () => void this.sendFurnishDemo(text, brief, note));
      }
      host.appendChild(chip);
    }
  }

  private furnishSubmit(): void {
    if (this.sending) return;
    const hasPieces = this.deps.getScene().items.length > 0;
    const brief: AssistantBrief = {
      seats: Math.min(8, Math.max(1, Math.round(this.furnishSeats))),
      style: this.furnishStyle,
      budget: Math.min(20000, Math.max(300, Math.round(this.furnishBudget))),
      keepExisting: hasPieces && this.furnishKeep,
    };
    void this.furnishTurn(brief, buildBriefRequest(brief, this.furnishNote));
  }

  /**
   * Demo brief chip: the recorded brief replays from the sample layout.
   * When the room already differs, ask first — never reset it silently.
   */
  private async sendFurnishDemo(text: string, brief: AssistantBrief, note: string): Promise<void> {
    if (this.sending) return;
    const pending = this.pendingDemo;
    if ((pending?.text !== text || pending.brief === null) && !this.deps.isSampleScene()) {
      this.pendingDemo = { text, brief, note };
      this.addSampleConfirm("furnish");
      return;
    }
    this.pendingDemo = null;
    this.deps.resetDemoRoom();
    await this.furnishTurn(brief, buildBriefRequest(brief, note));
  }

  private addFurnishUserLine(text: string): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    const p = document.createElement("p");
    p.className = "assistant-user";
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  private addFurnishNotice(text: string): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    this.clearFurnishProgress();
    const p = document.createElement("p");
    p.className = "assistant-empty";
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  /** One progress line per turn: each round updates it in place. */
  private addFurnishProgress(text: string): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    const existing = log.querySelector(":scope > .furnish-progress");
    if (existing !== null) {
      existing.textContent = text;
    } else {
      const p = document.createElement("p");
      p.className = "furnish-progress";
      p.setAttribute("role", "status");
      p.textContent = text;
      log.appendChild(p);
    }
    log.scrollTop = log.scrollHeight;
  }

  /** Drop the progress line when the turn ends (a card or notice replaces it). */
  private clearFurnishProgress(): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    for (const line of log.querySelectorAll(":scope > .furnish-progress")) {
      line.remove();
    }
  }

  /**
   * The result card, computed from the end scene — never from the model's
   * text: headline, one row per new piece (thumbnail, name, price, style
   * chip), then the model's answer.
   */
  private addFurnishCard(
    brief: AssistantBrief,
    start: SceneState,
    end: SceneState,
    answer: string,
  ): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    this.clearFurnishProgress();
    const card = briefResultCard(start, end, this.deps.room, this.deps.catalog, brief);
    const box = document.createElement("div");
    box.className = "assistant-card furnish-card";
    const label = document.createElement("p");
    label.className = "assistant-model";
    label.textContent = "Muse Spark";
    box.appendChild(label);
    const head = document.createElement("p");
    head.className = "furnish-headline";
    const [seatsPart, ...rest] = card.headline.split(" · ");
    const seats = document.createElement("span");
    seats.className = "furnish-seats";
    seats.textContent = seatsPart ?? "";
    if (card.seatsShort) seats.classList.add("furnish-seats-warn");
    head.appendChild(seats);
    const tail = document.createElement("span");
    tail.textContent = rest.length === 0 ? "" : ` · ${rest.join(" · ")}`;
    head.appendChild(tail);
    box.appendChild(head);
    if (card.rows.length > 0) {
      const list = document.createElement("ul");
      list.className = "furnish-rows";
      for (const row of card.rows) {
        const item = document.createElement("li");
        item.className = "furnish-row";
        const thumb = document.createElement("img");
        thumb.className = "furnish-thumb";
        thumb.src = row.thumbnail;
        thumb.alt = "";
        // Name + style chip stack on the left (the name wraps); the price
        // stays right-aligned on the row's first line, so nothing overlaps.
        const meta = document.createElement("div");
        meta.className = "furnish-meta";
        const name = document.createElement("span");
        name.className = "furnish-name";
        name.textContent = row.name;
        meta.appendChild(name);
        if (row.styleMatch) {
          const chip = document.createElement("span");
          chip.className = "furnish-style-chip";
          chip.textContent = briefStyleChip(brief.style);
          meta.appendChild(chip);
        }
        const price = document.createElement("span");
        price.className = "furnish-price";
        price.textContent = `$${String(row.price.toLocaleString("en-US"))}`;
        item.append(thumb, meta, price);
        list.appendChild(item);
      }
      box.appendChild(list);
    }
    // The text under a brief's card is computed first (where the turn
    // started, what Undo restores), then the model's final answer when it
    // gave one — never Arrange's move list.
    const startLine = document.createElement("p");
    startLine.className = "assistant-answer";
    startLine.textContent = briefStartLine(brief, start.items.length);
    box.appendChild(startLine);
    if (answer.trim() !== "") {
      const reply = document.createElement("p");
      reply.className = "assistant-answer";
      reply.textContent = firstSentences(answer);
      box.appendChild(reply);
    }
    log.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
    log.scrollTop = log.scrollHeight;
  }

  private async roundWithBrief(
    request: string,
    brief: AssistantBrief,
    messages: AssistantMessage[],
    draft: SceneState,
  ): Promise<ApiResult> {
    try {
      return await postAssistant({
        request,
        messages,
        room: this.deps.room,
        scene: draft,
        brief: { ...brief },
      });
    } catch {
      return { status: "error", message: "The AI service is unreachable." };
    }
  }

  private async furnishTurn(brief: AssistantBrief, request: string): Promise<void> {
    this.addFurnishUserLine(request);
    const start = cloneScene(this.deps.getScene());
    const draft = startBriefDraft(start, brief);
    const ctx = createAssistantContext(this.deps.room, this.deps.catalog, brief);
    const messages: AssistantMessage[] = [{ role: "user", content: request }];
    const records: AssistantToolRecord[] = [];
    let cleanSnapshot: SceneState | null = null;
    let answer: string | null = null;

    this.setSending(true);
    try {
      for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
        const result = await this.roundWithBrief(request, brief, messages, draft);
        if (result.status !== "ok") {
          if (result.status === "demo-miss" || result.status === "capped") {
            this.addFurnishDemoMiss(result.message);
          } else if (result.status === "not-ready") {
            this.addFurnishNotice(
              "The assistant isn't ready yet. Turn on Live AI or reset to the demo room.",
            );
          } else {
            this.addFurnishNotice(result.message);
          }
          return;
        }
        if (!isAssistantRoundData(result.data)) {
          this.addFurnishNotice("The assistant answered oddly. Please try again.");
          return;
        }
        if (result.data.toolCalls.length === 0) {
          answer = result.data.text;
          break;
        }
        const step = executeTurnRound(ctx, draft, result.data.toolCalls);
        records.push(...step);
        this.addFurnishProgress(furnishProgressLine(result.data.toolCalls.map((c) => c.name)));
        messages.push({
          role: "assistant",
          content: result.data.text,
          toolCalls: result.data.toolCalls,
        });
        messages.push(...assistantToolMessages(result.data.toolCalls, step));
        if (turnErrors(this.deps.room, draft, this.deps.catalog).length === 0) {
          cleanSnapshot = cloneScene(draft);
        }
      }

      if (answer === null) {
        const refused = impossibleAnswer(records, "");
        if (refused !== null) {
          this.addFurnishCard(brief, start, start, refused);
          return;
        }
        if (cleanSnapshot !== null) {
          this.deps.applyTurn(cleanSnapshot);
          this.deps.onFurnished();
          // Round cap with no final answer: the card shows the computed
          // start line only, never a move list composed from tool records.
          this.addFurnishCard(brief, start, cleanSnapshot, "");
        } else {
          this.addFurnishNotice("I ran out of steps without a clean draft, so nothing changed.");
        }
        return;
      }

      const enforced = impossibleAnswer(records, answer);
      if (enforced !== null) {
        this.addFurnishCard(brief, start, start, enforced);
        return;
      }

      const errors = turnErrors(this.deps.room, draft, this.deps.catalog);
      if (errors.length > 0) {
        this.addFurnishCard(brief, start, draft, answer);
        this.addFurnishNotice(
          `I didn't apply it: ${errors.length === 1 ? "1 problem left" : `${String(errors.length)} problems left`}.`,
        );
        return;
      }
      const unchanged = JSON.stringify(draft.items) === JSON.stringify(start.items);
      if (!unchanged) {
        this.deps.applyTurn(draft);
        this.deps.onFurnished();
      }
      this.addFurnishCard(brief, start, draft, answer);
    } finally {
      this.setSending(false);
    }
  }

  /**
   * Demo miss on the Furnish tab: the message plus a way out in the same
   * card — reset the demo room and, where it applies, Live AI.
   */
  private addFurnishDemoMiss(message: string): void {
    const log = this.furnishLogEl();
    if (log === null) return;
    this.clearFurnishProgress();
    const card = document.createElement("div");
    card.className = "assistant-card";
    const note = document.createElement("p");
    note.className = "assistant-answer";
    note.textContent = message;
    const row = document.createElement("div");
    row.className = "assistant-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "assistant-go";
    reset.textContent = "Reset demo room";
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "assistant-quiet";
      live.textContent = "Turn on Live AI";
      live.addEventListener("click", () => {
        setLive(true);
        this.syncMode();
      });
      row.appendChild(live);
    }
    card.append(note, row);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  private logEl(): HTMLElement | null {
    return this.root.querySelector(".assistant-log");
  }

  private addUserLine(text: string): void {
    const log = this.logEl();
    if (log === null) return;
    const p = document.createElement("p");
    p.className = "assistant-user";
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  private addNotice(text: string): void {
    const log = this.logEl();
    if (log === null) return;
    const p = document.createElement("p");
    p.className = "assistant-empty";
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Demo miss: the message plus a way out in the same card — reset the demo
   * room (one undo step) and, where it applies, Live AI. No "Try again"
   * that would repeat the same miss.
   */
  private addDemoMiss(message: string): void {
    const log = this.logEl();
    if (log === null) return;
    const card = document.createElement("div");
    card.className = "assistant-card";
    const note = document.createElement("p");
    note.className = "assistant-answer";
    note.textContent = message;
    const row = document.createElement("div");
    row.className = "assistant-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "assistant-go";
    reset.textContent = "Reset demo room";
    reset.addEventListener("click", () => this.deps.resetDemoRoom());
    row.appendChild(reset);
    if (!isLive()) {
      const live = document.createElement("button");
      live.type = "button";
      live.className = "assistant-quiet";
      live.textContent = "Turn on Live AI";
      live.addEventListener("click", () => {
        setLive(true);
        this.syncMode();
      });
      row.appendChild(live);
    }
    card.append(note, row);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  private addAnswer(answer: string, summary: string, records: AssistantToolRecord[]): void {
    const log = this.logEl();
    if (log === null) return;
    const card = document.createElement("div");
    card.className = "assistant-card";
    const label = document.createElement("p");
    label.className = "assistant-model";
    label.textContent = "Muse Spark";
    const text = document.createElement("p");
    text.className = "assistant-answer";
    text.textContent = answer;
    card.append(label, text);
    // A turn that ends at the round cap composes its answer from the summary:
    // show it once instead of repeating the same paragraph twice.
    if (summary !== answer) {
      const sum = document.createElement("p");
      sum.className = "assistant-summary";
      sum.textContent = summary;
      card.append(sum);
    }
    if (records.length > 0) {
      const details = document.createElement("details");
      details.className = "assistant-did";
      const title = document.createElement("summary");
      title.textContent = `What I did (${String(records.length)}) · Muse Spark`;
      details.appendChild(title);
      const list = document.createElement("ul");
      for (const record of records) {
        const item = document.createElement("li");
        item.textContent = formatAssistantToolRecord(this.deps.room, record);
        list.appendChild(item);
      }
      details.appendChild(list);
      card.appendChild(details);
    }
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  private setSending(on: boolean): void {
    this.sending = on;
    for (const b of this.root.querySelectorAll("button")) {
      if (b.classList.contains("assistant-close")) continue;
      b.toggleAttribute("disabled", on);
    }
    const input = this.root.querySelector(".assistant-row input");
    if (input instanceof HTMLInputElement) input.toggleAttribute("disabled", on);
    // Re-enabling must not wake demo-mode controls: the Furnish button
    // stays disabled with the other fields until Live AI is on.
    if (!on) this.syncMode();
  }

  /**
   * Demo chip: the scripted request replays from the sample layout. When the
   * room already differs, ask first — never reset it silently.
   */
  private pendingDemo: { text: string; brief: AssistantBrief | null; note: string } | null = null;

  private async sendDemo(text: string): Promise<void> {
    if (this.sending) return;
    if (
      (this.pendingDemo?.text !== text || this.pendingDemo.brief !== null) &&
      !this.deps.isSampleScene()
    ) {
      this.pendingDemo = { text, brief: null, note: "" };
      this.addSampleConfirm("arrange");
      return;
    }
    this.pendingDemo = null;
    this.deps.resetDemoRoom();
    await this.send(text);
  }

  /** Confirm before a recorded example replaces an edited room (undoable). */
  private addSampleConfirm(target: "arrange" | "furnish"): void {
    const log = target === "furnish" ? this.furnishLogEl() : this.logEl();
    if (log === null) return;
    const card = document.createElement("div");
    card.className = "assistant-card";
    const note = document.createElement("p");
    note.className = "assistant-answer";
    note.textContent = "This example uses the sample room; your room stays saved in the room menu.";
    const row = document.createElement("div");
    row.className = "assistant-row";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "assistant-go";
    go.textContent = "Continue";
    go.addEventListener("click", () => {
      card.remove();
      const pending = this.pendingDemo;
      if (pending?.brief !== undefined && pending?.brief !== null) {
        void this.sendFurnishDemo(pending.text, pending.brief, pending.note);
      } else if (pending !== null) {
        void this.sendDemo(pending.text);
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "assistant-quiet";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.pendingDemo = null;
      card.remove();
    });
    row.append(go, cancel);
    card.append(note, row);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  private async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (text === "" || this.sending) return;
    const input = this.root.querySelector(".assistant-row input");
    if (input instanceof HTMLInputElement) input.value = "";
    this.setSending(true);
    try {
      await this.turn(text);
    } finally {
      this.setSending(false);
    }
  }

  private async round(
    request: string,
    messages: AssistantMessage[],
    draft: SceneState,
  ): Promise<ApiResult> {
    try {
      return await postAssistant({
        request,
        messages,
        room: this.deps.room,
        scene: draft,
      });
    } catch {
      return { status: "error", message: "The AI service is unreachable." };
    }
  }

  private async turn(request: string): Promise<void> {
    this.addUserLine(request);
    const start = cloneScene(this.deps.getScene());
    const draft = cloneScene(start);
    const ctx = createAssistantContext(this.deps.room, this.deps.catalog);
    const messages: AssistantMessage[] = [{ role: "user", content: request }];
    const records: AssistantToolRecord[] = [];
    let cleanSnapshot: SceneState | null = null;
    let answer: string | null = null;

    for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
      const result = await this.round(request, messages, draft);
      if (result.status !== "ok") {
        if (result.status === "demo-miss" || result.status === "capped") {
          this.addDemoMiss(result.message);
        } else if (result.status === "not-ready") {
          this.addNotice(
            "The assistant isn't ready yet. Turn on Live AI or reset to the demo room.",
          );
        } else {
          this.addNotice(result.message);
        }
        return;
      }
      if (!isAssistantRoundData(result.data)) {
        this.addNotice("The assistant answered oddly. Please try again.");
        return;
      }
      if (result.data.toolCalls.length === 0) {
        answer = result.data.text;
        break;
      }
      const step = executeTurnRound(ctx, draft, result.data.toolCalls);
      records.push(...step);
      messages.push({
        role: "assistant",
        content: result.data.text,
        toolCalls: result.data.toolCalls,
      });
      messages.push(...assistantToolMessages(result.data.toolCalls, step));
      if (turnErrors(this.deps.room, draft, this.deps.catalog).length === 0) {
        cleanSnapshot = cloneScene(draft);
      }
    }

    if (answer === null) {
      // Round cap: a fit-clean draft is applied with an answer composed from
      // the tool records (what moved, where, the verdict); a draft with fit
      // errors is never applied. A refused "does not fit" placement discards
      // the whole turn, so nothing is applied and the refusal is the answer.
      const refused = impossibleAnswer(records, "");
      if (refused !== null) {
        const summary = summarizeAssistantTurn(start, start, this.deps.room, this.deps.catalog);
        this.addAnswer(refused, summary, records);
        return;
      }
      if (cleanSnapshot !== null) {
        this.deps.applyTurn(cleanSnapshot);
        const composed = summarizeAssistantTurn(
          start,
          cleanSnapshot,
          this.deps.room,
          this.deps.catalog,
        );
        this.addAnswer(composed, composed, records);
      } else {
        this.addNotice("I ran out of steps without a clean draft, so nothing changed.");
      }
      return;
    }

    // A refused "does not fit" placement enforces the refusal: the turn
    // applies no change at all, whatever the model did after it.
    const enforced = impossibleAnswer(records, answer);
    if (enforced !== null) {
      const summary = summarizeAssistantTurn(start, start, this.deps.room, this.deps.catalog);
      this.addAnswer(enforced, summary, records);
      return;
    }

    const errors = turnErrors(this.deps.room, draft, this.deps.catalog);
    if (errors.length > 0) {
      this.addAnswer(
        answer,
        `I didn't apply it: ${errors.length === 1 ? "1 problem left" : `${String(errors.length)} problems left`}.`,
        records,
      );
      return;
    }
    const unchanged = JSON.stringify(draft.items) === JSON.stringify(start.items);
    if (!unchanged) this.deps.applyTurn(draft);
    this.addAnswer(
      answer,
      summarizeAssistantTurn(start, draft, this.deps.room, this.deps.catalog),
      records,
    );
  }
}

/** First three sentences of a longer text (the model's card reply stays short). */
export function firstSentences(text: string, max = 3): string {
  const sentences = text.match(/[^.!?…]+[.!?…]+/g) ?? [text];
  const picked = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .slice(0, Math.max(1, max));
  return picked.join(" ");
}

/** One progress line per furnish round, from the round's tool calls. */
export function furnishProgressLine(toolNames: string[]): string {
  if (toolNames.includes("check_fit")) return "Checking the fit…";
  const placed = toolNames.filter(
    (name) => name === "place_item" || name === "place_against_wall",
  ).length;
  if (placed > 0) return `Placing ${String(placed)} ${placed === 1 ? "piece" : "pieces"}…`;
  return "Choosing pieces…";
}

/**
 * Read a recorded brief chip back into its brief (recorded demo briefs start
 * from an empty room) plus the shopper's note. Null when the text is not a
 * brief request the panel built.
 */
export function parseBriefChip(text: string): { brief: AssistantBrief; note: string } | null {
  const match =
    /^Furnish this room for (\d+) (person|people), ([A-Za-z]+) style, new pieces up to \$([\d,]+)\.(.*)$/.exec(
      text.trim(),
    );
  if (match === null) return null;
  // Recorded sentences predate style capitalization ("classic style");
  // the style word matches either way.
  const style = (match[3] ?? "").toLowerCase();
  if (!isBriefStyle(style)) return null;
  const brief: AssistantBrief = {
    seats: Number(match[1]),
    style,
    budget: Number((match[4] ?? "").replace(/,/g, "")),
    keepExisting: false,
  };
  const note = (match[5] ?? "").trim();
  if (briefError(brief) !== null || note.length > 200) return null;
  return { brief, note };
}
