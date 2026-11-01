/** JSON Schema (draft 2020-12) for {@link SceneState}. */
export const sceneStateSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://fitroom.app/schemas/scene-state.schema.json",
  title: "SceneState",
  description: "Placed catalog items in plan centimetres plus the camera.",
  type: "object",
  properties: {
    roomId: { type: "string", minLength: 1 },
    items: {
      type: "array",
      items: { $ref: "#/$defs/item" },
    },
    camera: { $ref: "#/$defs/camera" },
  },
  required: ["roomId", "items", "camera"],
  additionalProperties: false,
  $defs: {
    item: {
      type: "object",
      properties: {
        instanceId: { type: "string", minLength: 1 },
        productId: { type: "string", minLength: 1 },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            z: { type: "number" },
          },
          required: ["x", "z"],
          additionalProperties: false,
        },
        rotationY: { type: "number" },
        variant: { type: "string" },
      },
      required: ["instanceId", "productId", "position", "rotationY", "variant"],
      additionalProperties: false,
    },
    camera: {
      type: "object",
      properties: {
        mode: { enum: ["orbit", "plan"] },
        position: { $ref: "#/$defs/vector" },
        target: { $ref: "#/$defs/vector" },
      },
      required: ["mode", "position", "target"],
      additionalProperties: false,
    },
    vector: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
      },
      required: ["x", "y", "z"],
      additionalProperties: false,
    },
  },
} as const;
