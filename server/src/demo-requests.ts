/**
 * Demo request lists, one per route. `npm run demo:record -- <route>` sends
 * the route's list through the live pipeline with recording on (the
 * assistant list holds the six scripted turns' first rounds; recording runs
 * the whole multi-round turn per request).
 *
 * The recommend list holds the four recorded requests for the demo room
 * (the sample room with `shared/samples/fit-tests/valid.json`): coffee
 * tables (in front of the sofa), shelves, "What fits here?" on the longest
 * free run of the back wall, and "Find a replacement" for the Chester
 * Leather Sofa. Generated with the shared code — see
 * `src/recommend-demo.ts` (`check:recommend` rebuilds and compares).
 */

import { buildAssistantDemoRequests } from "./assistant-demo.js";

export const DEMO_REQUESTS: Record<"recommend" | "assistant" | "render", unknown[]> = {
  recommend: [
    {
      room: {
        name: "Living room 420 × 360",
        size_cm: [420, 360],
        style: {
          tags: ["modern", "neutral"],
          colors: ["#E8E2D9", "#A8A29E"],
        },
      },
      placed: [
        {
          productId: "modern_arm_chair_01",
          name: "Nord Leather Armchair",
          colors: ["black leather", "oak"],
        },
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          colors: ["warm wood frame", "stone top"],
        },
        {
          productId: "modern_wooden_cabinet",
          name: "Rhythm TV Unit",
          colors: ["walnut slats", "black legs"],
        },
        {
          productId: "sofa_02",
          name: "Chester Leather Sofa",
          colors: ["black leather", "dark wood"],
        },
      ],
      request: {
        category: "coffee-table",
      },
      freeSpace: {
        runs: [
          {
            wall: "Door wall",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "Right wall (window)",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "Back wall (window)",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "Back wall (window)",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "Left wall",
            start_cm: 10,
            end_cm: 65,
            length_cm: 55,
            depth_cm: 150,
          },
        ],
        openAreas: [
          {
            id: "area-1",
            x0: 220,
            z0: 80,
            x1: 330,
            z1: 280,
            w_cm: 110,
            d_cm: 200,
          },
        ],
      },
      candidates: [
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          size_cm: [120.2, 60, 39],
          price_usd: 340,
          styleTags: ["modern"],
          colors: ["warm wood frame", "stone top"],
          spot: {
            kind: "area",
            areaId: "seat-front",
            area_cm: [180.7, 105],
            spare_cm: 45,
            centre_cm: [156.9, 200],
            rotationY: 90,
            gap_cm: 45,
            seat: "Chester Leather Sofa",
          },
        },
        {
          productId: "coffee_table_round_01",
          name: "Luna Marble Coffee Table",
          size_cm: [130.1, 130.1, 49.1],
          price_usd: 560,
          styleTags: ["modern", "glam"],
          colors: ["white marble", "black metal"],
          spot: {
            kind: "area",
            areaId: "seat-front",
            area_cm: [180.7, 175.1],
            spare_cm: 45,
            centre_cm: [192, 200],
            rotationY: 90,
            gap_cm: 45,
            seat: "Chester Leather Sofa",
          },
        },
      ],
    },
    {
      room: {
        name: "Living room 420 × 360",
        size_cm: [420, 360],
        style: {
          tags: ["modern", "neutral"],
          colors: ["#E8E2D9", "#A8A29E"],
        },
      },
      placed: [
        {
          productId: "modern_arm_chair_01",
          name: "Nord Leather Armchair",
          colors: ["black leather", "oak"],
        },
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          colors: ["warm wood frame", "stone top"],
        },
        {
          productId: "modern_wooden_cabinet",
          name: "Rhythm TV Unit",
          colors: ["walnut slats", "black legs"],
        },
        {
          productId: "sofa_02",
          name: "Chester Leather Sofa",
          colors: ["black leather", "dark wood"],
        },
      ],
      request: {
        category: "shelf",
      },
      freeSpace: {
        runs: [
          {
            wall: "Door wall",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "Right wall (window)",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "Back wall (window)",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "Back wall (window)",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "Left wall",
            start_cm: 10,
            end_cm: 65,
            length_cm: 55,
            depth_cm: 150,
          },
        ],
        openAreas: [
          {
            id: "area-1",
            x0: 220,
            z0: 80,
            x1: 330,
            z1: 280,
            w_cm: 110,
            d_cm: 200,
          },
        ],
      },
      candidates: [
        {
          productId: "wooden_display_shelves_01",
          name: "Cube Shelf 3×3",
          size_cm: [107.8, 37.2, 155.6],
          price_usd: 210,
          styleTags: ["Scandinavian"],
          colors: ["light wood", "grey fabric boxes"],
          spot: {
            kind: "run",
            wall: "Door wall",
            run_cm: [230, 415],
            runLength_cm: 185,
            spare_cm: 77.2,
            centre_cm: [322.5, 22.6],
            rotationY: 0,
          },
        },
      ],
    },
    {
      room: {
        name: "Living room 420 × 360",
        size_cm: [420, 360],
        style: {
          tags: ["modern", "neutral"],
          colors: ["#E8E2D9", "#A8A29E"],
        },
      },
      placed: [
        {
          productId: "modern_arm_chair_01",
          name: "Nord Leather Armchair",
          colors: ["black leather", "oak"],
        },
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          colors: ["warm wood frame", "stone top"],
        },
        {
          productId: "modern_wooden_cabinet",
          name: "Rhythm TV Unit",
          colors: ["walnut slats", "black legs"],
        },
        {
          productId: "sofa_02",
          name: "Chester Leather Sofa",
          colors: ["black leather", "dark wood"],
        },
      ],
      request: {
        category: "any",
        spot: {
          wall: "Back wall (window)",
          start_cm: 240,
          end_cm: 415,
        },
      },
      freeSpace: {
        runs: [
          {
            wall: "Door wall",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "Right wall (window)",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "Back wall (window)",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "Back wall (window)",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "Left wall",
            start_cm: 10,
            end_cm: 65,
            length_cm: 55,
            depth_cm: 150,
          },
        ],
        openAreas: [
          {
            id: "area-1",
            x0: 220,
            z0: 80,
            x1: 330,
            z1: 280,
            w_cm: 110,
            d_cm: 200,
          },
        ],
      },
      candidates: [
        {
          productId: "Ottoman_01",
          name: "Chester Ottoman",
          size_cm: [88.5, 62.1, 62.4],
          price_usd: 290,
          styleTags: ["classic"],
          colors: ["black leather"],
          spot: {
            kind: "run",
            wall: "Back wall (window)",
            run_cm: [240, 415],
            runLength_cm: 175,
            spare_cm: 86.5,
            centre_cm: [92.5, 325],
            rotationY: 180,
          },
        },
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          size_cm: [120.2, 60, 39],
          price_usd: 340,
          styleTags: ["modern"],
          colors: ["warm wood frame", "stone top"],
          spot: {
            kind: "run",
            wall: "Back wall (window)",
            run_cm: [240, 415],
            runLength_cm: 175,
            spare_cm: 54.8,
            centre_cm: [92.5, 326],
            rotationY: 180,
          },
        },
        {
          productId: "side_table_01",
          name: "Pine Side Table",
          size_cm: [55, 45, 55.1],
          price_usd: 120,
          styleTags: ["simple", "Scandinavian"],
          colors: ["light wood"],
          spot: {
            kind: "run",
            wall: "Back wall (window)",
            run_cm: [240, 415],
            runLength_cm: 175,
            spare_cm: 120,
            centre_cm: [92.5, 333.5],
            rotationY: 180,
          },
        },
        {
          productId: "wooden_display_shelves_01",
          name: "Cube Shelf 3×3",
          size_cm: [107.8, 37.2, 155.6],
          price_usd: 210,
          styleTags: ["Scandinavian"],
          colors: ["light wood", "grey fabric boxes"],
          spot: {
            kind: "run",
            wall: "Back wall (window)",
            run_cm: [240, 415],
            runLength_cm: 175,
            spare_cm: 67.2,
            centre_cm: [92.5, 337.4],
            rotationY: 180,
          },
        },
      ],
    },
    {
      room: {
        name: "Living room 420 × 360",
        size_cm: [420, 360],
        style: {
          tags: ["modern", "neutral"],
          colors: ["#E8E2D9", "#A8A29E"],
        },
      },
      placed: [
        {
          productId: "modern_arm_chair_01",
          name: "Nord Leather Armchair",
          colors: ["black leather", "oak"],
        },
        {
          productId: "modern_coffee_table_01",
          name: "Slate Coffee Table",
          colors: ["warm wood frame", "stone top"],
        },
        {
          productId: "modern_wooden_cabinet",
          name: "Rhythm TV Unit",
          colors: ["walnut slats", "black legs"],
        },
        {
          productId: "sofa_02",
          name: "Chester Leather Sofa",
          colors: ["black leather", "dark wood"],
        },
      ],
      request: {
        category: "sofa",
        replace: {
          productId: "sofa_02",
          centre_cm: [41, 200],
          rotationY: 90,
        },
      },
      freeSpace: {
        runs: [
          {
            wall: "Door wall",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "Right wall (window)",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "Back wall (window)",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "Back wall (window)",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "Left wall",
            start_cm: 10,
            end_cm: 65,
            length_cm: 55,
            depth_cm: 150,
          },
        ],
        openAreas: [
          {
            id: "area-1",
            x0: 220,
            z0: 80,
            x1: 330,
            z1: 280,
            w_cm: 110,
            d_cm: 200,
          },
        ],
      },
      candidates: [
        {
          productId: "Sofa_01",
          name: "Provence Loveseat",
          size_cm: [157.1, 65.8, 79.7],
          price_usd: 890,
          styleTags: ["French provincial", "classic"],
          colors: ["stone fabric (default)", "carved dark wood"],
          spot: {
            kind: "run",
            wall: "Left wall",
            run_cm: [81.4, 238.6],
            runLength_cm: 157.2,
            spare_cm: 0,
            centre_cm: [41, 200],
            rotationY: 90,
          },
        },
      ],
    },
  ],
  assistant: buildAssistantDemoRequests(),
  render: [],
};
