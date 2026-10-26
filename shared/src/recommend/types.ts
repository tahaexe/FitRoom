/**
 * Recommendation contracts: free-space geometry, the structured request the
 * client sends to `POST /api/recommend`, and the JSON answer Muse Spark must
 * return. Pure TypeScript, no three.js.
 *
 * Division of labour: geometry finds where things can go; Muse Spark only
 * ranks candidates and writes the reasons; the fit engine checks every item
 * before it is shown.
 */

import type { CatalogCategory } from "../types.js";

/** Free stretch along one wall, in centimetres from the wall start. */
export interface FreeRun {
  wall: string;
  start_cm: number;
  end_cm: number;
  length_cm: number;
  /** Usable depth inward from the wall before a walkway or item. */
  depth_cm: number;
}

/** Free floor rectangle in the middle of the room (plan cm). */
export interface OpenArea {
  id: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  w_cm: number;
  d_cm: number;
}

export interface FreeSpace {
  runs: FreeRun[];
  openAreas: OpenArea[];
}

/** Proposed placement of one candidate product. */
export type CandidateSpot =
  | {
      kind: "run";
      wall: string;
      run_cm: [number, number];
      runLength_cm: number;
      /** Run length minus the product width, centimetres. */
      spare_cm: number;
      centre_cm: [number, number];
      /** Yaw with the product back to the wall, degrees. */
      rotationY: number;
    }
  | {
      kind: "area";
      areaId: string;
      area_cm: [number, number];
      /** For seat spots ("seat-front", "seat-side"): the tried gap in cm. */
      spare_cm: number;
      centre_cm: [number, number];
      rotationY: number;
      /** Seat spots only: the gap tried in front of / beside the seat, cm. */
      gap_cm?: number;
      /** Seat spots only: the anchor seat's product name. */
      seat?: string;
    };

/** A product whose footprint fits at least one run or area, by size. */
export interface RecommendCandidate {
  productId: string;
  name: string;
  /** [width, depth, height] in centimetres. */
  size_cm: [number, number, number];
  price_usd: number;
  styleTags: string[];
  colors: string[];
  spot: CandidateSpot;
}

export type RecommendCategory = CatalogCategory | "any";

export interface RecommendQuery {
  category: RecommendCategory;
  budget_usd?: number;
  /**
   * "What fits here?": restrict candidates to this free wall run
   * (people-friendly wall name plus start/end in cm, as listed by the
   * free-space analysis).
   */
  spot?: { wall: string; start_cm: number; end_cm: number };
  /**
   * "Find a replacement": same-category products (minus the selected one)
   * that fit where the selected item stands — same centre and orientation,
   * or slid along its wall run — with the selected instance left out of
   * the fit check.
   */
  replace?: {
    productId: string;
    centre_cm: [number, number];
    rotationY: number;
  };
}

/** Canonical structured body of `POST /api/recommend` (plus `live`). */
export interface RecommendRequest {
  room: {
    name: string;
    size_cm: [number, number];
    style: { tags: string[]; colors: string[] };
  };
  placed: Array<{ productId: string; name: string; colors: string[] }>;
  request: RecommendQuery;
  freeSpace: FreeSpace;
  candidates: RecommendCandidate[];
}

export interface RankedRecommendation {
  productId: string;
  reason: string;
  styleMatch: number;
}

export interface RecommendAnswer {
  recommendations: RankedRecommendation[];
  note?: string;
}

/** The pasted system prompt: Muse Spark ranks and writes reasons only. */
export const RECOMMEND_SYSTEM_PROMPT =
  "You are FitRoom's furniture advisor for a store. You receive a room " +
  "(true-scale, in centimetres), its free spaces, the products already placed, " +
  "the customer's request and budget, and candidate products that physically fit. " +
  "Rank at most 3 candidates. Prefer products whose style and colours match the room " +
  "and the items already there, and that stay within the budget. For each, write one " +
  "short reason (max 140 characters) that cites real numbers from the input (e.g. " +
  '"fits your 260 cm wall with 40 cm to spare") and one style point. Never invent ' +
  "sizes, products or prices. Answer only with JSON that matches the schema.";

/** The pasted output schema, sent as the `response_format` json_schema. */
export const RECOMMEND_OUTPUT_SCHEMA = {
  type: "object",
  required: ["recommendations"],
  properties: {
    recommendations: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["productId", "reason", "styleMatch"],
        properties: {
          productId: { type: "string" },
          reason: { type: "string", maxLength: 140 },
          styleMatch: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    note: { type: "string", maxLength: 160 },
  },
} as const;

/**
 * JSON Schema (draft 2020-12) for {@link RecommendRequest}: the structured
 * `POST /api/recommend` body (without the `live` flag).
 */
export const recommendRequestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://fitroom.app/schemas/recommend-request.schema.json",
  title: "RecommendRequest",
  type: "object",
  properties: {
    room: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        size_cm: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "number", exclusiveMinimum: 0 },
        },
        style: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
            colors: { type: "array", items: { type: "string" } },
          },
          required: ["tags", "colors"],
          additionalProperties: false,
        },
      },
      required: ["name", "size_cm", "style"],
      additionalProperties: false,
    },
    placed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          colors: { type: "array", items: { type: "string" } },
        },
        required: ["productId", "name", "colors"],
        additionalProperties: false,
      },
    },
    request: {
      type: "object",
      properties: {
        category: { type: "string", minLength: 1 },
        budget_usd: { type: "number", minimum: 0 },
        spot: {
          type: "object",
          properties: {
            wall: { type: "string", minLength: 1 },
            start_cm: { type: "number", minimum: 0 },
            end_cm: { type: "number", minimum: 0 },
          },
          required: ["wall", "start_cm", "end_cm"],
          additionalProperties: false,
        },
        replace: {
          type: "object",
          properties: {
            productId: { type: "string", minLength: 1 },
            centre_cm: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: { type: "number" },
            },
            rotationY: { type: "number" },
          },
          required: ["productId", "centre_cm", "rotationY"],
          additionalProperties: false,
        },
      },
      required: ["category"],
      additionalProperties: false,
    },
    freeSpace: {
      type: "object",
      properties: {
        runs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              wall: { type: "string", minLength: 1 },
              start_cm: { type: "number", minimum: 0 },
              end_cm: { type: "number", minimum: 0 },
              length_cm: { type: "number", exclusiveMinimum: 0 },
              depth_cm: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["wall", "start_cm", "end_cm", "length_cm", "depth_cm"],
            additionalProperties: false,
          },
        },
        openAreas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              x0: { type: "number" },
              z0: { type: "number" },
              x1: { type: "number" },
              z1: { type: "number" },
              w_cm: { type: "number", exclusiveMinimum: 0 },
              d_cm: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["id", "x0", "z0", "x1", "z1", "w_cm", "d_cm"],
            additionalProperties: false,
          },
        },
      },
      required: ["runs", "openAreas"],
      additionalProperties: false,
    },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          size_cm: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: { type: "number", exclusiveMinimum: 0 },
          },
          price_usd: { type: "number", minimum: 0 },
          styleTags: { type: "array", items: { type: "string" } },
          colors: { type: "array", items: { type: "string" } },
          spot: {
            type: "object",
            properties: {
              kind: { enum: ["run", "area"] },
              wall: { type: "string" },
              run_cm: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: { type: "number" },
              },
              runLength_cm: { type: "number" },
              areaId: { type: "string" },
              area_cm: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: { type: "number" },
              },
              spare_cm: { type: "number" },
              centre_cm: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: { type: "number" },
              },
              rotationY: { type: "number" },
              gap_cm: { type: "number", minimum: 0 },
              seat: { type: "string", minLength: 1 },
            },
            required: ["kind", "spare_cm", "centre_cm", "rotationY"],
            additionalProperties: false,
          },
        },
        required: ["productId", "name", "size_cm", "price_usd", "styleTags", "colors", "spot"],
        additionalProperties: false,
      },
    },
  },
  required: ["room", "placed", "request", "freeSpace", "candidates"],
  additionalProperties: false,
} as const;
