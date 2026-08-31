# Claude Maxer

A Firefox port of the Chrome extension for [claude.ai](https://claude.ai) that shows your live usage limits right in the page, adds a toolbar badge, tracks per-message cost, and can automatically open a fresh session when your usage window resets.

![Claude Maxer banner](assets/banner1.png)

## Features

- **Live usage bar** shows both the 5-hour session window and the 7-day weekly window.
- **Toolbar badge** shows live session usage %, so you can check usage without even opening a tab.
- **Per-message cost** tag appears at the end of the response showing how much session that specific message used (at least 2 messages in the chat needed).
- **Token estimate** shows an approximate GPT-tokenizer-based token count for Claude's most recent reply (an "estimated" count, since claude.ai doesn't expose real token usage to the page).
- **Auto-reset mode** waits for your current session window to end, then opens a fresh incognito Claude tab automatically.
- **Scheduled trigger** fires at a specific time on chosen days instead of waiting for a natural reset.
- **Notifications** for successful triggers and failures.

![Popup settings](assets/popup.png)

## Installation

1. **Download claude-maxer-v1.0.1-firefox.zip**.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select the downloaded zip (or `manifest.json` if you extracted it first).
5. Pin the extension to your toolbar so you can see the usage badge.
6. Open [claude.ai](https://claude.ai). The usage bar should appear automatically.

Temporary add-ons are removed when Firefox restarts, so you'll need to reload it each session unless it's signed and installed permanently through `about:addons`. After updating, also refresh any open claude.ai tabs.

## Note:
No data leaves your browser. Nothing is sent to any server other than claude.ai itself (which your browser was already talking to).

## Credits

Inspired by [Claude Counter](https://github.com/she-llac/claude-counter) by she-llac