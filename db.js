/* db.js — thin IndexedDB wrapper. Nothing here ever leaves the device. */
const DB = (() => {
  const DB_NAME = 'ledger-db';
  const DB_VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('transactions')) {
          const s = db.createObjectStore('transactions', { keyPath: 'id' });
          s.createIndex('date', 'date');
          s.createIndex('accountId', 'accountId');
          s.createIndex('categoryId', 'categoryId');
        }
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('categories')) {
          db.createObjectStore('categories', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('rules')) {
          db.createObjectStore('rules', { keyPath: 'merchant' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbp;
  }

  async function tx(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      storeNames.forEach(n => stores[n] = t.objectStore(n));
      let result;
      Promise.resolve(fn(stores)).then(r => result = r).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = (e) => reject(e.target.error);
      t.onabort = (e) => reject(e.target.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async put(store, value) {
      return tx([store], 'readwrite', (s) => reqToPromise(s[store].put(value)));
    },
    async get(store, key) {
      return tx([store], 'readonly', (s) => reqToPromise(s[store].get(key)));
    },
    async delete(store, key) {
      return tx([store], 'readwrite', (s) => reqToPromise(s[store].delete(key)));
    },
    async getAll(store) {
      return tx([store], 'readonly', (s) => reqToPromise(s[store].getAll()));
    },
    async clear(store) {
      return tx([store], 'readwrite', (s) => reqToPromise(s[store].clear()));
    },
    async clearAll() {
      return tx(['transactions','accounts','categories','rules','meta'], 'readwrite', (s) => {
        Object.values(s).forEach(st => st.clear());
      });
    },
    uuid() {
      return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    }
  };
})();
