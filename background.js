"use strict";

// The only part of the extension that talks to the network. It fetches from
// bugzilla.mozilla.org and phabricator.services.mozilla.com using the
// browser's logged-in sessions (or an optional Bugzilla API key), and from
// nowhere else.

const BMO = "https://bugzilla.mozilla.org";
const PHAB = "https://phabricator.services.mozilla.com";
const VIEW_URL = browser.runtime.getURL("view.html");
const OPTIONS_URL = browser.runtime.getURL("options.html");

function isId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

function errorResult(e) {
  return { error: String(e?.message || e) };
}

// Messaging

browser.runtime.onMessage.addListener((msg, sender) => {
  const fromView = sender.url?.startsWith(VIEW_URL);
  const fromOptions = sender.url?.startsWith(OPTIONS_URL);

  switch (msg?.type) {
    // Titles go to the content script, which shows them in a closed shadow
    // root in Gmail's page.
    case "getBugTitle":
      if (isId(msg.id)) {
        return getCachedTitle(`bug:${msg.id}`, () => fetchBugTitle(msg.id));
      }
      break;
    case "getRevisionTitle":
      if (isId(msg.id)) {
        return getCachedTitle(`rev:${msg.id}`, () =>
          fetchRevisionTitle(msg.id)
        );
      }
      break;

    // Comments and field changes only go to view.html, which is cross-origin
    // to Gmail. The content script never receives them.
    case "getActivity":
      if (fromView && isId(msg.id)) {
        return getActivity(msg.id, Number(msg.notBefore) || 0);
      }
      break;

    // view.html can't message the content script directly, so relay its
    // height through here rather than via postMessage, which Gmail could see.
    case "frameHeight":
      if (fromView && sender.tab) {
        browser.tabs
          .sendMessage(sender.tab.id, msg, { frameId: 0 })
          .catch(() => {});
      }
      break;

    case "clearCache":
      if (fromOptions) {
        return clearCaches();
      }
      break;
  }
  return undefined;
});

// Titles

const TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const TITLE_ERROR_TTL_MS = 2 * 60 * 1000;
const inflightTitles = new Map();

// Returns { title } or { error }. Results are cached in storage.session, which
// is held in memory and never written to disk.
async function getCachedTitle(key, fetchTitle) {
  const { [key]: cached } = await browser.storage.session.get(key);
  if (cached) {
    const ttl = cached.title ? TITLE_TTL_MS : TITLE_ERROR_TTL_MS;
    if (Date.now() - cached.time < ttl) {
      return cached;
    }
  }

  if (!inflightTitles.has(key)) {
    const promise = fetchTitle()
      .then(title => ({ title }), errorResult)
      .then(async result => {
        const entry = { ...result, time: Date.now() };
        await browser.storage.session.set({ [key]: entry });
        return entry;
      })
      .finally(() => inflightTitles.delete(key));
    inflightTitles.set(key, promise);
  }
  return inflightTitles.get(key);
}

async function fetchBugTitle(id) {
  const apiKey = await getApiKey();
  let title;
  if (apiKey) {
    const json = await restGet(`bug/${id}?include_fields=summary`, apiKey);
    title = json.bugs?.[0]?.summary;
  } else {
    const bug = await fetchBugXml(id, "short_desc");
    title = bug.querySelector("short_desc")?.textContent;
  }
  if (!title) {
    throw new Error("No summary in Bugzilla response");
  }
  return title;
}

// The revision page's title is "⚙ D123 Bug 456 - Title r=foo".
async function fetchRevisionTitle(id) {
  const doc = await fetchDocument(`${PHAB}/D${id}`, "text/html");
  const match = doc.title.trim().match(new RegExp(`^\\W*D${id}\\s+(.+)$`));
  if (!match) {
    // Don't echo the page title: errors are shown as tooltips in Gmail's page.
    throw new Error(
      "Couldn't read the revision title - are you logged in to Phabricator?"
    );
  }
  return match[1];
}

// Fetching

async function getApiKey() {
  const { apiKey } = await browser.storage.local.get("apiKey");
  return apiKey;
}

// Fetches a page using the browser's logged-in session.
async function fetchDocument(url, type) {
  const resp = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return new DOMParser().parseFromString(await resp.text(), type);
}

// Fetches a bug's XML, restricted to one field (e.g. "short_desc").
async function fetchBugXml(id, field) {
  const doc = await fetchDocument(
    `${BMO}/show_bug.cgi?ctype=xml&id=${id}&field=${field}`,
    "application/xml"
  );
  const bug = doc.querySelector("bug");
  if (!bug) {
    throw new Error("Unexpected Bugzilla response");
  }
  const error = bug.getAttribute("error");
  if (error === "NotPermitted") {
    throw new Error("Not permitted - are you logged in to Bugzilla?");
  }
  if (error) {
    throw new Error(`Bugzilla error: ${error}`);
  }
  return bug;
}

// Calls the Bugzilla REST API with the optional API key from the options page.
async function restGet(path, apiKey) {
  const resp = await fetch(`${BMO}/rest/${path}`, {
    headers: { "X-BUGZILLA-API-KEY": apiKey },
    credentials: "omit",
    cache: "no-store",
  });
  const json = await resp.json();
  if (json.error) {
    throw new Error(json.message || `Bugzilla error ${json.code}`);
  }
  return json;
}

// Activity
//
// A bug's comments and field changes, grouped into change sets: everything
// changed in one action shares a timestamp, and each action sends one bugmail.

const ACTIVITY_TTL_MS = 5 * 60 * 1000;
const activityCache = new Map();

// Fetches again if the cached copy is older than notBefore, i.e. the email
// being shown arrived after we last fetched.
function getActivity(id, notBefore) {
  const cached = activityCache.get(id);
  if (
    cached &&
    Date.now() - cached.time < ACTIVITY_TTL_MS &&
    cached.time > notBefore
  ) {
    return cached.promise;
  }
  const promise = fetchActivity(id).then(result => {
    if (result.error) {
      activityCache.delete(id);
    }
    return result;
  });
  activityCache.set(id, { time: Date.now(), promise });
  return promise;
}

async function fetchActivity(id) {
  try {
    const apiKey = await getApiKey();
    const events = apiKey
      ? await activityViaRest(id, apiKey)
      : await activityViaCookies(id);
    return { changeSets: groupIntoChangeSets(events) };
  } catch (e) {
    return errorResult(e);
  }
}

// events: [{ time, who, change?, comment? }], one per field change or comment.
function groupIntoChangeSets(events) {
  const sets = new Map();
  for (const { time, who, change, comment } of events) {
    if (!sets.has(time)) {
      sets.set(time, { time, who, changes: [], comments: [] });
    }
    const set = sets.get(time);
    if (change) {
      set.changes.push(change);
    }
    if (comment) {
      set.comments.push(comment);
      // Comments carry the real name, which reads better than a login.
      set.who = who;
    }
  }
  return [...sets.values()].sort((a, b) => a.time - b.time);
}

// Activity with an API key: the REST history and comment APIs.

const REST_FIELD_LABELS = {
  "flagtypes.name": "Flags",
  bug_status: "Status",
  short_desc: "Summary",
  assigned_to: "Assignee",
  cc: "CC",
  keywords: "Keywords",
  whiteboard: "Whiteboard",
  resolution: "Resolution",
  priority: "Priority",
  bug_severity: "Severity",
  depends_on: "Depends on",
  blocks: "Blocks",
  see_also: "See Also",
  attachments_created: "Attachment Created",
};

async function activityViaRest(id, apiKey) {
  const [history, comments] = await Promise.all([
    restGet(`bug/${id}/history`, apiKey),
    restGet(
      `bug/${id}/comment?include_fields=count,creator,creation_time,text`,
      apiKey
    ),
  ]);

  const events = [];
  for (const entry of history.bugs?.[0]?.history ?? []) {
    for (const c of entry.changes) {
      events.push({
        time: Date.parse(entry.when),
        who: entry.who,
        change: {
          field: REST_FIELD_LABELS[c.field_name] || c.field_name,
          removed: c.removed,
          added: c.added,
        },
      });
    }
  }
  for (const c of comments.bugs?.[id]?.comments ?? []) {
    events.push({
      time: Date.parse(c.creation_time),
      who: c.creator,
      comment: { number: c.count, text: c.text },
    });
  }
  return events;
}

// Activity with the logged-in session: comments from the bug's XML, field
// changes from the show_activity.cgi page.

async function activityViaCookies(id) {
  const [bug, activityPage] = await Promise.all([
    fetchBugXml(id, "long_desc"),
    fetchDocument(`${BMO}/show_activity.cgi?id=${id}`, "text/html"),
  ]);
  const comments = commentEvents(bug);
  // Both pages use the user's preferred timezone. The XML gives a numeric
  // offset; the activity page gives an abbreviation we may not recognize.
  const fallbackOffset = comments.at(-1)?.offset ?? "Z";
  return [...comments, ...changeEvents(activityPage, fallbackOffset)].filter(
    e => !Number.isNaN(e.time)
  );
}

function commentEvents(bug) {
  return [...bug.querySelectorAll("long_desc")].map((desc, number) => {
    const when = desc.querySelector("bug_when")?.textContent ?? "";
    const who = desc.querySelector("who");
    return {
      time: parseBugzillaTime(when),
      offset: zoneOffset(when.trim().split(" ").at(-1)),
      who: who?.getAttribute("name") || who?.textContent,
      comment: {
        number,
        text: desc.querySelector("thetext")?.textContent ?? "",
      },
    };
  });
}

// The activity table has Who, When, What, Removed, Added columns. The first
// row of each change set has Who and When cells spanning all of its rows, so
// later rows only have the last three.
function changeEvents(activityPage, fallbackOffset) {
  const table = [...activityPage.querySelectorAll("table")].find(t =>
    t.querySelector("th")?.textContent.includes("Who")
  );
  const events = [];
  let who, time;
  for (const row of table?.rows ?? []) {
    const cells = [...row.cells]
      .filter(cell => cell.localName === "td")
      .map(cell => cell.textContent.replace(/\s+/g, " ").trim());
    if (cells.length === 5) {
      who = cells[0];
      time = parseBugzillaTime(cells[1], fallbackOffset);
    }
    if ((cells.length === 5 || cells.length === 3) && who) {
      const [field, removed, added] = cells.slice(-3);
      events.push({ time, who, change: { field, removed, added } });
    }
  }
  return events;
}

// Hour offsets for the timezone abbreviations show_activity.cgi prints.
const TZ_OFFSETS = {
  UTC: 0, GMT: 0,
  PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4,
  BST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3,
  JST: 9, AEST: 10, AEDT: 11, NZST: 12, NZDT: 13,
};

// "-0700" or "PDT" -> "-07:00"; null if unrecognized.
function zoneOffset(zone) {
  if (/^[+-]\d{4}$/.test(zone)) {
    return `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const hours = TZ_OFFSETS[zone?.toUpperCase()];
  if (hours === undefined) {
    return null;
  }
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

// "2026-10-05 09:30:12 -0700" or "2026-10-05 09:30 PDT" -> milliseconds.
function parseBugzillaTime(text, fallbackOffset = "Z") {
  const m = text
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})? ?(\S+)?$/);
  if (!m) {
    return NaN;
  }
  const [, date, hoursMinutes, seconds = ":00", zone = "UTC"] = m;
  const offset = zoneOffset(zone) ?? fallbackOffset;
  return Date.parse(`${date}T${hoursMinutes}${seconds}${offset}`);
}

// Clearing

async function clearCaches() {
  activityCache.clear();
  const count = Object.keys(await browser.storage.session.get(null)).length;
  await browser.storage.session.clear();
  return count;
}
