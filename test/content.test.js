"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScript, mockBrowser, settle } = require("./helpers");

const LOCK = "\u{1F512}";

// titles: { "getBugTitle:123": "Title", "getRevisionTitle:456": "Title" }.
// Anything missing answers with an error.
async function setup(body, titles = {}) {
  const browser = mockBrowser({
    sendMessage: async ({ type, id }) => {
      const title = titles[`${type}:${id}`];
      return title ? { title } : { error: "Not permitted" };
    },
  });
  const window = loadScript("content.js", {
    html: `<!DOCTYPE html><html><head><title>Inbox</title></head><body>${body}</body></html>`,
    url: "https://mail.google.com/mail/u/0/",
    browser,
  });
  await settle();
  return { browser, window, document: window.document };
}

// What the user sees in a subject element: the shadow root's text if we've
// drawn into it, otherwise Gmail's own text.
function shown(window, el) {
  const state = window.eval("subjectHosts").get(el);
  if (!state || state.shadow.querySelector("slot")) {
    return el.textContent;
  }
  return state.shadow.textContent;
}

function isHosted(window, el) {
  return window.eval("subjectHosts").has(el);
}

test("Bugzilla subjects show the real title", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), `[Bug 123] ${LOCK} Real title`);
});

test("Gmail's page still sees only the original subject", async () => {
  const { document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  assert.equal(s.textContent, "[Bug 123] (Secure bug 123 in Core :: DOM)");
  assert.equal(s.shadowRoot, null);
  assert.doesNotMatch(document.documentElement.outerHTML, /Real title/);
});

test("the tab title is left alone", async () => {
  const { document } = await setup("", { "getBugTitle:123": "Real title" });
  document.title = "[Bug 123] (Secure bug 123 in Core :: DOM)";
  await settle();
  assert.equal(document.title, "[Bug 123] (Secure bug 123 in Core :: DOM)");
});

test("Phabricator subjects show the revision title", async () => {
  const { window, document } = await setup(
    `<span id="s">D456: (secure bug 123)</span>`,
    { "getBugTitle:123": "Bug title", "getRevisionTitle:456": "Bug 123 - Fix it r=me" }
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), `D456: ${LOCK} Bug 123 - Fix it r=me`);
});

test("Phabricator subjects fall back to the bug title", async () => {
  const { window, document } = await setup(
    `<span id="s">D456: (secure bug 123)</span>`,
    { "getBugTitle:123": "Bug title" }
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), `D456: ${LOCK} Bug 123 - Bug title`);
});

test("failed lookups leave the subject alone and explain in a tooltip", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), "[Bug 123] (Secure bug 123 in Core :: DOM)");
  assert.match(s.title, /Not permitted/);
});

test("search highlighting that rebuilds the subject keeps working", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  s.innerHTML = "[Bug <b>123</b>] (Secure bug <b>123</b> in Core :: DOM)";
  await settle();
  assert.equal(shown(window, s), `[Bug 123] ${LOCK} Real title`);
  assert.equal(s.childNodes.length, 5, "Gmail's nodes are untouched");
});

test("search highlighting that splits the text in place keeps working", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  s.firstChild.splitText(5).splitText(3);
  await settle();
  assert.equal(shown(window, s), `[Bug 123] ${LOCK} Real title`);
  assert.equal(s.childNodes.length, 3, "Gmail's nodes are untouched");
});

test("search results that arrive highlighted are restored", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug <b>123</b>] (Secure <b>bug</b> 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), `[Bug 123] ${LOCK} Real title`);
});

test("rows Gmail reuses for other email show Gmail's content again", async () => {
  const { window, document } = await setup(
    `<span id="s">[Bug 123] (Secure bug 123 in Core :: DOM)</span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  s.textContent = "Lunch on Friday?";
  await settle();
  assert.equal(shown(window, s), "Lunch on Friday?");
});

test("only the subject is drawn into, not labels or the snippet", async () => {
  const { window, document } = await setup(
    `<div id="cell">
      <div id="label"><span>Trash</span></div>
      <span><span id="subject">D456: (secure bug <b>123</b>)</span></span>
      <span id="snippet"> - secure bug <b>123</b>) (https://bugzilla.mozilla.org/show_bug.cgi?id=123)</span>
    </div>`,
    { "getRevisionTitle:456": "Bug 123 - Fix it" }
  );
  for (const id of ["cell", "label", "snippet"]) {
    assert.ok(!isHosted(window, document.getElementById(id)), id);
  }
  const subject = document.getElementById("subject");
  assert.equal(shown(window, subject), `D456: ${LOCK} Bug 123 - Fix it`);
});

test("subjects wrapped in an element without shadow DOM use its parent", async () => {
  const { window, document } = await setup(
    `<span id="s"><b>[Bug 123] (Secure bug 123 in Core :: DOM)</b></span>`,
    { "getBugTitle:123": "Real title" }
  );
  const s = document.getElementById("s");
  assert.equal(shown(window, s), `[Bug 123] ${LOCK} Real title`);
});

const SECURE_BODY = `
  <div class="message">
    <span title="Mon, Oct 5, 2026, 9:30 AM">9:30 AM</span>
    <div class="a3s" id="body">This email would have contained sensitive information, but you have not set a key.<br>
      You can see this bug's current state at:
      <a href="https://bugzilla.mozilla.org/show_bug.cgi?id=123">https://bugzilla.mozilla.org/show_bug.cgi?id=123</a>
    </div>
  </div>`;

test("secure bugmail bodies get a view.html frame", async () => {
  const { document } = await setup(SECURE_BODY);
  const frame = document.querySelector("#body > iframe");
  assert.ok(frame);
  const url = new URL(frame.src);
  assert.equal(url.protocol, "moz-extension:");
  assert.equal(url.pathname, "/view.html");
  assert.equal(url.searchParams.get("id"), "123");
  assert.equal(
    Number(url.searchParams.get("time")),
    new Date(2026, 9, 5, 9, 30).getTime()
  );
  assert.ok(url.searchParams.get("token"));
});

test("the original body is kept, folded into a details element", async () => {
  const { document } = await setup(SECURE_BODY);
  const details = document.querySelector("#body > details");
  assert.equal(details.querySelector("summary").textContent, "Original message");
  assert.match(details.textContent, /would have contained sensitive information/);
  assert.equal(document.querySelectorAll("#body > iframe").length, 1);
});

test("the content script never asks for bug activity", async () => {
  const { browser } = await setup(SECURE_BODY);
  assert.ok(!browser.sentMessages.some(m => m.type === "getActivity"));
});

test("frames are sized from heights relayed by the background script", async () => {
  const { browser, document } = await setup(SECURE_BODY);
  const frame = document.querySelector("#body > iframe");
  const token = new URL(frame.src).searchParams.get("token");
  const [listener] = browser.listeners;

  listener({ type: "frameHeight", token: "someone-else", height: 999 });
  assert.equal(frame.style.height, "0px");
  listener({ type: "frameHeight", token, height: 120.4 });
  assert.equal(frame.style.height, "121px");
});

// A conversation where Gmail has trimmed a repeated secure bugmail body down
// to its "Show trimmed content" button.
function trimmedConversation({ sender = "bugzilla-daemon@mozilla.org", subject = "[Bug 123] (Secure bug 123 in Core :: DOM)" } = {}) {
  return `
    <h2 id="subject">${subject}</h2>
    <div class="message" id="message">
      <span email="${sender}" name="bugzilla-daemon">${sender}</span>
      <span title="Mon, Oct 5, 2026, 9:30 AM">9:30 AM</span>
      <div class="a3s" id="body">
        <div class="ajR" role="button" aria-label="Show trimmed content"><img alt=""></div>
      </div>
    </div>`;
}

test("trimmed secure bugmail gets a frame without clicking", async () => {
  const { document } = await setup(trimmedConversation());
  const frame = document.querySelector("#body > iframe");
  assert.ok(frame);
  const url = new URL(frame.src);
  assert.equal(url.searchParams.get("id"), "123");
  assert.equal(
    Number(url.searchParams.get("time")),
    new Date(2026, 9, 5, 9, 30).getTime()
  );
  // The frame goes above Gmail's button, which stays so the text can be shown.
  assert.equal(document.querySelector("#body").firstElementChild, frame);
  assert.ok(document.querySelector("#body > .ajR"));
});

test("trimmed bugmail frames go in the body, not the button's narrow wrapper", async () => {
  const { document } = await setup(`
    <h2>[Bug 123] (Secure bug 123 in Core :: DOM)</h2>
    <div class="message" id="message">
      <div class="header">
        <span email="bugzilla-daemon@mozilla.org">bugzilla-daemon</span>
        <span title="Mon, Oct 5, 2026, 9:30 AM">9:30 AM</span>
      </div>
      <div class="ii" id="region">
        <div class="a3s"><div class="adm" id="wrapper">
          <div class="ajR" role="button"><img alt=""></div>
        </div></div>
      </div>
    </div>`);
  const frame = document.querySelector("iframe");
  assert.equal(frame.parentElement.id, "region");
  assert.equal(document.getElementById("region").firstElementChild, frame);
  assert.equal(document.querySelectorAll("#wrapper iframe").length, 0);
});

test("trimmed bugmail that arrives later gets a frame", async () => {
  const { document } = await setup("");
  const conversation = document.createElement("div");
  conversation.innerHTML = trimmedConversation();
  document.body.append(conversation);
  await settle();
  assert.ok(document.querySelector("#body > iframe"));
});

test("showing trimmed text afterwards doesn't add a second frame", async () => {
  const { document } = await setup(trimmedConversation());
  const revealed = document.createElement("div");
  revealed.innerHTML = `This email would have contained sensitive information.
    <a href="https://bugzilla.mozilla.org/show_bug.cgi?id=123">link</a>`;
  document.getElementById("body").append(revealed);
  await settle();
  assert.equal(document.querySelectorAll("#message iframe").length, 1);
});

test("trimmed mail from other senders is left alone", async () => {
  const { document } = await setup(
    trimmedConversation({ sender: "someone@example.com" })
  );
  assert.equal(document.querySelector("iframe"), null);
});

test("trimmed bugmail in a conversation that isn't secure is left alone", async () => {
  const { document } = await setup(
    trimmedConversation({ subject: "[Bug 123] An ordinary public bug" })
  );
  assert.equal(document.querySelector("iframe"), null);
});

test("partly trimmed mail with visible text is left alone", async () => {
  const { document } = await setup(
    trimmedConversation().replace(
      '<div class="ajR"',
      'Some visible text<div class="ajR"'
    )
  );
  assert.equal(document.querySelector("iframe"), null);
});

test("Gmail date tooltips parse in US and day-first formats", async () => {
  const { window } = await setup("");
  const parse = window.eval("parseGmailDate");
  const expected = new Date(2026, 9, 5, 21, 30).getTime();
  assert.equal(parse("Mon, Oct 5, 2026, 9:30\u202fPM"), expected);
  assert.equal(parse("Mon, Oct 5, 2026, 9:30 PM (2 hours ago)"), expected);
  assert.equal(parse("Mon, 5 Oct 2026, 21:30"), expected);
  assert.equal(parse("Mon, Oct 5, 2026, 12:05 AM"), new Date(2026, 9, 5, 0, 5).getTime());
  assert.equal(parse("Oct 5"), null);
  assert.equal(parse("Foo 5, 2026, 9:30 PM"), null);
});
