/**
 * SAM segmentation instances: turns a `POST /api/room/segment` answer
 * (`{ concept, text }`) into box instances with decoded masks.
 *
 * The text is fed to `@meta-sam/parser` as one output-text lane (see its
 * README: stream events plus `formats.segmentation.image()`); boxes come
 * back half-open, so the instance box keeps the wire convention
 * `[x1, y1, x2, y2]` with `x2`/`y2` inclusive. Each mask is a binary
 * row-major `Uint8Array` covering exactly its box.
 */

import {
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from "@meta-sam/parser";

export interface SamMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface SamInstance {
  concept: string;
  id: string;
  box: [number, number, number, number];
  imageWidth: number;
  imageHeight: number;
  mask: SamMask;
}

/** Frame size from the box tokens (`w=..;h=..`); every token must agree. */
function frameSizeOfText(text: string): { width: number; height: number } {
  let found: { width: number; height: number } | null = null;
  for (const match of text.matchAll(/w=(\d+);h=(\d+)/g)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error("The segmentation answer has an invalid frame size.");
    }
    if (found === null) {
      found = { width, height };
    } else if (found.width !== width || found.height !== height) {
      throw new Error("The segmentation answer mixes frame sizes.");
    }
  }
  if (found === null) {
    throw new Error("The segmentation answer names no frame size.");
  }
  return found;
}

async function* laneEvents(text: string): AsyncIterable<ResponsesEvent> {
  yield {
    type: "response.output_text.delta",
    item_id: "sam-0",
    output_index: 0,
    content_index: 0,
    delta: text,
  };
  yield {
    type: "response.output_text.done",
    item_id: "sam-0",
    output_index: 0,
    content_index: 0,
    text,
  };
  yield { type: "response.completed" };
}

/**
 * Decode one segment answer into instances, in output order. Throws when
 * the text is not a completed segmentation lane.
 */
export async function segmentInstances(concept: string, text: string): Promise<SamInstance[]> {
  const frame = frameSizeOfText(text);
  const result = await parseImageStream(laneEvents(text)).finalResult;
  if (result.outcome.status !== "completed") {
    throw new Error("The segmentation answer did not complete.");
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === "error") {
      throw new Error(`The segmentation answer is malformed: ${diagnostic.message}`);
    }
  }
  const boxes = recordsOfKind(result.records, "box");
  const masks = recordsOfKind(result.records, "mask");
  const boxById = new Map(boxes.map((box) => [box.objectId, box]));
  const instances: SamInstance[] = [];
  for (const mask of masks) {
    const box = boxById.get(mask.objectId);
    if (box === undefined) {
      throw new Error("The segmentation answer has a mask without a box.");
    }
    const x1 = box.left;
    const y1 = box.top;
    const x2 = box.right - 1;
    const y2 = box.bottom - 1;
    if (x2 < x1 || y2 < y1 || box.right > frame.width || box.bottom > frame.height) {
      throw new Error("The segmentation answer has a box outside its image.");
    }
    const data = decodeMaskToRaster(mask.mask);
    instances.push({
      concept,
      id: mask.objectId,
      box: [x1, y1, x2, y2],
      imageWidth: frame.width,
      imageHeight: frame.height,
      mask: { width: mask.mask.width, height: mask.mask.height, data },
    });
  }
  return instances;
}
