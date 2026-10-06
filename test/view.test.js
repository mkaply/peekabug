"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EXTENSION_URL, ROOT, loadScript, mockBrowser, settle } = require("./helpers");

const MINUTE = 60 * 1000;
const EMAIL_TIME = Date.parse("2026-10-05T16:30:00Z");

// view.html without its <script>, which loadScript runs instead.
const VIEW_HTML = fs
  .readFileSync(path.join(ROOT, "view.html"), "utf8")
  .replace(/<script[^>]*><\/script>/, "");

async function setup({ changeSets = [], error, params = {} } = {}) {
  const browser = mockBrowser({
    sendMessage: async msg =>
      msg.type === "getActivity" ? (error ? { error } : { changeSets }) : undefined,
  });
  const search = new URLSearchParams({
    id: "123",
    time: EMAIL_TIME,
    token: "frame-token",
    color: "rgb(1, 2, 3)",
    ...params,
  });
  const window = loadScript("view.js", {
    html: VIEW_HTML,
    url: `${EXTENSION_URL}view.html?${search}`,
    browser,
    globals: {
      CSS: { supports: (property, value) => /^rgb\(/.test(value) },
      // Reports once, like the real ResizeObserver does on observe().
      ResizeObserver: class {
        constructor(callback) {
          this.callback = callback;
        }
        observe() {
          this.callback();
        }
      },
    },
  });
  await settle();
  return { browser, window, document: window.document };
}

function changeSet(time, extra = {}) {
  return { time, who: "Dev Person", changes: [], comments: [], ...extra };
}

test("shows the change set made just before the email arrived", async () => {
  const { document } = await setup({
    changeSets: [
      changeSet(EMAIL_TIME - 60 * MINUTE, { comments: [{ number: 1, text: "Old" }] }),
      changeSet(EMAIL_TIME + 20 * 1000, {
        changes: [{ field: "Status", removed: "NEW", added: "ASSIGNED" }],
        comments: [{ number: 2, text: "New comment" }],
      }),
    ],
  });
  const text = document.body.textContent;
  assert.match(text, /Dev Person/);
  assert.match(text, /New comment/);
  assert.doesNotMatch(text, /Old/);
  const cells = [...document.querySelectorAll("td")].map(td => td.textContent);
  assert.deepEqual(cells, ["Status", "NEW", "ASSIGNED"]);
  const link = document.querySelector(".comment-link a");
  assert.equal(link.href, "https://bugzilla.mozilla.org/show_bug.cgi?id=123#c2");
  assert.equal(link.rel, "noopener noreferrer");
});

test("ignores changes made after the email arrived", async () => {
  const { document } = await setup({
    changeSets: [changeSet(EMAIL_TIME + 2 * MINUTE, { comments: [{ number: 3, text: "Later" }] })],
  });
  assert.doesNotMatch(document.body.textContent, /Later/);
  assert.match(document.body.textContent, /No Bugzilla activity found/);
});

test("falls back to the closest earlier change, and says so", async () => {
  const { document } = await setup({
    changeSets: [changeSet(EMAIL_TIME - 30 * MINUTE, { comments: [{ number: 1, text: "Earlier" }] })],
  });
  assert.match(document.body.textContent, /Earlier/);
  assert.match(document.body.textContent, /closest earlier activity/);
});

test("comment text is shown as text, never as HTML", async () => {
  const { document } = await setup({
    changeSets: [
      changeSet(EMAIL_TIME, {
        who: "<b>Name</b>",
        changes: [{ field: "<i>f</i>", removed: "", added: "<img src=x>" }],
        comments: [{ number: 1, text: "<img src=x onerror=alert(1)>" }],
      }),
    ],
  });
  assert.equal(document.querySelector("img, b, i"), null);
  assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
});

test("errors are shown", async () => {
  const { document } = await setup({ error: "Not permitted" });
  assert.match(document.body.textContent, /Couldn't load Bugzilla activity: Not permitted/);
});

test("bad parameters don't fetch anything", async () => {
  const { browser, document } = await setup({ params: { id: "1&x" } });
  assert.match(document.body.textContent, /Bad parameters/);
  assert.ok(!browser.sentMessages.some(m => m.type === "getActivity"));
});

test("reports its height through extension messaging with its token", async () => {
  const { browser } = await setup();
  const report = browser.sentMessages.find(m => m.type === "frameHeight");
  assert.equal(report.token, "frame-token");
  assert.equal(typeof report.height, "number");
});

test("uses Gmail's text color only if it's a valid color", async () => {
  const valid = await setup();
  assert.equal(valid.document.body.style.color, "rgb(1, 2, 3)");
  const invalid = await setup({ params: { color: "red; background: url(x)" } });
  assert.equal(invalid.document.body.style.color, "");
});
