# Peekabug

A Firefox extension for Mozilla staff who read bugmail in Gmail: real titles and
activity for secure Bugzilla bugs and Phabricator revisions.

Bugzilla and Phabricator hide the details of secure bugs in email unless you
have set up PGP or S/MIME, which Gmail can't decrypt. Subjects arrive as
`[Bug 123] (Secure bug 123 in Core :: DOM)` or `D456: (secure bug 123)`, and
bodies say "This email would have contained sensitive information…".

This extension uses your existing logged-in Bugzilla and Phabricator sessions
to show, inside Gmail:

- **Subjects:** the real bug summary or revision title, marked with 🔒.
- **Bodies:** the field changes and comments that sent the email, matched by
  the email's time. The original text is kept in a collapsed
  "Original message" section.

## Files

| File | Runs in | Purpose |
|---|---|---|
| `manifest.json` | | Manifest V3, Firefox 140+ |
| `background.js` | Extension background | The only code that makes network requests |
| `content.js` | Gmail's page (isolated content script world) | Finds secure subjects and bodies, draws subjects, inserts body frames |
| `view.html`, `view.js` | Extension iframe inside Gmail | Draws a body's matching bug activity |
| `options.html`, `options.js` | Extension options page | Optional Bugzilla API key, clear caches |

There are no runtime dependencies and no build step. The files above, plus
`LICENSE`, are what ships.

## Installing

Download the latest `peekabug-vX.Y.xpi` from
[Releases](https://github.com/mkaply/peekabug/releases) and open it in
Firefox. It's signed by Mozilla as an unlisted add-on and updates itself from
`updates.json` in this repository.

## Development

```sh
npm install      # dev tools only: eslint, jsdom (tests), web-ext
npm test         # unit tests (offline, mocked network and browser APIs)
npm run lint     # eslint + web-ext lint
npx web-ext run  # launch Firefox with the extension loaded
npm run build    # package into web-ext-artifacts/
```

## Releasing

Bump `version` in `manifest.json` and push to `main`.
`.github/workflows/release.yml` then:

1. Runs the tests and lint.
2. Signs the extension on AMO as unlisted, using the `AMO_JWT_ISSUER` and
   `AMO_JWT_SECRET` repository secrets.
3. Creates a GitHub release `vX.Y` with `peekabug-vX.Y.xpi` attached.
4. Commits `updates.json` pointing at that release, which installed copies
   check through the manifest's `update_url`.

It can also be run by hand from the Actions tab. `.github/workflows/ci.yml`
runs the tests and lint on every push and pull request.

## Security model

The goal is that secure bug data is never visible to Google: neither sent to
Google's servers nor readable by Gmail's scripts in the page.

### Data flow

```
bugzilla.mozilla.org ─┐
                      ├─ background.js ─┬─ titles ───────► content.js ─► closed shadow roots in Gmail's page
phabricator.services ─┘                 └─ activity ─────► view.html (iframe, cross-origin to Gmail)
   .mozilla.com
```

- **Network:** only `background.js` makes requests, and only to
  `https://bugzilla.mozilla.org` and `https://phabricator.services.mozilla.com`.
  They use the browser's session cookies (`credentials: "include"`), or with
  an API key configured, the Bugzilla REST API with the key in the
  `X-BUGZILLA-API-KEY` header and no cookies. All requests are read-only GETs.
- **Subjects:** the real title is drawn into a *closed* shadow root attached to
  Gmail's subject element. Gmail's own child nodes stay in place but
  unslotted, so Gmail's DOM (`textContent`, `innerHTML`, etc.) still reads the
  original placeholder, and `element.shadowRoot` is `null` for page scripts.
- **Bodies:** comments and field changes are only ever sent to `view.html`,
  which is loaded from `moz-extension://<random-uuid>/` and is therefore
  cross-origin to `https://mail.google.com`. Gmail's scripts can't read its
  document. The background script refuses to send activity to anything else,
  including `content.js`.
- **Frame sizing:** `view.html` reports its height through extension messaging
  (relayed by the background script), not `window.postMessage`, so Gmail
  doesn't see even that.
- **Tab title:** not changed, because `document.title` is readable by Gmail
  and is saved in browser history.

### Message handling (`background.js`)

| Message | Accepted from | Returns |
|---|---|---|
| `getBugTitle`, `getRevisionTitle` | any extension context (content script, extension pages) | `{ title }` or `{ error }` |
| `getActivity` | `view.html` only | change sets |
| `frameHeight` | `view.html` only | relayed to the top frame of the sender's tab |
| `clearCache` | `options.html` only | number of cleared entries |

IDs must be decimal strings. The manifest doesn't declare
`externally_connectable`, so web pages (including Gmail) can't send these
messages.

Error messages shown to the user (as a tooltip on the subject, which is in
Gmail's DOM) are built only from fixed strings, HTTP status codes and Bugzilla
error codes. They never include fetched page content, so they can't leak a
title.

### Storage

- **Titles:** `storage.session` (held in memory, cleared when Firefox
  restarts); 24 hours for successes, 2 minutes for errors.
- **Activity:** in the background script's memory only; 5 minutes.
- **API key (optional):** `storage.local`, in plain text in the Firefox
  profile, as is usual for extension settings. It's sent only to
  bugzilla.mozilla.org.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Session title cache; optional API key |
| `https://mail.google.com/*` | Content script; framing `view.html` |
| `https://bugzilla.mozilla.org/*` | Fetching bug summaries and activity with the user's session |
| `https://phabricator.services.mozilla.com/*` | Fetching revision titles with the user's session |

`view.html` is web-accessible to `https://mail.google.com/*` only, so it can
be framed there.

### Known limitations

- **Closed shadow roots are weaker than an origin boundary.** They stop
  ordinary page scripts reading the subject, but they're not a security
  boundary in the way the cross-origin iframe is. The most sensitive content,
  comment text, is only in the iframe.
- **What Gmail can see about the frames.** That a frame exists, and its URL:
  the bug number, the email's time, Gmail's text color and a random token.
  Gmail already knows the bug number and time.
- **Anything the user does with the text.** Copying it, quoting it in a reply,
  screenshots and assistive technology all see what's on screen.
- **Any sender can trigger lookups.** An email with a `(Secure bug N)` subject
  or the secure-body text makes the extension fetch bug N with the user's
  session. The results are shown only to the user (as above), and the
  requests are read-only, but a sender can cause them.
- **It depends on Gmail's markup.** It finds subjects by their text, message
  bodies by Gmail's `.a3s` class (with a fallback), and the email's time by
  Gmail's date tooltip (US and day-first English formats only). If Gmail
  changes, the extension may stop working, but it won't move data elsewhere.
- **Body matching is a heuristic.** It shows changes made in the 3 minutes
  before the email arrived (Gmail gives only the minute), or the closest
  earlier change within an hour, labelled as such.

### Tests

`npm test` runs 38 offline tests (`test/`) using jsdom with mocked `browser`
and `fetch`, including checks that:

- Gmail's DOM never contains a real title, and `shadowRoot` is `null` to it.
- The content script never receives bug activity.
- Activity, frame heights and cache clearing are refused from the wrong sender.
- Error messages don't echo fetched page content.
- Comment text is rendered as text, never HTML.
- Titles are cached only in session storage.

These checks are not automated:

- Behaviour in real Gmail (it has been used there by hand).
- Skipping text in editable areas, because jsdom doesn't implement
  `isContentEditable`.
