// background.js — MV3 service worker. Orchestrates a run: opens/points a tab at the
// LinkedIn jobs search, tells the content script to start, buffers captured records,
// and writes them out as a Markdown file in the folder chosen in the popup.

importScripts('save-folder.js');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let activeTabId = null;
let buffer = []; // captured job records for the current run
let runSettings = null;
let seenJobIds = new Set();
let skipJobIds = new Set(); // job ids captured in the last 30 days
let captureHistory = {}; // jobId -> captured-at epoch ms
let historyWrite = Promise.resolve();
let finishing = false;
let stateReady = Promise.resolve();

function buildSearchUrl(settings) {
  const params = new URLSearchParams({
    keywords: settings.keywords,
  });
  if (settings.location) params.set('location', settings.location);

  // Date posted (f_TPR): r86400 = 24h, r604800 = week, r2592000 = month
  if (settings.datePosted) params.set('f_TPR', settings.datePosted);

  // Experience level (f_E): 1 Internship, 2 Entry, 3 Associate, 4 Mid-Senior, 5 Director, 6 Executive
  if (settings.expLevel && settings.expLevel.length) {
    params.set('f_E', settings.expLevel.join(','));
  }

  // Workplace type / Remote (f_WT): 1 On-site, 2 Remote, 3 Hybrid
  if (settings.workplaceType && settings.workplaceType.length) {
    params.set('f_WT', settings.workplaceType.join(','));
  }

  // Easy Apply only (f_AL)
  if (settings.easyApply) params.set('f_AL', 'true');

  // Company (f_C): LinkedIn's internal numeric company IDs, comma-separated.
  if (settings.companyIds) {
    const ids = settings.companyIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) params.set('f_C', ids.join(','));
  }

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

async function setRunState(patch) {
  const { runState } = await chrome.storage.local.get('runState');
  await chrome.storage.local.set({ runState: { ...(runState || {}), ...patch } });
}

function beginMessage() {
  return {
    type: 'begin',
    settings: {
      ...runSettings,
      alreadyCaptured: buffer.length,
      seenJobIds: [...seenJobIds],
      skipJobIds: [...skipJobIds],
    },
  };
}

async function loadCaptureHistory() {
  await historyWrite;
  const stored = await chrome.storage.local.get('captureHistory');
  const history = stored.captureHistory && typeof stored.captureHistory === 'object'
    ? stored.captureHistory
    : {};
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  captureHistory = {};
  skipJobIds = new Set();
  for (const [id, at] of Object.entries(history)) {
    if (typeof at === 'number' && at >= cutoff) {
      captureHistory[id] = at;
      skipJobIds.add(String(id));
    }
  }
  await chrome.storage.local.set({ captureHistory });
}

function rememberCapturedJob(jobId) {
  if (!jobId) return;
  const id = String(jobId);
  captureHistory[id] = Date.now();
  skipJobIds.add(id);
  const snapshot = { ...captureHistory };
  historyWrite = historyWrite
    .then(() => chrome.storage.local.set({ captureHistory: snapshot }))
    .catch(() => {});
}

function localDateStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sendBegin() {
  if (!activeTabId || !runSettings || finishing) return;
  if (buffer.length >= runSettings.maxResults) return;
  chrome.tabs.sendMessage(activeTabId, beginMessage()).catch(() => {});
}

async function persistRun() {
  if (!runSettings) {
    await chrome.storage.session.remove('activeRun').catch(() => {});
    return;
  }
  await chrome.storage.session.set({
    activeRun: {
      tabId: activeTabId,
      settings: runSettings,
      jobs: buffer,
      seenJobIds: [...seenJobIds],
    },
  }).catch(() => {});
}

async function restoreRun() {
  await loadCaptureHistory();
  const { activeRun } = await chrome.storage.session.get('activeRun');
  if (!activeRun || !activeRun.settings) return;
  runSettings = activeRun.settings;
  activeTabId = activeRun.tabId || null;
  buffer = Array.isArray(activeRun.jobs) ? activeRun.jobs : [];
  seenJobIds = new Set((activeRun.seenJobIds || []).map(String));
}

stateReady = restoreRun().then(() => {
  if (runSettings && activeTabId) sendBegin();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  stateReady.then(() => {
    if (!runSettings || finishing || tabId !== activeTabId) return;
    setTimeout(sendBegin, 1000);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err) })
  );
  return true;
});

async function handleMessage(msg, sender) {
  await stateReady;

  if (msg.type === 'start-scrape') {
    await startRun(msg.settings);
  } else if (msg.type === 'stop-scrape') {
    await finishRun('stopped by user');
  } else if (msg.type === 'content-ready') {
    if (!runSettings || finishing || !sender.tab) return;
    if (sender.tab.id !== activeTabId) return;
    sendBegin();
  } else if (msg.type === 'job-captured') {
    if (!runSettings || finishing) return;
    const job = msg.job || {};
    const id = job.jobId ? String(job.jobId) : '';
    if (id && seenJobIds.has(id)) return;
    if (id) seenJobIds.add(id);
    rememberCapturedJob(id);
    buffer.push(job);
    const captured = buffer.length;
    const done = captured >= runSettings.maxResults;
    setRunState({ captured });
    await persistRun();
    if (done) await finishRun('reached max results');
  } else if (msg.type === 'scrape-progress') {
    if (!runSettings || finishing) return;
    setRunState({ phase: msg.phase });
  } else if (msg.type === 'scrape-done') {
    if (!runSettings) return;
    await finishRun(msg.reason || 'content script finished');
  } else if (msg.type === 'scrape-error') {
    if (!runSettings) return;
    await finishRun(`error: ${msg.message}`, true);
  }
}

async function startRun(settings) {
  const saveDir = await loadDirectoryHandle();
  const savePermission = await ensureWritePermission(saveDir, false);
  if (!saveDir || savePermission !== 'granted') {
    await setRunState({
      phase: 'error',
      message: 'Choose a save folder in the extension and allow access before starting.',
      captured: 0,
      maxResults: settings.maxResults,
    });
    return;
  }

  buffer = [];
  seenJobIds = new Set();
  finishing = false;
  await loadCaptureHistory();
  runSettings = { ...settings, runId: Date.now() };
  await chrome.storage.local.set({
    runState: { phase: 'opening LinkedIn…', captured: 0, maxResults: settings.maxResults },
  });

  const url = buildSearchUrl(runSettings);
  const tab = await chrome.tabs.create({ url, active: true });
  activeTabId = tab.id;
  await persistRun();

  // Content script signals readiness too. This covers a load that finished
  // before that signal, and a service-worker restart mid-run.
  setTimeout(sendBegin, 2000);
  setTimeout(sendBegin, 5000);
}

async function finishRun(reason, isError = false) {
  if (finishing) return;
  finishing = true;

  const jobs = buffer;
  const settings = runSettings;
  const tabId = activeTabId;
  buffer = [];
  seenJobIds = new Set();
  runSettings = null;
  activeTabId = null;

  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'stop' }).catch(() => {});
  }

  let savedAs = '';
  let saveError = '';
  try {
    savedAs = (await writeMarkdown(jobs, settings)) || '';
    await chrome.storage.session.remove('activeRun').catch(() => {});
  } catch (e) {
    saveError = (e && e.message) || 'Could not save the file.';
  }

  try {
    await setRunState({
      phase: saveError || isError ? 'error' : 'idle',
      message: saveError || (savedAs ? `${reason}. Saved ${savedAs}` : reason),
      captured: jobs.length,
      needsSave: !!saveError && jobs.length > 0,
    });
  } finally {
    finishing = false;
  }
}

function escapeMd(text) {
  return (text || '').replace(/\r/g, '').trim();
}

async function writeMarkdown(jobs, settings) {
  if (!jobs.length) return;

  const now = new Date();
  const lines = [];
  lines.push(`# LinkedIn Job Search — ${settings ? settings.keywords : ''}${settings && settings.location ? ' — ' + settings.location : ''}`);
  lines.push('');
  lines.push(`Captured ${jobs.length} listing(s) on ${now.toString()}.`);
  lines.push('');

  for (const job of jobs) {
    lines.push(`## ${escapeMd(job.title) || 'Untitled role'}`);
    lines.push('');
    lines.push(`- **Company:** ${escapeMd(job.company) || 'n/a'}`);
    lines.push(`- **Location:** ${escapeMd(job.location) || 'n/a'}`);
    if (job.postedAt) lines.push(`- **Posted:** ${escapeMd(job.postedAt)}`);
    if (job.employmentType) lines.push(`- **Type:** ${escapeMd(job.employmentType)}`);
    if (job.applicants) lines.push(`- **Applicants:** ${escapeMd(job.applicants)}`);
    lines.push(`- **URL:** ${job.url || 'n/a'}`);
    lines.push(`- **Job ID:** ${job.jobId || 'n/a'}`);
    lines.push('');
    if (job.description) {
      lines.push('**Description:**');
      lines.push('');
      lines.push(escapeMd(job.description));
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  const content = lines.join('\n');
  const filename = `linkedin-jobs-${localDateStamp(now)}.md`;
  const handle = await loadDirectoryHandle();
  if (!handle) {
    await storePendingFile(filename, content);
    throw new Error('Choose a save folder in the extension, then click Save.');
  }

  const permission = await ensureWritePermission(handle, false);
  if (permission !== 'granted') {
    await storePendingFile(filename, content);
    throw new Error('Folder access needs approval. Open the extension and click Save.');
  }

  try {
    const written = await writeTextFile(handle, filename, content);
    await clearPendingFile();
    return written;
  } catch (e) {
    await storePendingFile(filename, content);
    const detail = (e && e.message) || 'Could not save the file.';
    throw new Error(`${detail} Open the extension and click Save.`);
  }
}
