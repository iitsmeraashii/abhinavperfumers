// Raw IndexedDB abstraction — no domain knowledge.
// All methods return Promises and fail gracefully.
// Replace this module (e.g. with Capacitor SQLite) without touching callers.

const DB_NAME = 'capture_app';
// Keep DB_VERSION in sync with completedLeadsStorage.ts to avoid version-change
// aborts. When the two modules request different versions, the higher one
// triggers an upgrade that fires versionchange on all other connections,
// which can abort in-flight readwrite transactions before they commit.
const DB_VERSION = 5;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const store = db.createObjectStore('assets', { keyPath: 'id' });
        store.createIndex('by_session', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        const opStore = db.createObjectStore('pending_ops', { keyPath: 'id' });
        opStore.createIndex('by_session', 'sessionId', { unique: false });
        opStore.createIndex('by_created', 'createdAt', { unique: false });
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
      }
    };

    req.onsuccess = () => resolve(req.result);
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
