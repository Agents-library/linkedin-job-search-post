// popup.js — reads/writes settings, starts/stops a scrape run, shows live status.

const els = {
  keywords: document.getElementById('keywords'),
  location: document.getElementById('location'),
  maxResults: document.getElementById('maxResults'),
  minDelay: document.getElementById('minDelay'),
  maxDelay: document.getElementById('maxDelay'),
  datePosted: document.getElementById('datePosted'),
  expLevel: document.getElementById('expLevel'),
  workplaceType: document.getElementById('workplaceType'),
  easyApply: document.getElementById('easyApply'),
  companyIds: document.getElementById('companyIds'),
  resetFilters: document.getElementById('resetFilters'),
  saveFolder: document.getElementById('saveFolder'),
  chooseFolder: document.getElementById('chooseFolder'),
  saveNow: document.getElementById('saveNow'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  status: document.getElementById('status'),
};

const DEFAULTS = {
  keywords: '',
  location: '',
  maxResults: 25,
  minDelay: 3,
  maxDelay: 7,
  datePosted: '',
  expLevel: [],
  workplaceType: [],
  easyApply: false,
  companyIds: '',
};

function checkboxGroup(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]'));
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  els.keywords.value = stored.keywords;
  els.location.value = stored.location;
  els.maxResults.value = stored.maxResults;
  els.minDelay.value = stored.minDelay;
  els.maxDelay.value = stored.maxDelay;
  els.datePosted.value = stored.datePosted;
  els.easyApply.checked = !!stored.easyApply;
  els.companyIds.value = stored.companyIds;

  for (const cb of checkboxGroup(els.expLevel)) {
    cb.checked = stored.expLevel.includes(cb.value);
  }
  for (const cb of checkboxGroup(els.workplaceType)) {
    cb.checked = stored.workplaceType.includes(cb.value);
  }
}

function currentSettings() {
  return {
    keywords: els.keywords.value.trim(),
    location: els.location.value.trim(),
    maxResults: Math.max(1, parseInt(els.maxResults.value, 10) || 25),
    minDelay: Math.max(1, parseFloat(els.minDelay.value) || 3),
    maxDelay: Math.max(1, parseFloat(els.maxDelay.value) || 7),
    datePosted: els.datePosted.value,
    expLevel: checkboxGroup(els.expLevel).filter((cb) => cb.checked).map((cb) => cb.value),
    workplaceType: checkboxGroup(els.workplaceType).filter((cb) => cb.checked).map((cb) => cb.value),
    easyApply: els.easyApply.checked,
    companyIds: els.companyIds.value.trim(),
  };
}

async function refreshFolderLabel() {
  const { saveFolderName } = await chrome.storage.local.get('saveFolderName');
  els.saveFolder.textContent = saveFolderName || 'Not chosen';
}

async function writePendingFile() {
  const handle = await loadDirectoryHandle();
  if (!handle) throw new Error('Choose a save folder first.');
  const permission = await ensureWritePermission(handle, true);
  if (permission !== 'granted') throw new Error('Folder access was not allowed.');
  const pending = await loadPendingFile();
  if (!pending || !pending.content) return '';
  const written = await writeTextFile(handle, pending.filename, pending.content);
  await clearPendingFile();
  return written;
}

async function refreshStatus() {
  const { runState } = await chrome.storage.local.get('runState');
  const pending = await loadPendingFile().catch(() => null);
  els.saveNow.classList.toggle('visible', !!(pending && pending.content) || !!(runState && runState.needsSave));
  if (!runState || (runState.phase === 'idle' && !runState.message)) {
    els.status.textContent = 'Idle.';
    return;
  }
  if (runState.phase === 'error') {
    els.status.textContent = `Stopped: ${runState.message || 'error'}`;
    return;
  }
  if (runState.phase === 'idle') {
    els.status.textContent = `${runState.message}\nCaptured: ${runState.captured || 0}`;
    return;
  }
  els.status.textContent =
    `${runState.phase}\nCaptured: ${runState.captured || 0} / ${runState.maxResults || '?'}`;
}

els.chooseFolder.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'linkedin-job-scraper' });
    await saveDirectoryHandle(handle);
    els.saveFolder.textContent = handle.name;
    const written = await writePendingFile();
    els.status.textContent = written ? `Saved ${written}` : `Files will be saved to ${handle.name}.`;
    if (written) els.saveNow.classList.remove('visible');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    els.status.textContent = (e && e.message) || 'Could not use that folder.';
  }
});

els.saveNow.addEventListener('click', async () => {
  try {
    const written = await writePendingFile();
    els.saveNow.classList.remove('visible');
    els.status.textContent = written ? `Saved ${written}` : 'Nothing waiting to save.';
    if (written) {
      const { runState } = await chrome.storage.local.get('runState');
      await chrome.storage.local.set({
        runState: { ...(runState || {}), phase: 'idle', needsSave: false, message: `Saved ${written}` },
      });
    }
  } catch (e) {
    els.status.textContent = (e && e.message) || 'Could not save the file.';
  }
});

els.start.addEventListener('click', async () => {
  const settings = currentSettings();
  if (!settings.keywords) {
    els.status.textContent = 'Enter at least a keyword.';
    return;
  }
  const handle = await loadDirectoryHandle();
  if (!handle) {
    els.status.textContent = 'Choose a save folder first.';
    return;
  }
  const permission = await ensureWritePermission(handle, true);
  if (permission !== 'granted') {
    els.status.textContent = 'Allow access to the save folder to start.';
    return;
  }
  await chrome.storage.sync.set(settings);
  chrome.runtime.sendMessage({ type: 'start-scrape', settings });
  els.status.textContent = 'Starting…';
});

els.stop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop-scrape' });
  els.status.textContent = 'Stopping…';
});

els.resetFilters.addEventListener('click', () => {
  els.datePosted.value = '';
  els.easyApply.checked = false;
  els.companyIds.value = '';
  for (const cb of checkboxGroup(els.expLevel)) cb.checked = false;
  for (const cb of checkboxGroup(els.workplaceType)) cb.checked = false;
});

loadSettings();
refreshFolderLabel();
refreshStatus();
setInterval(refreshStatus, 1000);
