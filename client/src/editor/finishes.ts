/**
 * Finishes picker: floor + wall ambientCG swatches and a tint reset.
 * Shared by the plan editor's Details and the photo confirm plan card.
 * Every change commits exactly one undo step through the editor store.
 */

import { FLOOR_FINISHES, TEXTURE_MEAN_COLORS, WALL_FINISHES, finishName } from "@fitroom/shared";
import type { RoomLayout } from "@fitroom/shared";
import { resetTintLabel } from "../copy";
import type { EditorStore } from "./editor-store";

function cloneRoom(room: RoomLayout): RoomLayout {
  return JSON.parse(JSON.stringify(room)) as RoomLayout;
}

function swatchButton(
  label: string,
  color: string,
  active: boolean,
  onPick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "finish-swatch";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset["active"] = String(active);
  button.style.background = color;
  if (active) button.style.outline = "2px solid #F54E49";
  button.addEventListener("click", onPick);
  return button;
}

/** Small floor/wall finish picker appended to `host`. Pure DOM, one undo per pick. */
export function renderFinishesPicker(store: EditorStore, host: HTMLElement): HTMLElement {
  const room = store.room;
  const wrap = document.createElement("div");
  wrap.className = "finishes-picker";
  const heading = document.createElement("h3");
  heading.className = "finishes-title";
  heading.textContent = "Finishes";
  wrap.appendChild(heading);

  const floorLabel = document.createElement("p");
  floorLabel.className = "finishes-label";
  floorLabel.textContent = "Floor";
  wrap.appendChild(floorLabel);
  const floorRow = document.createElement("div");
  floorRow.className = "finishes-row";
  for (const id of FLOOR_FINISHES) {
    floorRow.appendChild(
      swatchButton(
        `Floor: ${finishName(id)}`,
        TEXTURE_MEAN_COLORS[id] ?? "#999999",
        room.surfaces.floor === id,
        () => {
          const next = cloneRoom(store.room);
          next.surfaces = { ...next.surfaces, floor: id };
          store.commit(next);
        },
      ),
    );
  }
  wrap.appendChild(floorRow);

  const wallLabel = document.createElement("p");
  wallLabel.className = "finishes-label";
  wallLabel.textContent = "Walls";
  wrap.appendChild(wallLabel);
  const wallRow = document.createElement("div");
  wallRow.className = "finishes-row";
  for (const id of WALL_FINISHES) {
    wallRow.appendChild(
      swatchButton(
        `Wall: ${finishName(id)}`,
        TEXTURE_MEAN_COLORS[id] ?? "#999999",
        room.surfaces.wall === id,
        () => {
          const next = cloneRoom(store.room);
          next.surfaces = { ...next.surfaces, wall: id };
          store.commit(next);
        },
      ),
    );
  }
  wrap.appendChild(wallRow);

  if (typeof room.surfaces.wallTint === "string" && room.surfaces.wallTint !== "") {
    const tintRow = document.createElement("div");
    tintRow.className = "finishes-row";
    // Decorative swatch: carries no name (Lighthouse: a span must not carry
    // an aria-label), the button beside it names the action.
    const chip = document.createElement("span");
    chip.className = "finish-tint-chip";
    chip.title = `Wall tint ${room.surfaces.wallTint}`;
    chip.setAttribute("aria-hidden", "true");
    chip.style.background = room.surfaces.wallTint;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "editor-pill";
    reset.textContent = resetTintLabel().visible;
    reset.setAttribute("aria-label", resetTintLabel().accessible);
    reset.addEventListener("click", () => {
      const next = cloneRoom(store.room);
      const { wallTint: _dropped, ...kept } = next.surfaces;
      void _dropped;
      next.surfaces = kept;
      store.commit(next);
    });
    tintRow.append(chip, reset);
    wrap.appendChild(tintRow);
  }

  host.appendChild(wrap);
  return wrap;
}
