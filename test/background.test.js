"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EXTENSION_URL, loadScript, mockBrowser } = require("./helpers");

const BMO = "https://bugzilla.mozilla.org";
const PHAB = "https://phabricator.services.mozilla.com";
const GMAIL = { url: "https://mail.google.com/mail/u/0/", tab: { id: 7 } };
const VIEW = { url: `${EXTENSION_URL}view.html?id=123`, tab: { id: 7 } };
const OPTIONS = { url: `${EXTENSION_URL}options.html` };

const BUG_XML = `<?xml version="1.0"?>
<bugzilla><bug><bug_id>123</bug_id><short_desc>Real bug title</short_desc></bug></bugzilla>`;

const NOT_PERMITTED_XML = `<?xml version="1.0"?>
<bugzilla><bug error="NotPermitted"><bug_id>123</bug_id></bug></bugzilla>`;

const COMMENTS_XML = `<?xml version="1.0"?>
<bugzilla><bug><bug_id>123</bug_id>
  <long_desc><commentid>1</commentid><who name="Reporter Person">reporter</who>
    <bug_when>2026-10-01 08:00:00 -0700</bug_when><thetext>Description</thetext></long_desc>
  <long_desc><commentid>2</commentid><who name="Dev Person [:dev]">dev</who>
    <bug_when>2026-10-05 09:30:12 -0700</bug_when><thetext>A comment</thetext></long_desc>
</bug></bugzilla>`;

// Two change sets: one sharing comment 1's time (in PDT), and one in a
// timezone we don't recognize, which falls back to the comments' offset.
const ACTIVITY_HTML = `<html><body><table class="standard">
  <tr><th>Who</th><th>When</th><th>What</th><th>Removed</th><th>Added</th></tr>
  <tr><td rowspan="2">dev</td><td rowspan="2">2026-10-05 09:30:12 PDT</td>
    <td>Flags</td><td></td><td>needinfo?(me)</td></tr>
  <tr><td>Status</td><td>NEW</td><td>ASSIGNED</td></tr>
  <tr><td rowspan="1">other</td><td rowspan="1">2026-10-05 10:00:00 XYZ</td>
    <td>CC</td><td></td><td>someone</td></tr>
</table></body></html>`;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

// routes: URL -> [status, body]
function setup(routes, { apiKey } = {}) {
  const fetches = [];
  const fetch = async (url, options) => {
    fetches.push({ url, options });
    const [status, body] = routes[url] ?? [404, "Not found"];
    return response(status, body);
  };
  const browser = mockBrowser({ local: apiKey ? { apiKey } : {} });
  const window = loadScript("background.js", {
    url: `${EXTENSION_URL}_generated_background_page.html`,
    browser,
    globals: { fetch },
  });
  const send = (msg, sender) => browser.listeners[0](msg, sender);
  return { browser, fetches, send, window };
}

test("bug titles come from the bug's XML using the logged-in session", async () => {
  const url = `${BMO}/show_bug.cgi?ctype=xml&id=123&field=short_desc`;
  const { send, fetches } = setup({ [url]: [200, BUG_XML] });

  const result = await send({ type: "getBugTitle", id: "123" }, GMAIL);
  assert.equal(result.title, "Real bug title");
  assert.equal(fetches[0].options.credentials, "include");

  // Cached for the next lookup.
  await send({ type: "getBugTitle", id: "123" }, GMAIL);
  assert.equal(fetches.length, 1);
});

test("bug title errors explain what went wrong", async () => {
  const url = `${BMO}/show_bug.cgi?ctype=xml&id=123&field=short_desc`;
  const { send } = setup({ [url]: [200, NOT_PERMITTED_XML] });
  const result = await send({ type: "getBugTitle", id: "123" }, GMAIL);
  assert.match(result.error, /logged in to Bugzilla/);
});

test("bug titles use the REST API when an API key is set", async () => {
  const url = `${BMO}/rest/bug/123?include_fields=summary`;
  const body = JSON.stringify({ bugs: [{ summary: "Real bug title" }] });
  const { send, fetches } = setup({ [url]: [200, body] }, { apiKey: "k" });

  const result = await send({ type: "getBugTitle", id: "123" }, GMAIL);
  assert.equal(result.title, "Real bug title");
  assert.equal(fetches[0].options.headers["X-BUGZILLA-API-KEY"], "k");
  assert.equal(fetches[0].options.credentials, "omit");
});

test("revision titles come from the revision page's title", async () => {
  const page = "<html><head><title>⚙ D456 Bug 123 - Fix it r=me</title></head></html>";
  const { send } = setup({ [`${PHAB}/D456`]: [200, page] });
  const result = await send({ type: "getRevisionTitle", id: "456" }, GMAIL);
  assert.equal(result.title, "Bug 123 - Fix it r=me");
});

test("revision title errors never include the fetched page's title", async () => {
  // Errors are shown as tooltips in Gmail's page, so an unexpected title
  // format must not leak the real title through the error.
  const page = "<html><head><title>D456: Secret revision title</title></head></html>";
  const { send } = setup({ [`${PHAB}/D456`]: [200, page] });
  const result = await send({ type: "getRevisionTitle", id: "456" }, GMAIL);
  assert.ok(result.error);
  assert.doesNotMatch(result.error, /Secret/);
});

test("ids must be numeric", async () => {
  const { send, fetches } = setup({});
  assert.equal(await send({ type: "getBugTitle", id: "1&x=y" }, GMAIL), undefined);
  assert.equal(await send({ type: "getRevisionTitle", id: 5 }, GMAIL), undefined);
  assert.equal(fetches.length, 0);
});

test("activity is only sent to view.html, never to the content script", async () => {
  const { send, fetches } = setup({});
  assert.equal(await send({ type: "getActivity", id: "123" }, GMAIL), undefined);
  assert.equal(fetches.length, 0);
});

test("activity groups comments and field changes into change sets", async () => {
  const { send } = setup({
    [`${BMO}/show_bug.cgi?ctype=xml&id=123&field=long_desc`]: [200, COMMENTS_XML],
    [`${BMO}/show_activity.cgi?id=123`]: [200, ACTIVITY_HTML],
  });
  const { changeSets } = await send({ type: "getActivity", id: "123" }, VIEW);

  assert.equal(changeSets.length, 3);
  const [description, update, ccChange] = changeSets;

  assert.equal(description.comments[0].number, 0);

  assert.equal(update.time, Date.parse("2026-10-05T16:30:12Z"));
  assert.equal(update.who, "Dev Person [:dev]");
  assert.equal(
    JSON.stringify(update.changes),
    JSON.stringify([
      { field: "Flags", removed: "", added: "needinfo?(me)" },
      { field: "Status", removed: "NEW", added: "ASSIGNED" },
    ])
  );
  assert.equal(
    JSON.stringify(update.comments),
    JSON.stringify([{ number: 1, text: "A comment" }])
  );

  // "XYZ" isn't a known zone, so it uses the comments' -07:00.
  assert.equal(ccChange.time, Date.parse("2026-10-05T17:00:00Z"));
});

test("activity uses the REST API when an API key is set", async () => {
  const history = {
    bugs: [{
      history: [{
        when: "2026-10-05T16:30:12Z",
        who: "dev@example.com",
        changes: [{ field_name: "flagtypes.name", removed: "", added: "needinfo?(me)" }],
      }],
    }],
  };
  const comments = {
    bugs: {
      123: {
        comments: [{ count: 1, creator: "dev@example.com", creation_time: "2026-10-05T16:30:12Z", text: "A comment" }],
      },
    },
  };
  const { send } = setup(
    {
      [`${BMO}/rest/bug/123/history`]: [200, JSON.stringify(history)],
      [`${BMO}/rest/bug/123/comment?include_fields=count,creator,creation_time,text`]:
        [200, JSON.stringify(comments)],
    },
    { apiKey: "k" }
  );
  const { changeSets } = await send({ type: "getActivity", id: "123" }, VIEW);
  assert.equal(changeSets.length, 1);
  assert.equal(changeSets[0].changes[0].field, "Flags");
  assert.equal(changeSets[0].comments[0].text, "A comment");
});

test("frame heights are only relayed from view.html, to the top frame", async () => {
  const { send, browser } = setup({});
  const msg = { type: "frameHeight", token: "t", height: 100 };
  await send(msg, GMAIL);
  assert.equal(browser.sentToTabs.length, 0);
  await send(msg, VIEW);
  assert.equal(
    JSON.stringify(browser.sentToTabs),
    JSON.stringify([[7, msg, { frameId: 0 }]])
  );
});

test("only the options page can clear the caches", async () => {
  const url = `${BMO}/show_bug.cgi?ctype=xml&id=123&field=short_desc`;
  const { send, browser } = setup({ [url]: [200, BUG_XML] });
  await send({ type: "getBugTitle", id: "123" }, GMAIL);

  assert.equal(await send({ type: "clearCache" }, GMAIL), undefined);
  assert.equal(Object.keys(browser.session).length, 1);
  assert.equal(await send({ type: "clearCache" }, OPTIONS), 1);
  assert.equal(Object.keys(browser.session).length, 0);
});

test("titles are cached in session storage, never local storage", async () => {
  const url = `${BMO}/show_bug.cgi?ctype=xml&id=123&field=short_desc`;
  const { send, browser } = setup({ [url]: [200, BUG_XML] });
  await send({ type: "getBugTitle", id: "123" }, GMAIL);
  assert.deepEqual(Object.keys(browser.session), ["bug:123"]);
  assert.deepEqual(Object.keys(browser.local), []);
});

test("Bugzilla times parse with offsets and zone abbreviations", () => {
  const { window } = setup({});
  const parse = (...args) => window.eval("parseBugzillaTime")(...args);
  assert.equal(parse("2026-10-05 09:30:12 -0700"), Date.parse("2026-10-05T16:30:12Z"));
  assert.equal(parse("2026-10-05 09:30 PDT"), Date.parse("2026-10-05T16:30:00Z"));
  assert.equal(parse("2026-10-05 09:30:12 ABC", "+02:00"), Date.parse("2026-10-05T07:30:12Z"));
  assert.ok(Number.isNaN(parse("yesterday")));
});
