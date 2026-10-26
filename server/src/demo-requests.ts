/**
 * Demo request lists, one per route. `npm run demo:record -- <route>` sends
 * the route's list through the live pipeline with recording on.
 *
 * The recommend list holds the four recorded requests for the demo room
 * (the sample room with `shared/samples/fit-tests/valid.json`): sofas,
 * coffee tables, shelves, and "What fits here?" on the longest free run of
 * the north wall (`wall-3`). Generated with the shared code — see
 * `src/recommend-demo.ts` (`check:recommend` rebuilds and compares).
 */

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
        category: "sofa",
      },
      freeSpace: {
        runs: [
          {
            wall: "wall-1",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "wall-2",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "wall-3",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "wall-3",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "wall-4",
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
      candidates: [],
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
        category: "coffee-table",
      },
      freeSpace: {
        runs: [
          {
            wall: "wall-1",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "wall-2",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "wall-3",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "wall-3",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "wall-4",
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
            kind: "run",
            wall: "wall-1",
            run_cm: [230, 415],
            runLength_cm: 185,
            spare_cm: 64.8,
            centre_cm: [322.5, 34],
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
        category: "shelf",
      },
      freeSpace: {
        runs: [
          {
            wall: "wall-1",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "wall-2",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "wall-3",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "wall-3",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "wall-4",
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
            wall: "wall-1",
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
          wall: "wall-3",
          start_cm: 240,
          end_cm: 415,
        },
      },
      freeSpace: {
        runs: [
          {
            wall: "wall-1",
            start_cm: 230,
            end_cm: 415,
            length_cm: 185,
            depth_cm: 78,
          },
          {
            wall: "wall-2",
            start_cm: 5,
            end_cm: 75,
            length_cm: 70,
            depth_cm: 150,
          },
          {
            wall: "wall-3",
            start_cm: 10,
            end_cm: 85,
            length_cm: 75,
            depth_cm: 38,
          },
          {
            wall: "wall-3",
            start_cm: 240,
            end_cm: 415,
            length_cm: 175,
            depth_cm: 70,
          },
          {
            wall: "wall-4",
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
            wall: "wall-3",
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
            wall: "wall-3",
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
            wall: "wall-3",
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
            wall: "wall-3",
            run_cm: [240, 415],
            runLength_cm: 175,
            spare_cm: 67.2,
            centre_cm: [92.5, 337.4],
            rotationY: 180,
          },
        },
      ],
    },
  ],
  assistant: [],
  render: [],
};
