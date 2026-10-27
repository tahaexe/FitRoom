/**
 * The pasted system prompt (sent verbatim) plus the room description the
 * model gets: the same facts a shopper sees, with the internal ids the tools
 * need. The prompt itself never changes; when a scripted request fails, only
 * this description and the tool results may improve.
 */

import type { CatalogItem, RoomLayout, SceneState } from "../types.js";
import { wallLengthCm } from "../units.js";
import { wallDisplayName } from "../recommend/walls.js";
import { briefStyleName, formatUsd, type AssistantBrief } from "./brief.js";
import type { AssistantMessage, AssistantRequest } from "./types.js";

/** The pasted system prompt: Muse Spark arranges only through the tools. */
export const ASSISTANT_SYSTEM_PROMPT =
  "You are FitRoom's layout assistant. You arrange furniture in a true-scale room using only the tools. " +
  "Always start with `get_room` and `list_items`. " +
  "Work on the draft: after your changes call `check_fit`; if there are errors, fix them (move, rotate or choose a smaller product) before you answer. " +
  "Keep doors' swing areas free and keep at least 80 cm walkways from doors to seats. " +
  'If a request cannot be done, say why with the numbers (e.g. "the sofa is 273 cm, the free wall is 238 cm") and offer the closest alternative. ' +
  "Answer the customer in one or two short sentences: what you changed and that everything fits (or what is left).";

export interface UpstreamChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Room description for the model: display names shoppers see, ids tools
 * take. Coordinates are plan centimetres (x east, z north) from the room's
 * inner south-west corner; rotationY in degrees, 0 = front faces north (+z),
 * 90 = east, 180 = south, 270 = west.
 */
export function describeRoomForAssistant(
  room: RoomLayout,
  scene: SceneState,
  catalog: CatalogItem[],
): string {
  const lines: string[] = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < bounds.minX) bounds.minX = p.x;
      if (p.x > bounds.maxX) bounds.maxX = p.x;
      if (p.z < bounds.minZ) bounds.minZ = p.z;
      if (p.z > bounds.maxZ) bounds.maxZ = p.z;
    }
  }
  lines.push(
    `Room "${room.name}": ${String(round1(bounds.maxX - bounds.minX))} x ${String(round1(bounds.maxZ - bounds.minZ))} cm, ` +
      `origin at the inner south-west corner, x east, z north.`,
  );
  lines.push("Walls (id, shopper name, length, start to end in plan cm):");
  for (const wall of room.walls) {
    lines.push(
      `- ${wall.id} "${wallDisplayName(room, wall.id)}" ${String(round1(wallLengthCm(wall.start, wall.end)))} cm ` +
        `from (${String(round1(wall.start.x))}, ${String(round1(wall.start.z))}) ` +
        `to (${String(round1(wall.end.x))}, ${String(round1(wall.end.z))})`,
    );
  }
  lines.push("Openings (id, type, wall id and name, span in cm from the wall start, sill height):");
  for (const opening of room.openings) {
    const span = `${String(round1(opening.offset))}-${String(round1(opening.offset + opening.width))}`;
    if (opening.type === "door") {
      lines.push(
        `- ${opening.id} door on ${opening.wallId} "${wallDisplayName(room, opening.wallId)}" span ${span} cm, ` +
          `hinge ${opening.hinge}, swings ${opening.swing}`,
      );
    } else {
      lines.push(
        `- ${opening.id} window on ${opening.wallId} "${wallDisplayName(room, opening.wallId)}" span ${span} cm, ` +
          `sill ${String(round1(opening.sillHeight))} cm`,
      );
    }
  }
  if (room.fixtures.length > 0) {
    lines.push("Fixtures (id, type, wall, span, depth out from the wall):");
    for (const fixture of room.fixtures) {
      lines.push(
        `- ${fixture.id} ${fixture.type} on ${fixture.wallId} "${wallDisplayName(room, fixture.wallId)}" ` +
          `span ${String(round1(fixture.offset))}-${String(round1(fixture.offset + fixture.width))} cm, ` +
          `${String(round1(fixture.depth))} cm deep`,
      );
    }
  }
  lines.push(
    "Wall stretches beside openings and fixtures (wall id and name, free spans in cm from the wall start):",
  );
  for (const wall of room.walls) {
    const len = wallLengthCm(wall.start, wall.end);
    const mounts: Array<{ from: number; to: number; label: string }> = [];
    for (const opening of room.openings) {
      if (opening.wallId === wall.id) {
        mounts.push({
          from: opening.offset,
          to: opening.offset + opening.width,
          label: opening.type === "door" ? `the door ${opening.id}` : `window ${opening.id}`,
        });
      }
    }
    for (const fixture of room.fixtures) {
      if (fixture.wallId === wall.id) {
        mounts.push({
          from: fixture.offset,
          to: fixture.offset + fixture.width,
          label: `the ${fixture.type} ${fixture.id}`,
        });
      }
    }
    mounts.sort((a, b) => a.from - b.from);
    const gaps: string[] = [];
    let cursor = 0;
    let cursorLabel = "the corner";
    for (const mount of mounts) {
      if (mount.from > cursor) {
        gaps.push(
          `${String(round1(cursor))}-${String(round1(mount.from))} cm (between ${cursorLabel} and ${mount.label})`,
        );
      }
      if (mount.to > cursor) {
        cursor = mount.to;
        cursorLabel = mount.label;
      }
    }
    if (len > cursor) {
      gaps.push(
        `${String(round1(cursor))}-${String(round1(len))} cm (between ${cursorLabel} and the corner)`,
      );
    }
    lines.push(
      `- ${wall.id} "${wallDisplayName(room, wall.id)}": ${gaps.length === 0 ? "no free stretch" : gaps.join("; ")}`,
    );
  }
  const names = new Map(catalog.map((c) => [c.id, c]));
  lines.push("Placed items (instanceId, product, centre, rotationY, variant):");
  if (scene.items.length === 0) {
    lines.push("- none");
  }
  for (const item of scene.items) {
    lines.push(
      `- ${item.instanceId} ${names.get(item.productId)?.name ?? item.productId} ` +
        `at (${String(round1(item.position.x))}, ${String(round1(item.position.z))}) ` +
        `rotationY ${String(round1(item.rotationY))} variant "${item.variant}"`,
    );
  }
  lines.push("Catalog (id, name, category, W x D x H cm, price, seats, style tags, variants):");
  for (const entry of catalog) {
    const variants =
      entry.variants.length === 0 ? "no variants" : entry.variants.map((v) => v.name).join(", ");
    const seats = entry.seats ?? 0;
    const seatWord = seats === 1 ? "1 seat" : `${String(seats)} seats`;
    const styles = entry.styleTags.length === 0 ? "no style tags" : entry.styleTags.join(", ");
    lines.push(
      `- ${entry.id} ${entry.name} [${entry.category}] ` +
        `${String(round1(entry.size.w))} x ${String(round1(entry.size.d))} x ${String(round1(entry.size.h))} cm, ` +
        `${formatUsd(entry.price)}, ${seatWord}, styles ${styles} (${variants})`,
    );
  }
  lines.push(
    "Use place_against_wall to put a piece against a wall (it snaps the back to the wall and turns it " +
      "correctly); pass centred_on with an opening id to centre under a window, or offset_cm for a " +
      "distance along the wall. When the customer names a particular stretch " +
      '(e.g. "between the door and the corner"), they mean the short run right beside that door ' +
      "or corner: the free span listed between 'the corner' and 'the door ...' " +
      "(for example 0-30 cm), starting at its middle — even when a longer run continues on the " +
      "other side of the door. Never substitute the longer run for the named one. " +
      "Make every move with the tools before " +
      "you answer, then call check_fit; never describe a move you have not made. " +
      "Positions are item centres in plan cm. In your final answer use the shopper wall names " +
      "(door wall, back wall, left/right wall, with (window)), never ids like wall-1.",
  );
  return lines.join("\n");
}

/** Flatten one conversation entry for the upstream chat (no native tools). */
function flattenMessage(message: AssistantMessage): UpstreamChatMessage {
  if (message.role === "assistant" && (message.toolCalls ?? []).length > 0) {
    const calls = (message.toolCalls ?? [])
      .map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
      .join(", ");
    const text = message.content === "" ? "Working on the draft." : message.content;
    return { role: "assistant", content: `${text}\n[tool calls: ${calls}]` };
  }
  if (message.role === "tool") {
    const label = message.name === undefined ? "tool" : message.name;
    return { role: "user", content: `Result of ${label}: ${message.content}` };
  }
  return { role: message.role, content: message.content };
}

/**
 * The brief paragraph appended to the system prompt on a furnishing turn
 * (kept meaning, names adapted): what to seat, in which style, for how
 * much, and how to answer.
 */
export function briefPromptAddition(brief: AssistantBrief): string {
  const empty = brief.keepExisting ? "" : ", starting from an empty room";
  return (
    `Furnishing brief: seat ${String(brief.seats)} people, ${briefStyleName(brief.style)} style, ` +
    `new pieces at most ${formatUsd(brief.budget)} in total${empty}. ` +
    "Plan a complete, usable layout from the catalog: one seating group facing a focal point " +
    "(the window, or a TV unit when the shopper asks for one), a coffee table 35-45 cm in front " +
    "of the main seat when there are 3 or more seats, side tables or a plant only if the budget allows. " +
    "Keep 80 cm walking paths and the door swing clear. Prefer pieces of the brief's style; where the " +
    "catalog has none, choose a neutral piece and say so in one sentence. Place all pieces in as few " +
    "rounds as you can, then call check_fit and fix every error. The tools refuse a piece that would " +
    "pass the budget. Never invent products, prices or sizes. " +
    "Answer in at most three sentences: what you chose and why."
  );
}

/** System prompt + room description + flattened conversation. */
export function buildAssistantUpstreamMessages(
  input: AssistantRequest,
  catalog: CatalogItem[],
): UpstreamChatMessage[] {
  const roomText = describeRoomForAssistant(input.room, input.scene, catalog);
  const system =
    input.brief === undefined
      ? ASSISTANT_SYSTEM_PROMPT
      : `${ASSISTANT_SYSTEM_PROMPT} ${briefPromptAddition(input.brief)}`;
  return [
    { role: "system", content: system },
    { role: "user", content: `Customer request: ${input.request}\n\n${roomText}` },
    ...input.messages.map(flattenMessage),
  ];
}
