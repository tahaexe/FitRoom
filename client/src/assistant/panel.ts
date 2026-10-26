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
  AssistantMessage,
  AssistantToolRecord,
  CatalogItem,
  RoomLayout,
  SceneState,
} from "@fitroom/shared";
import {
  ASSISTANT_MAX_ROUNDS,
  assistantToolMessages,
  cloneScene,
  createAssistantContext,
  executeTurnRound,
  formatAssistantToolRecord,
  isAssistantRoundData,
  summarizeAssistantTurn,
  turnErrors,
} from "@fitroom/shared";
import { isLive, postAssistant, type ApiResult } from "../api";

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
}

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

  private render(): void {
    this.root.innerHTML = "";
    const head = document.createElement("div");
    head.className = "assistant-head";
    const title = document.createElement("h2");
    title.textContent = "Arrange";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "assistant-close";
    close.textContent = "×";
    close.title = "Hide the assistant";
    close.addEventListener("click", () => {
      this.root.setAttribute("hidden", "");
      document.getElementById("tool-assistant")?.setAttribute("data-active", "false");
    });
    head.append(title, close);
    this.root.appendChild(head);

    if (!isLive()) {
      this.root.appendChild(this.buildChips());
    }

    const log = document.createElement("div");
    log.className = "assistant-log";
    this.root.appendChild(log);

    const row = document.createElement("div");
    row.className = "assistant-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Arrange the room in plain language…";
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
    this.root.appendChild(row);
  }

  /** Show or hide the demo chips without losing the chat log. */
  syncMode(): void {
    const existing = this.root.querySelector(".assistant-chips");
    if (isLive()) {
      existing?.remove();
      return;
    }
    if (existing !== null) return;
    const head = this.root.querySelector(".assistant-head");
    const chips = this.buildChips();
    if (head?.nextSibling !== null && head?.nextSibling !== undefined) {
      this.root.insertBefore(chips, head.nextSibling);
    } else {
      this.root.appendChild(chips);
    }
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
    const texts =
      recorded === null
        ? ASSISTANT_DEMO_CHIPS
        : ASSISTANT_DEMO_CHIPS.filter((text) => recorded.includes(text));
    if (texts.length === 0) {
      host.remove();
      return;
    }
    for (const text of texts) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "assistant-chip";
      chip.textContent = text.length > 42 ? `${text.slice(0, 42)}…` : text;
      chip.title = text;
      chip.addEventListener("click", () => void this.sendDemo(text));
      host.appendChild(chip);
    }
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
    const sum = document.createElement("p");
    sum.className = "assistant-summary";
    sum.textContent = summary;
    card.append(label, text, sum);
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
  }

  /** Demo chip: load the demo room first, then run the scripted request. */
  private async sendDemo(text: string): Promise<void> {
    if (this.sending) return;
    this.deps.resetDemoRoom();
    await this.send(text);
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
          this.addNotice(result.message);
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
      // errors is never applied.
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
