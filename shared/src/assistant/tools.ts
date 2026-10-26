/**
 * The pasted tool table as JSON Schemas, sent to Muse Spark as OpenAI
 * `tools` (each function nested under `function`). Positions are centres in
 * plan centimetres (x east, z north); rotationY in degrees, 0 = front faces
 * north (+z), 90 = east, 180 = south, 270 = west.
 */

export const ASSISTANT_TOOL_NAMES = [
  "get_room",
  "list_items",
  "list_catalog",
  "place_item",
  "move_item",
  "rotate_item",
  "remove_item",
  "check_fit",
  "set_variant",
  "place_against_wall",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

export function isAssistantToolName(name: string): name is AssistantToolName {
  return (ASSISTANT_TOOL_NAMES as readonly string[]).includes(name);
}

const SCHEMAS: Record<AssistantToolName, Record<string, unknown>> = {
  get_room: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  list_items: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  list_catalog: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Filter by catalog category (sofa, armchair, coffee-table, ...).",
      },
    },
    additionalProperties: false,
  },
  place_item: {
    type: "object",
    required: ["productId", "x", "z", "rotationY"],
    properties: {
      productId: { type: "string" },
      x: { type: "number", description: "Centre x in plan cm (east)." },
      z: { type: "number", description: "Centre z in plan cm (north)." },
      rotationY: {
        type: "number",
        description: "Degrees: 0 faces north, 90 east, 180 south, 270 west.",
      },
      variant: { type: "string", description: "Variant name (omit for the default)." },
    },
    additionalProperties: false,
  },
  move_item: {
    type: "object",
    required: ["instanceId", "x", "z"],
    properties: {
      instanceId: { type: "string" },
      x: { type: "number" },
      z: { type: "number" },
    },
    additionalProperties: false,
  },
  rotate_item: {
    type: "object",
    required: ["instanceId", "rotationY"],
    properties: {
      instanceId: { type: "string" },
      rotationY: { type: "number" },
    },
    additionalProperties: false,
  },
  remove_item: {
    type: "object",
    required: ["instanceId"],
    properties: {
      instanceId: { type: "string" },
    },
    additionalProperties: false,
  },
  check_fit: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  set_variant: {
    type: "object",
    required: ["instanceId", "variant"],
    properties: {
      instanceId: { type: "string" },
      variant: { type: "string" },
    },
    additionalProperties: false,
  },
  place_against_wall: {
    type: "object",
    required: ["wallId", "offset_cm"],
    properties: {
      productId: {
        type: "string",
        description: "New piece to place (one of productId, instanceId).",
      },
      instanceId: {
        type: "string",
        description: "Existing piece to move (one of productId, instanceId).",
      },
      wallId: { type: "string" },
      offset_cm: {
        type: "number",
        description: "Distance of the item's centre from the wall start along the wall.",
      },
      centred_on: {
        type: "string",
        description: "Opening id to centre on (e.g. a window); overrides offset_cm.",
      },
    },
    additionalProperties: false,
  },
};

const DESCRIPTIONS: Record<AssistantToolName, string> = {
  get_room:
    "Room walls (id, shopper name, start, end, length), openings (id, wall, type, span, sill, hinge, swing), fixtures and free wall runs.",
  list_items: "Placed items: instanceId, productId, name, centre, rotationY, footprint, variant.",
  list_catalog: "Catalog products: id, name, category, size {w,d,h} cm, price, variants.",
  place_item:
    "Place a catalog product at a centre (x, z) with rotationY. Returns instanceId, footprint and fit issues touching it.",
  move_item: "Move a placed item to a centre (x, z). Returns footprint and fit issues touching it.",
  rotate_item:
    "Rotate a placed item to rotationY degrees. Returns footprint and fit issues touching it.",
  remove_item: "Remove a placed item from the draft.",
  check_fit: "All fit issues of the draft scene (errors must be fixed before answering).",
  set_variant: "Set a fabric/variant name on a placed item. Returns ok or the allowed variants.",
  place_against_wall:
    "Place a new product or move an existing item against a wall: the back snaps to the wall's inner face and the front turns into the room. Pass centred_on with an opening id to centre under it.",
};

/** OpenAI `tools` array for the upstream call. */
export const ASSISTANT_TOOLS: Array<Record<string, unknown>> = ASSISTANT_TOOL_NAMES.map((name) => ({
  type: "function",
  function: {
    name,
    description: DESCRIPTIONS[name],
    parameters: SCHEMAS[name],
  },
}));
