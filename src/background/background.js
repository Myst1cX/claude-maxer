// handles alarms, opens Claude tab, routes messages, manages auto-reset.
// scheduler.js and notifications.js are loaded before this file via manifest.json's
// background.scripts array (Firefox's background page doesn't support importScripts,
// which is a Worker-only API).

const CLAUDE_URL = 'https://claude.ai/new?incognito=1&autostart=1';
const GITHUB_REPO = 'ali5917/claude-maxer';
const GITHUB_BRANCH = 'main';
const MANIFEST_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/manifest.json`;

// alarm fired 
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    const tab = await chrome.tabs.create({ url: CLAUDE_URL, active: false });
    await chrome.storage.sync.set({
      activeTabId: tab.id,
      lastTriggeredAt: Date.now()
    });
  } catch (err) {
    notifyFailed('Could not open Claude tab.');
    return;
  }

  // reschedule for next matching day
  const data = await chrome.storage.sync.get('scheduledTrigger');
  if (data.scheduledTrigger?.enabled) {
    const { time, days } = data.scheduledTrigger;
    const nextFireAt = calcNextFireTimeFromSchedule(time, days);
    if (nextFireAt) chrome.alarms.create(ALARM_NAME, { when: nextFireAt });
  }
});

// messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SET_ALARM') {
    chrome.alarms.clear(ALARM_NAME, () => {
      chrome.alarms.create(ALARM_NAME, { when: msg.fireAt });
      chrome.storage.sync.set({
        scheduledTrigger: {
          enabled: true,
          time: msg.time,
          days: msg.days
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'CANCEL_ALARM') {
    chrome.alarms.clear(ALARM_NAME, () => {
      chrome.storage.sync.remove('scheduledTrigger');
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'USAGE_UPDATE') {
    chrome.storage.sync.set({ usageData: msg.payload, usageUpdatedAt: Date.now() });

    // check auto-reset: if window is about to end, schedule a trigger
    handleAutoReset(msg.payload);

    updateBadge(msg.payload);
  }

  if (msg.type === 'CLOSE_TAB') {
    notifyTriggered();
    setTimeout(() => chrome.tabs.remove(sender.tab.id), 8000);
  }

  if (msg.type === 'SEND_FAILED') {
    notifyFailed(msg.reason);
    setTimeout(() => chrome.tabs.remove(sender.tab.id), 2000);
  }

  if (msg.type === 'CHECK_UPDATE') {
    checkForUpdate();
    sendResponse({ ok: true });
    return true;
  }
});

// live session % on the extension icon in the toolbar
function updateBadge(payload) {
  const w = payload?.five_hour;
  if (!w || typeof w.utilization !== 'number') return;

  const pct = Math.round(w.utilization);
  chrome.action.setBadgeText({ text: `${pct}` });
  chrome.action.setBadgeBackgroundColor({
    color: pct >= 90 ? '#e85a4a' : pct >= 70 ? '#e8a06a' : '#5a9fd4'
  });
}

async function checkForUpdate() {
  try {
    const res = await fetch(MANIFEST_RAW_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const remoteManifest = await res.json();
    const latestVersion = remoteManifest?.version;
    const currentVersion = chrome.runtime.getManifest().version;

    await chrome.storage.sync.set({
      updateInfo: {
        updateAvailable: !!latestVersion && latestVersion !== currentVersion,
        latestVersion: latestVersion || null,
        checkedAt: Date.now()
      }
    });
  } catch (e) {
    // network failure — silently skip, next scheduled check retries
  }
}

// auto-reset logic 
// when content.js reports usage, check if auto-reset is on and window is ending.
// we schedule a one-shot alarm to fire right at resets_at.
let autoResetScheduledFor = null; // track what we already scheduled to avoid dupes

async function handleAutoReset(payload) {
  const data = await chrome.storage.sync.get('autoReset');
  if (!data.autoReset?.enabled) return;

  // Parse resets_at from normalized payload (already epoch ms)
  const fiveHourWindow = payload?.five_hour;
  if (!fiveHourWindow?.resets_at) return;

  const resetsAtMs = fiveHourWindow.resets_at;

  // don't reschedule if we already have this reset time queued
  if (autoResetScheduledFor === resetsAtMs) return;
  autoResetScheduledFor = resetsAtMs;

  // fire 10 seconds after the window resets
  const fireAt = resetsAtMs + 10000;
  if (fireAt <= Date.now()) return; // already passed

  // use a separate alarm name so it doesn't conflict with scheduled trigger
  chrome.alarms.create('claude-maxer-autoreset', { when: fireAt });
}

// handle the auto-reset alarm separately
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'claude-maxer-autoreset') return;

  const data = await chrome.storage.sync.get('autoReset');
  if (!data.autoReset?.enabled) return;

  try {
    const tab = await chrome.tabs.create({ url: CLAUDE_URL, active: false });
    await chrome.storage.sync.set({
      activeTabId: tab.id,
      lastTriggeredAt: Date.now()
    });
  } catch (err) {
    notifyFailed('Auto-reset failed to open Claude tab.');
  }
});

// calc next fire time from schedule
function calcNextFireTimeFromSchedule(timeStr, days) {
  if (!timeStr || !days?.length) return null;
  const [hours, mins] = timeStr.split(':').map(Number);
  const now = new Date();
  const today = now.getDay();

  for (let i = 1; i <= 7; i++) {
    const day = (today + i) % 7;
    if (!days.includes(day)) continue;
    const candidate = new Date();
    candidate.setDate(now.getDate() + i);
    candidate.setHours(hours, mins, 0, 0);
    return candidate.getTime();
  }
  return null;
}