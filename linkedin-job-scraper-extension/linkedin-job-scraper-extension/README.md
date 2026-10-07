# LinkedIn Job Scraper (Chrome extension)

Opens a LinkedIn job search for you, walks through the results, and saves each
listing's details (title, company, location, description, applicants, URL) to
a Markdown file in a folder you choose in the extension, named with today's
date. Jobs already captured in the last 30 days are skipped.

## Read this before using it

- This automates browsing on LinkedIn, which their terms of service prohibit
  ("bot, robot, scraper... to access the Services"). Running it is a
  ToS violation, and LinkedIn's anti-automation systems actively look for
  exactly this pattern (rapid sequential navigation, headless-style click
  patterns) — no delay setting or tweak here makes it undetectable. Possible
  consequences range from nothing, to a warning/checkpoint, to temporary
  restriction, to permanent account ban. That risk is entirely on the account
  you run it with.
- It does not do anything to disguise itself as human traffic beyond basic
  pacing (randomized delays between actions, so it isn't clicking every 200ms).
  It does not rotate IPs, spoof a fingerprint, or attempt to solve
  checkpoints/CAPTCHAs — if LinkedIn serves one, the run will just stall or
  error out, and you should stop and resolve it manually, not try to automate
  past it.
- Use your own account. It relies on you already being logged into LinkedIn in
  the browser tab it opens — it doesn't handle credentials.
- Slower and lower `maxResults` is safer than faster and higher. There's no
  "safe" number, but a handful of listings a day looks a lot more like a
  person than 200 in one sitting.

## Setup

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`linkedin-job-scraper-extension/`).
4. Make sure you're logged into LinkedIn in a normal tab first.

## Usage

1. Click the extension icon.
2. Click **Choose** next to **Save folder** and pick where files should be
   written. The extension remembers that folder. It does not use Downloads.
3. Fill in **Keywords** (required) and **Location** (optional).
4. Set **Max results** and the **delay range** (seconds between actions —
   defaults are 3–7s; don't set this near 0).
5. Optionally set filters (same ones LinkedIn's own search bar offers):
   - **Date posted** — any time / past 24h / past week / past month
   - **Experience level** — Internship, Entry level, Associate, Mid-Senior,
     Director, Executive (pick as many as you want)
   - **Remote** — On-site, Remote, Hybrid (pick as many as you want)
   - **Easy Apply only** — checkbox
   - **Company** — LinkedIn doesn't filter by company name in the URL, only
     by an internal numeric ID. To use this: go to linkedin.com, apply the
     Company filter manually once for the company you want, then copy the
     number(s) after `f_C=` in the address bar and paste them here
     (comma-separated for more than one). This only needs doing once per
     company — reuse the ID after that.

   Click **Reset** next to "Filters" to clear all of the above back to
   defaults.
6. Click **Start**. A new tab opens with the LinkedIn job search (filters
   already applied); leave it open and don't interact with it while the run
   is in progress. After the last new listing on a page is captured, the run
   opens the next page and continues until **Max results** is reached or
   LinkedIn has no further pages.
7. Watch the popup for live progress (`Captured: N / max`). Click **Stop**
   any time to end the run early — whatever was captured so far is still
   saved.
8. When the run finishes (or you stop it), `linkedin-jobs-<YYYY-MM-DD>.md`
   is written in the folder you chose (a second run the same day is saved
   alongside it, with a number added to the name). If Chrome needs permission
   again, open the extension and click **Save**.
   Listings captured in the last 30 days are not opened again and do not
   count toward **Max results**.

## If it stops finding jobs (LinkedIn changed their layout)

LinkedIn redesigns their job-search page and renames CSS classes fairly
often, which will break the selectors this relies on. `content.js` has a
`SELECTORS` object at the top listing, for each piece of data (job card,
title, company, location, description, pagination button, etc.), an ordered
list of CSS selectors it tries. To fix a break:

1. On the LinkedIn jobs page, right-click the element that's no longer being
   captured (a job card, the title in the detail pane, etc.) → **Inspect**.
2. Look for something stable to select on — a `data-job-id` attribute, an
   `aria-label`, a semantic tag — rather than an auto-generated class like
   `jobs-abc123xyz` (those get regenerated on every LinkedIn deploy).
3. Add the new selector as another entry in the relevant array in
   `SELECTORS`. You don't need to remove the old one — the code tries each
   candidate in order and uses the first match, so both old and new layouts
   can be supported at once.
4. Reload the extension (`chrome://extensions` → refresh icon) and try again.

## What it does not do

- No automated login — you log in yourself, normally, first.
- No CAPTCHA/checkpoint solving.
- No IP rotation or proxying.
- No fingerprint spoofing or headless-browser masking.

If you want any of that added, ask for it explicitly and think through
whether the risk is one you actually want to take on — this build
intentionally stops at "reasonably paced automation," not "undetectable
automation."
