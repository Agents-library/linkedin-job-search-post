// content.js — runs on linkedin.com/jobs/* pages. Waits for the results list,
// then walks through job cards one at a time: clicks each card, waits for the
// detail pane to update, extracts structured fields, and reports them back to
// the background service worker. After the last new card on a page, it opens
// the next page and keeps going until maxResults is reached or the results end.
//
// IMPORTANT: LinkedIn changes its markup/class names periodically (redesigns,
// A/B tests). The selectors below are best-effort as of when this was written —
// they are NOT guaranteed to match today. If capture stops finding jobs:
//   1. Open the LinkedIn jobs page, right-click a job card / job title / company
//      name / description block, choose "Inspect".
//   2. Find a stable attribute to key off (data-job-id, aria-label, a semantic
//      tag) rather than a generated class hash like "jobs-abc123xyz".
//   3. Add the new selector to the relevant array in SELECTORS below — the code
//      tries each candidate in order and uses the first one that matches, so old
//      selectors don't need to be removed.

const SELECTORS = {
  jobCard: [
    'div[data-job-id]',
    'li.jobs-search-results__list-item',
    '.job-card-container',
  ],
  cardLink: ['a.job-card-container__link', 'a.job-card-list__title', 'a'],
  paginationNext: [
    'button[aria-label="View next page"]',
    '[aria-label="View next page"]',
    'button[aria-label="Next"]',
    'button[aria-label="Next page"]',
    'button.jobs-search-pagination__button--next',
    'button.artdeco-pagination__button--next',
  ],
  resultsList: [
    '.jobs-search-results-list',
    '.scaffold-layout__list',
  ],
  detailPane: [
    '.jobs-search__job-details--container',
    '.job-details-jobs-unified-top-card__container',
    '.jobs-details',
  ],
  detailTitle: [
    '.job-details-jobs-unified-top-card__job-title',
    'h2.t-24',
  ],
  detailCompany: [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
  ],
  detailLocation: [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__bullet',
  ],
  detailDescription: [
    '#job-details',
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description-content__text',
  ],
  applicants: ['.jobs-unified-top-card__applicant-count', '.num-applicants__caption'],
};

let running = false;
let stopRequested = false;
let activeRunId = null;
const seenJobIds = new Set();
const MAX_EMPTY_SCROLLS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  return sleep(ms);
}

function queryFirst(root, selectorList) {
  for (const sel of selectorList) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function queryAllFirst(root, selectorList) {
  for (const sel of selectorList) {
    const els = root.querySelectorAll(sel);
    if (els.length) return Array.from(els);
  }
  return [];
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function waitFor(selectorList, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = queryFirst(document, selectorList);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const found = queryFirst(document, selectorList);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for: ${selectorList.join(', ')}`));
    }, timeoutMs);
  });
}

function report(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

function extractCardMeta(card) {
  const link = queryFirst(card, SELECTORS.cardLink);
  const jobId = card.getAttribute('data-job-id') || (link && link.href.match(/(\d{6,})/) || [])[1];
  return { jobId, link };
}

async function extractDetail(jobId, cardTitle) {
  const pane = await waitFor(SELECTORS.detailPane, 10000);
  // Give LinkedIn's SPA a moment to finish swapping content in.
  await sleep(600);

  const title = textOf(queryFirst(pane, SELECTORS.detailTitle)) || cardTitle;
  const company = textOf(queryFirst(pane, SELECTORS.detailCompany));
  const location = textOf(queryFirst(pane, SELECTORS.detailLocation));
  const description = textOf(queryFirst(pane, SELECTORS.detailDescription));
  const applicants = textOf(queryFirst(pane, SELECTORS.applicants));

  return {
    jobId,
    title,
    company,
    location,
    description,
    applicants,
    url: `https://www.linkedin.com/jobs/view/${jobId}/`,
  };
}

function currentPageLabel() {
  const current = document.querySelector('button[aria-current="true"][aria-label^="Page "]');
  if (!current) return '';
  const match = (current.getAttribute('aria-label') || '').match(/Page\s+(\d+)/i);
  return match ? `page ${match[1]} — ` : '';
}

function visibleJobIds() {
  return queryAllFirst(document, SELECTORS.jobCard)
    .map((card) => extractCardMeta(card).jobId)
    .filter(Boolean)
    .map(String);
}

function findScrollableList() {
  const start = queryFirst(document, SELECTORS.resultsList);
  if (!start) return null;
  let el = start;
  while (el && el !== document.documentElement) {
    const style = getComputedStyle(el);
    const overflow = `${style.overflowY} ${style.overflow}`;
    if (/(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 8) {
      return el;
    }
    el = el.parentElement;
  }
  return start;
}

function isDisabled(el) {
  if (!el) return true;
  if (el.disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  const className = String(el.className || '');
  return /\bdisabled\b/.test(className) || className.includes('artdeco-button--disabled');
}

// { done: true } means this is the last page. { el } is a control to click.
// { el: null, done: false } means no pagination UI was found.
function findNextPageControl() {
  for (const sel of SELECTORS.paginationNext) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (isDisabled(el)) return { done: true, el: null };
    return { done: false, el };
  }

  const pageButtons = Array.from(document.querySelectorAll('button[aria-label^="Page "]'));
  if (pageButtons.length) {
    const currentIdx = pageButtons.findIndex((b) => b.getAttribute('aria-current') === 'true');
    if (currentIdx === -1) return { done: false, el: null };
    const next = pageButtons[currentIdx + 1];
    if (!next || isDisabled(next)) return { done: true, el: null };
    return { done: false, el: next };
  }

  return { done: false, el: null };
}

function scrollForMoreCards() {
  const list = findScrollableList();
  if (!list) return false;
  const maxScroll = list.scrollHeight - list.clientHeight;
  if (maxScroll <= 8 || list.scrollTop >= maxScroll - 8) return false;
  const before = list.scrollTop;
  const step = Math.max(list.clientHeight * 0.8, 240);
  list.scrollTop = Math.min(list.scrollTop + step, maxScroll);
  const cards = queryAllFirst(document, SELECTORS.jobCard);
  const lastCard = cards[cards.length - 1];
  if (lastCard) lastCard.scrollIntoView({ block: 'nearest' });
  return list.scrollTop > before + 4;
}

// true: next page is showing. false: no further page.
// 'more-on-page': scrolling revealed unseen cards, so stay here.
async function goToNextPage() {
  const beforeIds = new Set(visibleJobIds());
  const list = findScrollableList();
  if (list) {
    list.scrollTop = list.scrollHeight;
    await sleep(700);
  }
  const revealed = visibleJobIds().some((id) => !seenJobIds.has(id) && !beforeIds.has(id));
  if (revealed) return 'more-on-page';

  const next = findNextPageControl();
  if (next.done || !next.el) return false;

  const previousIds = new Set(visibleJobIds());
  report('scrape-progress', { phase: 'moving to the next page…' });
  next.el.scrollIntoView({ block: 'center' });
  await sleep(300);
  next.el.click();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (stopRequested) return false;
    await sleep(400);
    const ids = visibleJobIds();
    if (ids.some((id) => !previousIds.has(id))) {
      const scroller = findScrollableList();
      if (scroller) scroller.scrollTop = 0;
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function runScrape(settings) {
  running = true;
  stopRequested = false;

  if (settings.runId !== activeRunId) {
    seenJobIds.clear();
    activeRunId = settings.runId || null;
  }
  for (const id of settings.seenJobIds || []) seenJobIds.add(String(id));
  const recentJobIds = new Set((settings.skipJobIds || []).map(String));
  for (const id of recentJobIds) seenJobIds.add(id);

  let captured = Math.max(0, Number(settings.alreadyCaptured) || 0);
  let emptyScrolls = 0;

  try {
    await waitFor(SELECTORS.jobCard, 20000);
  } catch (e) {
    running = false;
    if (captured > 0) {
      report('scrape-done', { reason: 'no more results found' });
    } else {
      report('scrape-error', { message: 'Could not find the job results list — LinkedIn may have changed its layout, or the page is showing a checkpoint/login prompt.' });
    }
    return;
  }

  while (!stopRequested && captured < settings.maxResults) {
    const cards = queryAllFirst(document, SELECTORS.jobCard);
    const card = cards.find((candidate) => {
      const id = extractCardMeta(candidate).jobId;
      return id && !seenJobIds.has(String(id));
    });

    if (card) {
      emptyScrolls = 0;
      const { jobId } = extractCardMeta(card);
      seenJobIds.add(String(jobId));

      report('scrape-progress', { phase: `${currentPageLabel()}opening job ${jobId}…` });
      card.scrollIntoView({ block: 'center' });
      await randomDelay(0.4, 1.0);
      if (stopRequested || captured >= settings.maxResults) break;
      card.click();

      try {
        const cardTitle = textOf(queryFirst(card, SELECTORS.cardLink));
        const detail = await extractDetail(jobId, cardTitle);
        report('job-captured', { job: detail });
        captured++;
      } catch (e) {
        report('scrape-progress', { phase: `${currentPageLabel()}skipped job ${jobId} (detail pane didn't load in time)` });
      }

      await randomDelay(settings.minDelay, settings.maxDelay);
      continue;
    }

    const skippedRecent = cards.some((candidate) => {
      const id = extractCardMeta(candidate).jobId;
      return id && recentJobIds.has(String(id));
    });

    if (scrollForMoreCards()) {
      emptyScrolls++;
      if (emptyScrolls <= MAX_EMPTY_SCROLLS) {
        report('scrape-progress', {
          phase: skippedRecent
            ? `${currentPageLabel()}skipping jobs captured in the last 30 days…`
            : `${currentPageLabel()}scrolling for more jobs on this page…`,
        });
        await randomDelay(1.0, 1.8);
        continue;
      }
    }

    if (skippedRecent) {
      report('scrape-progress', { phase: `${currentPageLabel()}skipping jobs captured in the last 30 days…` });
      await randomDelay(settings.minDelay, settings.maxDelay);
    }

    const moved = await goToNextPage();
    if (moved === 'more-on-page') {
      emptyScrolls = 0;
      continue;
    }
    if (!moved) break;
    emptyScrolls = 0;
  }

  running = false;
  report('scrape-done', {
    reason: stopRequested
      ? 'stopped by user'
      : captured >= settings.maxResults
        ? 'reached max results'
        : 'no more results found',
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'begin' && !running) {
    runScrape(msg.settings);
  } else if (msg.type === 'stop') {
    stopRequested = true;
  }
});

chrome.runtime.sendMessage({ type: 'content-ready' }).catch(() => {});
