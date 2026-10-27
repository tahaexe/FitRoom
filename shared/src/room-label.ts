/**
 * Room photo labels (`POST /api/room/label`): the contract Muse Spark
 * answers with, validated like the other routes' answers.
 *
 * Spark labels from the photos alone and never locates or measures
 * anything: overall style, the floor and wall families, per-photo counts
 * of what is visible, and one plain sentence of uncertainty.
 *
 * `normalizeRoomLabelAnswer` fixes what is easy to fix (tag case, `#rgb`
 * colours, long descriptions, an empty `uncertain`) instead of failing;
 * only a missing or wrong-typed field, a family outside its list, or
 * photos that don't match the request's letters fail.
 */

export const ROOM_LABEL_WALLS = ["A", "B", "C", "D"] as const;

export type RoomLabelWall = (typeof ROOM_LABEL_WALLS)[number];

export const ROOM_LABEL_FLOOR_FAMILIES = ["wood", "tile", "carpet", "concrete", "other"] as const;

export type RoomLabelFloorFamily = (typeof ROOM_LABEL_FLOOR_FAMILIES)[number];

export const ROOM_LABEL_WALL_FAMILIES = [
  "paint",
  "wallpaper",
  "tile",
  "concrete",
  "brick",
  "wood",
  "other",
] as const;

export type RoomLabelWallFamily = (typeof ROOM_LABEL_WALL_FAMILIES)[number];

export interface RoomLabelPhotoCounts {
  wall: string;
  doors: number;
  openDoorways: number;
  windows: number;
  glassDoors: number;
  /** Mirrors, pictures or screens that could pass for an opening. */
  lookalikes: number;
}

export interface RoomLabelAnswer {
  style: {
    /** At most 5 tags of one to three lowercase words. */
    tags: string[];
    /** At most 5 6-digit hex colours. */
    dominantColors: string[];
  };
  floor: {
    family: RoomLabelFloorFamily;
    /** A short phrase, at most 120 characters. */
    description: string;
  };
  walls: {
    family: RoomLabelWallFamily;
    /** A short phrase, at most 120 characters. */
    description: string;
  };
  photos: RoomLabelPhotoCounts[];
  /** One plain sentence; `Nothing.` when nothing was uncertain. */
  uncertain: string;
}

/** `response_format: json_schema` for the label call (Muse Spark). */
export const ROOM_LABEL_OUTPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "RoomLabelAnswer",
  type: "object",
  properties: {
    style: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
            maxLength: 30,
            description: "one to three lowercase words, at most 30 characters",
          },
          maxItems: 5,
        },
        dominantColors: {
          type: "array",
          items: {
            type: "string",
            pattern: "^#[0-9a-fA-F]{6}$",
            description: "a 6-digit hex colour like #c8a27a",
          },
          maxItems: 5,
        },
      },
      required: ["tags", "dominantColors"],
      additionalProperties: false,
    },
    floor: {
      type: "object",
      properties: {
        family: { enum: [...ROOM_LABEL_FLOOR_FAMILIES] },
        description: {
          type: "string",
          maxLength: 120,
          description: "a short phrase, at most 120 characters",
        },
      },
      required: ["family", "description"],
      additionalProperties: false,
    },
    walls: {
      type: "object",
      properties: {
        family: { enum: [...ROOM_LABEL_WALL_FAMILIES] },
        description: {
          type: "string",
          maxLength: 120,
          description: "a short phrase, at most 120 characters",
        },
      },
      required: ["family", "description"],
      additionalProperties: false,
    },
    photos: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          wall: { type: "string" },
          doors: { type: "integer", minimum: 0 },
          openDoorways: { type: "integer", minimum: 0 },
          windows: { type: "integer", minimum: 0 },
          glassDoors: { type: "integer", minimum: 0 },
          lookalikes: { type: "integer", minimum: 0 },
        },
        required: ["wall", "doors", "openDoorways", "windows", "glassDoors", "lookalikes"],
        additionalProperties: false,
      },
    },
    uncertain: {
      type: "string",
      description: "one plain sentence; Nothing. when nothing was uncertain",
    },
  },
  required: ["style", "floor", "walls", "photos", "uncertain"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTag(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 30) return false;
  if (value !== value.trim() || value !== value.toLowerCase()) return false;
  return value.split(/\s+/).length <= 3;
}

function isHexColor(value: unknown): boolean {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

function isShortPhrase(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 120;
}

/**
 * Friendly reason why a room label answer is invalid, or null when it is
 * fine. `walls` are the request's photo letters in order: the answer must
 * cover exactly those photos in that order.
 */
export function roomLabelAnswerError(data: unknown, walls: string[]): string | null {
  if (!isRecord(data)) return "The answer is not a JSON object.";
  const style = data["style"];
  if (!isRecord(style)) return "The answer needs a style.";
  if (!Array.isArray(style["tags"]) || style["tags"].length > 5) {
    return "The style needs at most 5 tags.";
  }
  for (const tag of style["tags"]) {
    if (!isTag(tag)) return "Each style tag is one to three lowercase words.";
  }
  if (!Array.isArray(style["dominantColors"]) || style["dominantColors"].length > 5) {
    return "The style needs at most 5 dominant colours.";
  }
  for (const color of style["dominantColors"]) {
    if (!isHexColor(color)) return "Each dominant colour is a hex colour.";
  }
  const floor = data["floor"];
  if (!isRecord(floor)) return "The answer needs a floor.";
  if (
    typeof floor["family"] !== "string" ||
    !(ROOM_LABEL_FLOOR_FAMILIES as readonly string[]).includes(floor["family"])
  ) {
    return "The floor family is wood, tile, carpet, concrete or other.";
  }
  if (!isShortPhrase(floor["description"])) return "The floor needs a short description.";
  const wallInfo = data["walls"];
  if (!isRecord(wallInfo)) return "The answer needs walls.";
  if (
    typeof wallInfo["family"] !== "string" ||
    !(ROOM_LABEL_WALL_FAMILIES as readonly string[]).includes(wallInfo["family"])
  ) {
    return "The wall family is paint, wallpaper, tile, concrete, brick, wood or other.";
  }
  if (!isShortPhrase(wallInfo["description"])) return "The walls need a short description.";
  const photos = data["photos"];
  if (!Array.isArray(photos) || photos.length !== walls.length) {
    return "The answer covers each photo once.";
  }
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (!isRecord(photo)) return "Each photo needs its visible counts.";
    if (photo["wall"] !== walls[i]) return "Each photo keeps its wall letter.";
    for (const key of ["doors", "openDoorways", "windows", "glassDoors", "lookalikes"]) {
      if (!isCount(photo[key])) return `The ${key} count is a number of at least 0.`;
    }
  }
  const uncertain = data["uncertain"];
  if (typeof uncertain !== "string" || uncertain.length === 0 || uncertain.length > 300) {
    return "The answer needs one plain uncertain sentence.";
  }
  if (/[\r\n]/.test(uncertain)) return "The uncertain sentence is one line.";
  return null;
}

export function isRoomLabelAnswer(data: unknown, walls: string[]): data is RoomLabelAnswer {
  return roomLabelAnswerError(data, walls) === null;
}

/** A tag trimmed and lowercased, or null when it cannot be kept. */
function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase();
  if (tag.length === 0 || tag.length > 30) return null;
  if (tag.split(/\s+/).length > 3) return null;
  return tag;
}

/** A colour as 6-digit lowercase hex (`#rgb` expanded), or null when dropped. */
function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(color);
  if (short !== null) {
    const digits = (short[1] ?? "").toLowerCase();
    return `#${digits[0] ?? ""}${digits[0] ?? ""}${digits[1] ?? ""}${digits[1] ?? ""}${digits[2] ?? ""}${digits[2] ?? ""}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  return null;
}

/** A description cut to 120 characters, or null when missing. */
function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 120);
}

/**
 * Normalize a room label answer: tags trimmed and lowercased (up to three
 * words and 30 characters, others dropped, at most 5 kept), `#rgb` colours
 * expanded to `#rrggbb` (anything that isn't hex dropped), descriptions cut
 * to 120 characters, and an empty `uncertain` becoming `Nothing.`.
 * Returns null only when a field is missing or wrong-typed, a family is
 * outside its list, or the photos don't match the request's letters.
 */
export function normalizeRoomLabelAnswer(data: unknown, walls: string[]): RoomLabelAnswer | null {
  if (!isRecord(data)) return null;
  const style = data["style"];
  if (!isRecord(style)) return null;
  if (!Array.isArray(style["tags"])) return null;
  const tags: string[] = [];
  for (const tag of style["tags"]) {
    if (tags.length >= 5) break;
    const kept = normalizeTag(tag);
    if (kept !== null) tags.push(kept);
  }
  if (!Array.isArray(style["dominantColors"])) return null;
  const dominantColors: string[] = [];
  for (const color of style["dominantColors"]) {
    if (dominantColors.length >= 5) break;
    const kept = normalizeColor(color);
    if (kept !== null) dominantColors.push(kept);
  }
  const floor = data["floor"];
  if (!isRecord(floor)) return null;
  if (
    typeof floor["family"] !== "string" ||
    !(ROOM_LABEL_FLOOR_FAMILIES as readonly string[]).includes(floor["family"])
  ) {
    return null;
  }
  const floorDescription = normalizeDescription(floor["description"]);
  if (floorDescription === null) return null;
  const wallInfo = data["walls"];
  if (!isRecord(wallInfo)) return null;
  if (
    typeof wallInfo["family"] !== "string" ||
    !(ROOM_LABEL_WALL_FAMILIES as readonly string[]).includes(wallInfo["family"])
  ) {
    return null;
  }
  const wallsDescription = normalizeDescription(wallInfo["description"]);
  if (wallsDescription === null) return null;
  const photos = data["photos"];
  if (!Array.isArray(photos) || photos.length !== walls.length) return null;
  const counts: RoomLabelPhotoCounts[] = [];
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (!isRecord(photo)) return null;
    if (photo["wall"] !== walls[i]) return null;
    const entry: Record<string, unknown> = { wall: walls[i] };
    for (const key of ["doors", "openDoorways", "windows", "glassDoors", "lookalikes"]) {
      if (!isCount(photo[key])) return null;
      entry[key] = photo[key];
    }
    counts.push(entry as unknown as RoomLabelPhotoCounts);
  }
  const rawUncertain = data["uncertain"];
  if (typeof rawUncertain !== "string") return null;
  const oneLine = rawUncertain.replace(/[\r\n]+/g, " ").trim();
  const uncertain = oneLine === "" ? "Nothing." : oneLine.slice(0, 300);
  return {
    style: { tags, dominantColors },
    floor: {
      family: floor["family"] as RoomLabelFloorFamily,
      description: floorDescription,
    },
    walls: {
      family: wallInfo["family"] as RoomLabelWallFamily,
      description: wallsDescription,
    },
    photos: counts,
    uncertain,
  };
}

/**
 * Client defaults when the label route fails: no tags or colours,
 * families `other`, zero counts and one plain uncertain sentence.
 */
export function defaultRoomLabel(walls: string[]): RoomLabelAnswer {
  return {
    style: { tags: [], dominantColors: [] },
    floor: { family: "other", description: "unknown" },
    walls: { family: "other", description: "unknown" },
    photos: walls.map((wall) => ({
      wall,
      doors: 0,
      openDoorways: 0,
      windows: 0,
      glassDoors: 0,
      lookalikes: 0,
    })),
    uncertain: "The room details are unknown.",
  };
}
