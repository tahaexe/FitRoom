/**
 * Demo label request: one wall photo labelled from the demo store.
 *
 * The photo is synthetic minimal JPEG header bytes (a real 640 px room
 * photo would bloat the source; demo mode never decodes pixels, and the
 * recorded demo answer below stands in for the live call). A future live
 * recording replaces it with real room photos.
 */

export interface RoomLabelDemoPhoto {
  wall: string;
  image: string;
}

/** Synthetic JPEG data URLs (SOI magic + JFIF header, 20 bytes each). */
export const SYNTHETIC_TEST_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAA=";

/** A second test photo (last byte differs, so keys differ). */
export const SYNTHETIC_TEST_JPEG_B = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAE=";

/** An unrecorded test photo (demo-miss, unknown keys). */
export const SYNTHETIC_TEST_JPEG_UNKNOWN = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAI=";

/**
 * The demo requests, rebuilt deterministically. `demo-requests.ts`
 * embeds their output; `check:room-api` replays them from the demo store.
 */
export function buildRoomLabelDemoRequests(): Array<{
  photos: RoomLabelDemoPhoto[];
}> {
  return [
    {
      photos: [
        { wall: "A", image: SYNTHETIC_TEST_JPEG },
        { wall: "B", image: SYNTHETIC_TEST_JPEG_B },
      ],
    },
  ];
}
