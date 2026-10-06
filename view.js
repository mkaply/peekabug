"use strict";

// Draws a secure bug's activity inside an iframe in a Gmail message body.
// This page is cross-origin to Gmail, so Gmail's scripts can't read it, and
// its data comes straight from the background script, never via Gmail.
//
// URL parameters (set by content.js):
//   id     bug number
//   time   when the email arrived, in ms (Gmail only gives the minute)
//   color  Gmail's body text color, so the text matches light or dark themes
//   token  identifies this frame when reporting its height

const LOCK = "\u{1F512}";
const MINUTE = 60 * 1000;
// Bugmail usually arrives within seconds; allow some slack for queueing.
const MATCH_WINDOW_MS = 3 * MINUTE;
const FALLBACK_WINDOW_MS = 60 * MINUTE;

const params = new URLSearchParams(location.search);
const id = params.get("id");
const emailTime = Number(params.get("time"));

// Picks the change set(s) that most likely sent this email: those made in the
// few minutes before it arrived, or failing that the closest earlier one.
function matchChangeSets(changeSets) {
  // The email time is truncated to the minute.
  const end = emailTime + MINUTE;
  const before = changeSets.filter(s => s.time < end);
  const near = before.filter(s => s.time >= emailTime - MATCH_WINDOW_MS);
  if (near.length) {
    return { sets: near, exact: true };
  }
  const last = before.at(-1);
  if (last && last.time >= emailTime - FALLBACK_WINDOW_MS) {
    return { sets: [last], exact: false };
  }
  return { sets: [], exact: false };
}

// Creates an element. Children are added as nodes or text, never as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children.filter(c => c != null));
  return el;
}

function renderChangeSet(set, exact) {
  const when = new Date(set.time).toLocaleString();
  const section = h(
    "div",
    { className: "set" },
    h(
      "div",
      { className: "header" },
      `${LOCK} ${set.who}`,
      h(
        "span",
        { className: "muted" },
        ` \u2014 ${when}${exact ? "" : " (closest earlier activity)"}`
      )
    )
  );

  if (set.changes.length) {
    section.append(
      h(
        "table",
        {},
        h("tr", {}, ...["What", "Removed", "Added"].map(t => h("th", {}, t))),
        ...set.changes.map(c =>
          h("tr", {}, ...[c.field, c.removed, c.added].map(t => h("td", {}, t)))
        )
      )
    );
  }

  for (const c of set.comments) {
    section.append(
      h(
        "div",
        { className: "comment-link" },
        h(
          "a",
          {
            href: `https://bugzilla.mozilla.org/show_bug.cgi?id=${id}#c${c.number}`,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          `Comment #${c.number}`
        )
      ),
      h("div", { className: "comment" }, c.text)
    );
  }
  return section;
}

function showMessage(text) {
  document.body.append(h("div", { className: "muted" }, `${LOCK} ${text}`));
}

// The content script sizes this frame to fit. The height goes through the
// extension's own messaging rather than postMessage, which Gmail could see.
function reportHeight() {
  browser.runtime.sendMessage({
    type: "frameHeight",
    token: params.get("token"),
    height: document.documentElement.scrollHeight,
  });
}

async function render() {
  const color = params.get("color");
  if (color && CSS.supports("color", color)) {
    document.body.style.color = color;
  }

  if (!/^\d+$/.test(id ?? "") || !emailTime) {
    showMessage("Bad parameters.");
    return;
  }
  const result = await browser.runtime
    .sendMessage({ type: "getActivity", id, notBefore: emailTime + MINUTE })
    .catch(e => ({ error: String(e?.message || e) }));
  if (result?.error) {
    showMessage(`Couldn't load Bugzilla activity: ${result.error}`);
    return;
  }

  const { sets, exact } = matchChangeSets(result.changeSets);
  if (!sets.length) {
    showMessage("No Bugzilla activity found near this email's time.");
  }
  for (const set of sets) {
    document.body.append(renderChangeSet(set, exact));
  }
}

new ResizeObserver(reportHeight).observe(document.documentElement);
render();
