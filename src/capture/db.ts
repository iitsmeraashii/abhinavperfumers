// Raw IndexedDB abstraction — no domain knowledge.
// All methods return Promises and fail gracefully.
// Replace this module (e.g. with Capacitor SQLite) without touching callers.

const pendingOpsListeners = new Set<() => void>();
export function subscribePendingOps(listener: () => void): () => void {
  pendingOpsListeners.add(listener);
  return () => { pendingOpsListeners.delete(listener); };
}

const DB_NAME = 'capture_app';
// Keep DB_VERSION centralized here so every store uses the same database version.
const DB_VERSION = 12;

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    req.onblocked = () => { blocked = true; reject(new Error('Database upgrade blocked by another open tab')); };

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('capture_config_cache')) {
        db.createObjectStore('capture_config_cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('previous_rep_cache')) {
        db.createObjectStore('previous_rep_cache', { keyPath: 'ownerId' });
      }
      if (!db.objectStoreNames.contains('event_cache')) {
        db.createObjectStore('event_cache', { keyPath: 'ownerId' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const store = db.createObjectStore('assets', { keyPath: 'id' });
        store.createIndex('by_session', 'sessionId', { unique: false });
        store.createIndex('by_owner', 'ownerId', { unique: false });
      } else if (event.oldVersion < 7) {
        // Add by_owner index to existing assets store (non-destructive)
        const store = (event.target as IDBOpenDBRequest).transaction!.objectStore('assets');
        if (!store.indexNames.contains('by_owner')) {
          store.createIndex('by_owner', 'ownerId', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        const opStore = db.createObjectStore('pending_ops', { keyPath: 'id' });
        opStore.createIndex('by_session', 'sessionId', { unique: false });
        opStore.createIndex('by_created', 'createdAt', { unique: false });
        opStore.createIndex('by_owner', 'ownerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('lead_queue')) {
        const qStore = db.createObjectStore('lead_queue', { keyPath: 'id' });
        qStore.createIndex('by_session', 'sessionId', { unique: false });
        qStore.createIndex('by_created', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('completed_leads')) {
        const clStore = db.createObjectStore('completed_leads', { keyPath: 'id' });
        clStore.createIndex('by_status', 'status', { unique: false });
        clStore.createIndex('by_created', 'createdAt', { unique: false });
        clStore.createIndex('by_owner', 'ownerId', { unique: false });
      } else {
        const clStore = (event.target as IDBOpenDBRequest).transaction!.objectStore('completed_leads');
        if (!clStore.indexNames.contains('by_owner')) {
          clStore.createIndex('by_owner', 'ownerId', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains('auth_profile')) {
        // Single-record store keyed by a fixed key ('current'). The record
        // itself contains authUserId so future restoration can verify identity
        // before use. Non-destructive: existing stores are untouched.
        db.createObjectStore('auth_profile', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      if (blocked) { req.result.close(); return; }
      // Capture transaction completion (including non-bubbling complete events).
      // Observe committed writes only; no changes to transactions or queue execution.
      req.result.addEventListener?.('complete', (event) => {
        const tx = event.target as IDBTransaction;
        if (tx.mode === 'readwrite' && tx.objectStoreNames.contains('pending_ops')) {
          for (const listener of pendingOpsListeners) {
            try { listener(); } catch { /* UI observers must not affect storage */ }
          }
        }
      }, true);
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAllInStore<T>(store: string): Promise<T[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function dbGetAll<T>(store: string, indexName: string, indexValue: string): Promise<T[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).index(indexName).getAll(indexValue);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function dbGet<T>(store: string, key: string): Promise<T | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Queue dependency checks must fail closed if storage cannot be read. */
export async function dbGetAllInStoreStrict<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function dbDeleteStrict(store: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Strict write for capture durability: reject open, setup and commit failures. */
export async function dbPutStrict(store: string, value: object): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPut(store: string, value: object): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Storage errors must never crash the UI
  }
}

export async function dbDelete(store: string, key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore
  }
}

/** Strict indexed read for UI snapshots: preserve the previous snapshot on failure. */
export async function dbGetAllByIndexStrict<T>(store: string, index: string, value: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  });
}
