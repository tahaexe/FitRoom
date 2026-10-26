/**
 * JSON Schema (draft 2020-12) for {@link RoomLayout}. Closure and winding of
 * the wall polygon plus cross-references are enforced in `validate.js`, which
 * reports them with JSON paths.
 */
export const roomLayoutSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://fitroom.app/schemas/room-layout.schema.json",
  title: "RoomLayout",
  description:
    "A room plan in centimetres (x east, z north, origin at the inner south-west corner).",
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    units: { const: "cm" },
    walls: {
      type: "array",
      minItems: 3,
      items: { $ref: "#/$defs/wall" },
    },
    openings: {
      type: "array",
      items: { $ref: "#/$defs/opening" },
    },
    fixtures: {
      type: "array",
      items: { $ref: "#/$defs/fixture" },
    },
    existing: {
      type: "array",
      items: { $ref: "#/$defs/existing" },
    },
    surfaces: {
      type: "object",
      properties: {
        floor: { type: "string", minLength: 1 },
        wall: { type: "string", minLength: 1 },
      },
      required: ["floor", "wall"],
      additionalProperties: false,
    },
    style: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        dominantColors: { type: "array", items: { type: "string" } },
      },
      required: ["tags", "dominantColors"],
      additionalProperties: false,
    },
    source: { enum: ["sample", "photos"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "id",
    "name",
    "units",
    "walls",
    "openings",
    "fixtures",
    "existing",
    "surfaces",
    "style",
    "source",
    "confidence",
  ],
  additionalProperties: false,
  $defs: {
    planPoint: {
      type: "object",
      properties: {
        x: { type: "number" },
        z: { type: "number" },
      },
      required: ["x", "z"],
      additionalProperties: false,
    },
    wall: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        start: { $ref: "#/$defs/planPoint" },
        end: { $ref: "#/$defs/planPoint" },
        height: { type: "number", exclusiveMinimum: 0 },
        thickness: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["id", "start", "end", "height", "thickness"],
      additionalProperties: false,
    },
    opening: {
      oneOf: [
        {
          title: "door",
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            wallId: { type: "string", minLength: 1 },
            type: { const: "door" },
            offset: { type: "number", minimum: 0 },
            width: { type: "number", exclusiveMinimum: 0 },
            height: { type: "number", exclusiveMinimum: 0 },
            sillHeight: { type: "number", minimum: 0 },
            hinge: { enum: ["left", "right"] },
            swing: { enum: ["in", "out"] },
          },
          required: [
            "id",
            "wallId",
            "type",
            "offset",
            "width",
            "height",
            "sillHeight",
            "hinge",
            "swing",
          ],
          additionalProperties: false,
        },
        {
          title: "window",
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            wallId: { type: "string", minLength: 1 },
            type: { const: "window" },
            offset: { type: "number", minimum: 0 },
            width: { type: "number", exclusiveMinimum: 0 },
            height: { type: "number", exclusiveMinimum: 0 },
            sillHeight: { type: "number", minimum: 0 },
          },
          required: ["id", "wallId", "type", "offset", "width", "height", "sillHeight"],
          additionalProperties: false,
        },
      ],
    },
    fixture: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        type: { enum: ["radiator", "column", "other"] },
        wallId: { type: "string", minLength: 1 },
        offset: { type: "number", minimum: 0 },
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
        depth: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["id", "wallId", "type", "offset", "width", "height", "depth"],
      additionalProperties: false,
    },
    existing: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 },
        footprint: {
          type: "object",
          properties: {
            x: { type: "number" },
            z: { type: "number" },
            w: { type: "number", exclusiveMinimum: 0 },
            d: { type: "number", exclusiveMinimum: 0 },
            rotationY: { type: "number" },
          },
          required: ["x", "z", "w", "d", "rotationY"],
          additionalProperties: false,
        },
        height: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["id", "label", "footprint", "height"],
      additionalProperties: false,
    },
  },
} as const;
