// save-folder.js — folder the user picked in the popup, shared by the popup
// and the service worker through IndexedDB (directory handles can be stored).

const SAVE_DB = 'linkedin-job-scraper';
const SAVE_STORE = 'kv';

function openSaveDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SAVE_STORE)) {
        req.result.createObjectStore(SAVE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return openSaveDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE_STORE, 'readonly');
    const req = tx.objectStore(SAVE_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key, value) {
  return openSaveDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE_STORE, 'readwrite');
    tx.objectStore(SAVE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return openSaveDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE_STORE, 'readwrite');
    tx.objectStore(SAVE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function saveDirectoryHandle(handle) {
  await idbSet('directory', handle);
  await chrome.storage.local.set({ saveFolderName: handle.name });
}

function loadDirectoryHandle() {
  return idbGet('directory');
}

async function ensureWritePermission(handle, request) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'denied';
  const current = await handle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted' || !request) return current;
  return handle.requestPermission({ mode: 'readwrite' });
}

async function uniqueFileName(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);
  let name = filename;
  let n = 1;
  for (;;) {
    try {
      await dir.getFileHandle(name);
      name = `${stem} (${n})${ext}`;
      n += 1;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return name;
      throw e;
    }
  }
}

async function writeTextFile(dir, filename, content) {
  const name = await uniqueFileName(dir, filename);
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  return name;
}

function storePendingFile(filename, content) {
  return idbSet('pendingFile', { filename, content });
}

function loadPendingFile() {
  return idbGet('pendingFile');
}

function clearPendingFile() {
  return idbDelete('pendingFile');
}
