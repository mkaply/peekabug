"use strict";

// Runs in Gmail's page. Real titles and bug activity are never written into
// Gmail's own DOM, where Gmail's scripts could read them:
// - Subjects are drawn inside a closed shadow root attached to Gmail's subject
//   element. Its children are left in place (unslotted, so not displayed), so
//   Gmail's DOM reads unchanged.
// - Email bodies are drawn in a view.html iframe, which is cross-origin to
//   Gmail. This script never receives comment text or field changes.
// The tab title is left alone, since document.title is readable by Gmail.

const LOCK = "\u{1F512}";

// Bugzilla's "(Secure bug 2074772 in Firefox :: Enterprise Policies)",
// Phabricator's "D328629: (secure bug 2074635)", and similar variants.
const SECURE_BUG_SOURCE = String.raw`(?:\bD(\d+): )?\(secure bug (\d+)[^)]*\)`;
const SECURE_BUG = new RegExp(SECURE_BUG_SOURCE, "gi");
const HAS_SECURE_BUG = new RegExp(SECURE_BUG_SOURCE, "i");

// Gmail splits subjects into several text nodes when highlighting search
// terms, so a text node with any piece of a subject is worth a look.
const SUBJECT_PIECE = /secure|bug|\d{3,}/i;
const MAX_SUBJECT_LENGTH = 1000;

// The text of a secure bugmail body, and its link to the bug.
const BODY_MARKER = "This email would have contained sensitive information";
const SHOW_BUG_LINK = 'a[href*="show_bug.cgi?id="]';

// Elements that support attachShadow().
const SHADOW_HOSTS = new Set([
  "article", "aside", "blockquote", "div", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "main", "nav", "p", "section", "span",
]);

function isEditable(node) {
  const el = node.parentElement;
  return !el || el.isContentEditable || el.closest("textarea, input");
}

// Title lookups

const RETRY_ERRORS_AFTER_MS = 60 * 1000;
const titleLookups = new Map();

// type is "getBugTitle" or "getRevisionTitle". Resolves to { title } or
// { error }. Failed lookups are retried after a minute.
function lookupTitle(type, id) {
  const key = `${type}:${id}`;
  if (!titleLookups.has(key)) {
    const promise = browser.runtime
      .sendMessage({ type, id })
      .catch(e => ({ error: String(e?.message || e) }))
      .then(result => {
        if (!result?.title) {
          setTimeout(() => titleLookups.delete(key), RETRY_ERRORS_AFTER_MS);
        }
        return result;
      });
    titleLookups.set(key, promise);
  }
  return titleLookups.get(key);
}

// Resolves to a Map of id -> { title } or { error }.
async function lookupTitles(type, ids) {
  const entries = await Promise.all(
    [...ids].map(async id => [id, await lookupTitle(type, id)])
  );
  return new Map(entries);
}

// Subjects

// Gmail subject element -> { shadow, text }, where text is the subject text
// the shadow root is currently drawn for.
const subjectHosts = new WeakMap();

function existingHost(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    if (subjectHosts.has(el)) {
      return el;
    }
  }
  return null;
}

// Finds the element to draw a secure bug subject near node into. Climbing
// from node may reach a container that also holds labels or the snippet, so
// descend again to the smallest element holding the whole subject.
function newHost(node) {
  let el = node.parentElement;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    if (el.localName === "title") {
      return null;
    }
    const text = el.textContent;
    if (text.length > MAX_SUBJECT_LENGTH) {
      return null;
    }
    if (HAS_SECURE_BUG.test(text)) {
      return shadowHostFor(smallestMatch(el));
    }
  }
  return null;
}

function smallestMatch(el) {
  for (;;) {
    const child = [...el.children].find(c =>
      HAS_SECURE_BUG.test(c.textContent)
    );
    if (!child) {
      return el;
    }
    el = child;
  }
}

function shadowHostFor(el) {
  while (el && !SHADOW_HOSTS.has(el.localName)) {
    el = el.parentElement;
  }
  return el;
}

function showRestoredSubject(host, text, restored) {
  let state = subjectHosts.get(host);
  if (!state) {
    try {
      state = { shadow: host.attachShadow({ mode: "closed" }) };
    } catch {
      return;
    }
    subjectHosts.set(host, state);
  }
  state.text = text;
  state.shadow.replaceChildren(restored);
}

// Shows Gmail's own content again, e.g. when Gmail reuses an element we'd
// drawn into for a different email.
function showOriginalSubject(host, text) {
  const state = subjectHosts.get(host);
  if (state) {
    state.text = text;
    state.shadow.replaceChildren(document.createElement("slot"));
  }
}

function restoreSubject(text, bugTitles, revisionTitles) {
  return text.replace(SECURE_BUG, (placeholder, revision, bug) => {
    const prefix = revision ? `D${revision}: ` : "";
    const revisionTitle = revision && revisionTitles.get(revision)?.title;
    if (revisionTitle) {
      return `${prefix}${LOCK} ${revisionTitle}`;
    }
    const bugTitle = bugTitles.get(bug)?.title;
    if (!bugTitle) {
      return placeholder;
    }
    // Bugmail subjects already start with "[Bug N]"; Phabricator's don't.
    return text.includes(`[Bug ${bug}]`)
      ? `${prefix}${LOCK} ${bugTitle}`
      : `${prefix}${LOCK} Bug ${bug} - ${bugTitle}`;
  });
}

async function processSubject(host) {
  const text = host.textContent;
  if (subjectHosts.get(host)?.text === text) {
    return;
  }

  const bugs = new Set();
  const revisions = new Set();
  for (const [, revision, bug] of text.matchAll(SECURE_BUG)) {
    bugs.add(bug);
    if (revision) {
      revisions.add(revision);
    }
  }
  if (!bugs.size) {
    showOriginalSubject(host, text);
    return;
  }

  const [bugTitles, revisionTitles] = await Promise.all([
    lookupTitles("getBugTitle", bugs),
    lookupTitles("getRevisionTitle", revisions),
  ]);

  // Gmail may have re-rendered this element while we were waiting.
  if (host.textContent !== text || !host.isConnected) {
    return;
  }

  const restored = restoreSubject(text, bugTitles, revisionTitles);
  if (restored !== text) {
    showRestoredSubject(host, text, restored);
  } else {
    showOriginalSubject(host, text);
  }

  const errors = [...bugTitles.values(), ...revisionTitles.values()]
    .filter(result => result.error)
    .map(result => result.error);
  if (errors.length) {
    host.title = `Couldn't load the real title: ${errors.join("; ")}`;
  }
}

// Email bodies

// Parses Gmail's date tooltip: "Mon, Oct 5, 2026, 9:30 AM" (US) or
// "Mon, 5 Oct 2026, 09:30" (day first). Gmail only gives minute precision.
const TIME = String.raw`(?:at )?(?<hour>\d{1,2}):(?<minute>\d{2})\s*(?<ampm>[AP]M)?`;
const MONTH_FIRST = new RegExp(
  String.raw`(?<month>[A-Za-z]{3})[a-z]* (?<day>\d{1,2}), (?<year>\d{4}),? ${TIME}`,
  "i"
);
const DAY_FIRST = new RegExp(
  String.raw`(?<day>\d{1,2}) (?<month>[A-Za-z]{3})[a-z]* (?<year>\d{4}),? ${TIME}`,
  "i"
);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec"];

function parseGmailDate(tooltip) {
  const s = tooltip.replace(/[\u202f\u00a0]/g, " ");
  const date = (s.match(MONTH_FIRST) ?? s.match(DAY_FIRST))?.groups;
  const month = MONTHS.indexOf(date?.month.toLowerCase());
  if (month === -1) {
    return null;
  }
  let hour = Number(date.hour);
  if (date.ampm) {
    hour = (hour % 12) + (date.ampm.toUpperCase() === "PM" ? 12 : 0);
  }
  return new Date(date.year, month, date.day, hour, date.minute).getTime();
}

// The nearest ancestor holding a date tooltip is this message's container.
function findMessageDate(body) {
  for (let el = body.parentElement; el; el = el.parentElement) {
    for (const span of el.querySelectorAll("span[title]")) {
      const time = parseGmailDate(span.title);
      if (time) {
        return time;
      }
    }
  }
  return null;
}

// Gmail's message body element (.a3s), or failing that the nearest ancestor
// holding the link to the bug.
function findBody(node) {
  const gmailBody = node.parentElement.closest(".a3s");
  if (gmailBody) {
    return gmailBody;
  }
  let el = node.parentElement;
  for (let i = 0; el && i < 6; i++, el = el.parentElement) {
    if (el.querySelector(SHOW_BUG_LINK)) {
      return el;
    }
  }
  return null;
}

// token -> iframe. view.html reports its content height (relayed by the
// background script, so Gmail never sees it) and we size its iframe to fit.
const viewFrames = new Map();

browser.runtime.onMessage.addListener(msg => {
  if (msg?.type !== "frameHeight") {
    return;
  }
  const frame = viewFrames.get(msg.token);
  if (!frame?.isConnected) {
    viewFrames.delete(msg.token);
    return;
  }
  const height = Number(msg.height);
  if (height >= 0) {
    frame.style.height = `${Math.ceil(height)}px`;
  }
});

// Puts a view.html frame showing the bug's matching activity at the top of
// the body, and folds the original text into a collapsed <details>.
function processBody(node) {
  if (node.parentElement?.closest("[data-bmo-secure]")) {
    return;
  }
  const body = findBody(node);
  const link = body?.querySelector(SHOW_BUG_LINK);
  const id = link?.href.match(/show_bug\.cgi\?id=(\d+)/)?.[1];
  if (!id) {
    return;
  }
  const emailTime = findMessageDate(body);
  if (!emailTime) {
    return;
  }

  const token = crypto.randomUUID();
  const params = new URLSearchParams({
    token,
    id,
    time: emailTime,
    color: getComputedStyle(body).color,
  });
  const frame = document.createElement("iframe");
  frame.src = browser.runtime.getURL(`view.html?${params}`);
  frame.style.cssText =
    "border: 0; width: 100%; height: 0; display: block; margin-bottom: 1em;";

  const original = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Original message";
  summary.style.cssText = "cursor: pointer; opacity: 0.7;";
  original.append(summary, ...body.childNodes);

  body.dataset.bmoSecure = "done";
  body.append(frame, original);
  viewFrames.set(token, frame);
}

// Watching Gmail's DOM

function processTextNode(node) {
  const text = node.nodeValue ?? "";
  if (text.includes(BODY_MARKER) && !isEditable(node)) {
    processBody(node);
  }
  const host = existingHost(node);
  if (host) {
    processSubject(host);
    return;
  }
  if (!SUBJECT_PIECE.test(text) || isEditable(node)) {
    return;
  }
  const candidate = newHost(node);
  if (candidate) {
    processSubject(candidate);
  }
}

function scan(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    processTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n =>
      SUBJECT_PIECE.test(n.nodeValue) || n.nodeValue.includes(BODY_MARKER)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    processTextNode(n);
  }
}

new MutationObserver(mutations => {
  for (const m of mutations) {
    if (m.type === "characterData") {
      processTextNode(m.target);
      continue;
    }
    // Children of a subject we've drawn changed (e.g. search highlights).
    const host = existingHost(m.target);
    if (host) {
      processSubject(host);
    }
    m.addedNodes.forEach(scan);
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

scan(document.documentElement);
