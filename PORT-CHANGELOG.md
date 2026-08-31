# Claude Maxer — Firefox Port Changelog

Every change made to `claude-maxer-main` (Chrome) to produce `claude-maxer-v1.0.1-firefox.zip`, in the order they happened.

## 1. Manifest — Firefox-required keys

**File:** `manifest.json`

- Added `browser_specific_settings.gecko`:
  - `id: "claude-maxer@extension"` — Firefox requires an explicit addon ID to install from a file; without it Firefox reports the package as corrupt.
  - `strict_min_version: "142.0"` — required floor when using `data_collection_permissions`.
  - `data_collection_permissions: { required: ["none"], optional: [] }` — required by Firefox 142+; set to `"none"` since the extension only talks to claude.ai/GitHub raw and stores data locally.

## 2. Zip structure

Re-zipped so `manifest.json` sits at the archive root (the original upload had everything nested under `claude-maxer-main/`, which Firefox rejects).

## 3. Background script: `service_worker` → `scripts`

**Files:** `manifest.json`, `src/background/background.js`

- Firefox's stable release doesn't support `background.service_worker` in MV3 — it errors with *"background.service_worker is currently disabled."* Switched to `background.scripts`, which runs as a classic (non-module) background page.
- `background.js` used `importScripts('../utils/scheduler.js', '../utils/notifications.js')` to pull in its dependencies. `importScripts` is a Worker-only API and doesn't exist in a Firefox background page context — this crashed the whole background script on load (`ReferenceError: importScripts is not defined`).
- Fix: removed the `importScripts` call and instead listed all three files directly in `manifest.json`'s `background.scripts` array, in load order:
  ```json
  "background": {
    "scripts": [
      "src/utils/scheduler.js",
      "src/utils/notifications.js",
      "src/background/background.js"
    ]
  }
  ```
  Firefox loads them into the same global scope in sequence, which works because both util files use plain global `function` declarations (no ES module syntax).
- This crash was also the root cause of `Error: Could not establish connection. Receiving end does not exist.` seen in the page console — content.js was trying to message a background script that had never finished loading.

## 4. Android popup viewport

**File:** `src/popup/popup.html`

Added a viewport meta tag — without it, Firefox for Android lays the popup out at a wide desktop-style viewport and scales it down, making it look tiny and stuck in the top-left corner.

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

## 5. Branding text (Chrome → Firefox)

**Files:** `src/popup/popup.html`, `README.md`

- `popup.html`: "Keep Chrome running for the trigger 😉" → "Keep Firefox running for the trigger 😉"
- `README.md`: rewrote the intro line to "A Firefox port of the Chrome extension for claude.ai...", and swapped the install instructions from Chrome's `chrome://extensions` / Load unpacked flow to Firefox's `about:debugging#/runtime/this-firefox` / Load Temporary Add-on flow, with a note that temporary add-ons don't persist across browser restarts unless signed.

## 6. `bridge.js` — requestId not echoed back

**File:** `src/injected/bridge.js`

Found while debugging: `content.js` sends a `requestId` when asking the bridge to fetch `/usage`, and its own code comment says the bridge should echo it back on the response — but `bridge.js` never did. This meant `requestId` always logged as `undefined`, breaking the logic that matches a "final" usage fetch (after `message_stop`) to the request that triggered it, which is used to compute per-message token/usage delta.

Fix: bridge now spreads the `requestId` into the response payload:
```js
post('usage_response', { ...json, requestId });
```

## 7. Stale DOM selector — `ChatComposerActions` → `ChatComposerDock` (later superseded, see step 9)

**File:** `src/content/content.js` (two occurrences: `attachBarEarly` and `attachBar`)

The bar-injection logic walks up from the chat input looking for a container that also contains `[data-cds="ChatComposerActions"]`. claude.ai no longer has any element with that `data-cds` value — confirmed by running this in the console to dump every `data-cds` attribute on the page:

```js
[...document.querySelectorAll('[data-cds]')].map(el => el.getAttribute('data-cds'))
```

This showed `ChatComposerDock` and `ChatComposerNotices` instead. This silently failed forever (`attachBar: could not find suitable container`) with the bar never appearing, and no error thrown.

Fix: both occurrences updated to look for `[data-cds="ChatComposerDock"]` instead. **Not Firefox-specific** — this was a claude.ai frontend change the extension hadn't caught up to; it would have silently failed in Chrome too.

## 8. Debug logging (temporary, used to diagnose, reverted before final build)

**File:** `src/content/content.js`

- Temporarily flipped `DEBUG` from `false` to `true` to get `ClaudeMaxer`-prefixed console logs while diagnosing the above issues.
- Temporarily added `rawPayload: data.payload` to the `usage_response` log to inspect the actual `/usage` API response shape.
- Temporarily added an `orgId` + full cookie string log in `fetchUsageOnLoad()` to check whether the `lastActiveOrg` cookie matched claude.ai's real org ID (this line was never conclusively needed once the DOM selector fix alone resolved the visible symptoms — worth revisiting if the bar's numbers ever look wrong).
- `DEBUG` reverted back to `false` for the current release build. The extra `rawPayload` field is harmless to leave in since it's gated behind the `DEBUG` flag and silent by default.

## 9. Bar insertion point — replaced `ChatComposerDock` lookup with a structural anchor (supersedes step 7)

**File:** `src/content/content.js`

The container-finding loop in step 7 fixed the *detection* of the composer wrapper, but changed *where* the bar landed: the old `ChatComposerActions` attribute used to live directly on the actions row itself (`<div class="relative flex items-center w-full gap-2">`), so walking up from the chat input to the smallest ancestor containing that marker landed right above the editor+actions row — a tight, well-placed insertion point. `ChatComposerDock`, its replacement, instead lives on the *outermost* composer wrapper, so the same walk-up logic now climbs past it entirely and inserts the bar much higher in the tree than before.

Rather than patch in yet another `data-cds` value (which has already been renamed once and could change again), replaced the lookup with a structural landmark that doesn't depend on Anthropic's internal styling attributes: the smallest common ancestor of the chat input (`[data-testid="chat-input"]`) and the send button (`[data-testid="chat-input-send"]`). That ancestor is exactly the editor+actions row wrapper the bar used to sit below, and both `data-testid` hooks are much more likely to stay stable than a styling-library attribute.

Added a shared helper, `findComposerRowContainer(anchor)`, and pointed both `attachBarEarly()` and `attachBar()` at it instead of their separate `data-cds`-based walk-up loops.

## Known follow-up (not yet done)

None outstanding as of this writing.

## Modified files

Only these 6 files changed from the original `claude-maxer-main` — nothing added or removed. Paths are repo-relative, so you can drop each one straight into a fork.

| File | Suggested commit message |
|---|---|
| `manifest.json` | Add Firefox gecko settings; switch background to scripts (MV3 service_worker unsupported) |
| `README.md` | Update install instructions and branding for Firefox |
| `src/background/background.js` | Remove importScripts (Worker-only API, unavailable in Firefox background page) |
| `src/content/content.js` | Fix composer bar insertion point using stable data-testid anchors instead of renamed data-cds attribute |
| `src/injected/bridge.js` | Echo requestId back on usage_response so final-usage delta tracking works |
| `src/popup/popup.html` | Add viewport meta tag for Firefox Android; update Chrome reference to Firefox |

Squashed alternative, if preferred as a single commit:
`Port extension to Firefox: MV3 background fix, stale selector fix, requestId bug fix, Android viewport fix`
