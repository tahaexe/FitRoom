export interface HealthResponse {
  ok: true;
  version: string;
}

export const healthResponseSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "HealthResponse",
  type: "object",
  properties: {
    ok: { const: true },
    version: { type: "string", minLength: 1 },
  },
  required: ["ok", "version"],
  additionalProperties: false,
} as const;

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["ok"] === true && typeof record["version"] === "string";
}
