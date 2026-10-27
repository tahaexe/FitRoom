/**
 * Photo store: keeps the downscaled photos (1280 px for segmentation,
 * 640 px for labelling) in IndexedDB under one `fitroom-photos` database,
 * keyed by wall letter. Falls back to an in-memory map where IndexedDB is
 * missing (private mode, headless checks), so the flow keeps working.
 */

import type { WallLetter } from "@fitroom/shared";
import type { IntakePhoto } from "./intake";

export interface StoredPhoto extends IntakePhoto {
  wall: WallLetter;
  savedAt: number;
}

const DB_NAME = "fitroom-photos";
const DB_STORE = "photos";

/** Time limit for each IndexedDB operation (5 s). */
export const PHOTO_STORE_TIMEOUT_MS = 5000;

async function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), PHOTO_STORE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  const factory = idb();
  if (factory === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const store = transaction.objectStore(DB_STORE);
    let value: T | undefined;
    let failed: unknown = null;
    const request = run(store);
    request.onsuccess = () => {
      value = request.result;
    };
    request.onerror = () => {
      failed = request.error;
    };
    transaction.oncomplete = () => resolve(value as T);
    transaction.onerror = () =>
      reject(failed ?? transaction.error ?? new Error("IndexedDB failed."));
    transaction.onabort = () => reject(failed ?? new Error("IndexedDB failed."));
  });
}

const memory = new Map<string, StoredPhoto>();

/** Save one wall's downscaled photos. */
export async function savePhoto(photo: StoredPhoto): Promise<void> {
  memory.set(photo.wall, photo);
  const db = await withTimeout(openDb(), "Saving your photo timed out. Try again.");
  if (db === null) return;
  try {
    await withTimeout(
      tx(db, "readwrite", (store) => store.put(photo, photo.wall)),
      "Saving your photo timed out. Try again.",
    );
  } finally {
    db.close();
  }
}

/** Load one wall's downscaled photos, or null when never saved. */
export async function loadPhoto(wall: WallLetter): Promise<StoredPhoto | null> {
  const db = await withTimeout(openDb(), "Restoring your photo timed out. Try again.");
  if (db === null) return memory.get(wall) ?? null;
  try {
    const stored = await withTimeout(
      tx<StoredPhoto | undefined>(db, "readonly", (store) => store.get(wall)),
      "Restoring your photo timed out. Try again.",
    );
    if (stored !== undefined) {
      memory.set(wall, stored);
      return stored;
    }
    return memory.get(wall) ?? null;
  } finally {
    db.close();
  }
}

/** Drop one wall's photos (retake). */
export async function clearPhoto(wall: WallLetter): Promise<void> {
  memory.delete(wall);
  const db = await withTimeout(openDb(), "Discarding your photo timed out. Try again.");
  if (db === null) return;
  try {
    await withTimeout(
      tx(db, "readwrite", (store) => store.delete(wall)),
      "Discarding your photo timed out. Try again.",
    );
  } finally {
    db.close();
  }
}

/** Drop every stored photo (a fresh From-photos run). */
export async function clearAllPhotos(): Promise<void> {
  memory.clear();
  const db = await withTimeout(openDb(), "Discarding your photos timed out. Try again.");
  if (db === null) return;
  try {
    await withTimeout(
      tx(db, "readwrite", (store) => store.clear()),
      "Discarding your photos timed out. Try again.",
    );
  } finally {
    db.close();
  }
}
