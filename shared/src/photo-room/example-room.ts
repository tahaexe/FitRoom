/**
 * The example room's shared finishes and style (single source).
 *
 * Both the client's example mode (`client/src/photo-room/flow.ts`) and the
 * server's `readExampleRoom()` (`server/src/assistant-demo.ts`) build the
 * example room from these values, and the fixture
 * `shared/samples/example-room.json` holds them.
 */

export const EXAMPLE_ROOM_FLOOR = "WoodFloor039";

export const EXAMPLE_ROOM_WALL = "PaintedPlaster017";

export const EXAMPLE_ROOM_WALL_TINT = "#DEDEDC";

export const EXAMPLE_ROOM_STYLE_TAGS: readonly string[] = [
  "minimalist",
  "scandinavian",
  "bright",
];

export const EXAMPLE_ROOM_STYLE_COLORS: readonly string[] = [
  "#f2eee6",
  "#d9c19a",
  "#8a6742",
];

export const EXAMPLE_ROOM_SURFACES = {
  floor: EXAMPLE_ROOM_FLOOR,
  wall: EXAMPLE_ROOM_WALL,
  wallTint: EXAMPLE_ROOM_WALL_TINT,
} as const;

export const EXAMPLE_ROOM_STYLE = {
  tags: [...EXAMPLE_ROOM_STYLE_TAGS],
  dominantColors: [...EXAMPLE_ROOM_STYLE_COLORS],
};
