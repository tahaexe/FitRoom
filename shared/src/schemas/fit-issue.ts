/** JSON Schema (draft 2020-12) for {@link FitIssue}. */
export const fitIssueSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://fitroom.app/schemas/fit-issue.schema.json",
  title: "FitIssue",
  description: "A placement problem found in a scene, located in plan centimetres.",
  type: "object",
  properties: {
    type: { enum: ["overlap", "outside", "door-swing", "walkway", "walkway-entrance", "window"] },
    severity: { enum: ["error", "warning"] },
    itemIds: { type: "array", items: { type: "string" } },
    message: { type: "string", minLength: 1 },
    location: {
      type: "object",
      properties: {
        x: { type: "number" },
        z: { type: "number" },
      },
      required: ["x", "z"],
      additionalProperties: false,
    },
  },
  required: ["type", "severity", "itemIds", "message", "location"],
  additionalProperties: false,
} as const;
