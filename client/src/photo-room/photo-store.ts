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
  const db = await openDb();
  if (db === null) return;
  try {
    await tx(db, "readwrite", (store) => store.put(photo, photo.wall));
  } finally {
    db.close();
  }
}

/** Load one wall's downscaled photos, or null when never saved. */
export async function loadPhoto(wall: WallLetter): Promise<StoredPhoto | null> {
  const db = await openDb();
  if (db === null) return memory.get(wall) ?? null;
  try {
    const stored = await tx<StoredPhoto | undefined>(db, "readonly", (store) => store.get(wall));
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
  const db = await openDb();
  if (db === null) return;
  try {
    await tx(db, "readwrite", (store) => store.delete(wall));
  } finally {
    db.close();
  }
}

/** Drop every stored photo (a fresh From-photos run). */
export async function clearAllPhotos(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (db === null) return;
  try {
    await tx(db, "readwrite", (store) => store.clear());
  } finally {
    db.close();
  }
}
