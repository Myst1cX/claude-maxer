// Check for updates every time popup opens
chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }, (response) => {
  if (response?.ok) {
    console.log('Update check triggered on popup open');
  }
});

const toggleAuto     = document.getElementById('toggleAuto');
const toggleSchedule = document.getElementById('toggleSchedule');
const scheduleBody   = document.getElementById('scheduleBody');
const triggerTimeEl  = document.getElementById('triggerTime');
const sectionAuto    = document.getElementById('sectionAuto');
const sectionSched   = document.getElementById('sectionSchedule');
const btnSave        = document.getElementById('btnSave');
const btnCancel      = document.getElementById('btnCancel');
const statusEl       = document.getElementById('status');
const statusDot      = document.getElementById('statusDot');
const nextTriggerEl  = document.getElementById('nextTrigger');
const lastTriggeredEl = document.getElementById('lastTriggered');
const btnUpdate = document.getElementById('btnUpdate');
const REPO_URL = 'https://github.com/ali5917/claude-maxer';

// day picker 
const dayBtns = document.querySelectorAll('.day-btn');
dayBtns.forEach(btn => {
  btn.addEventListener('click', () => btn.classList.toggle('selected'));
});

function getSelectedDays() {
  return Array.from(dayBtns)
    .filter(b => b.classList.contains('selected'))
    .map(b => parseInt(b.dataset.day));
}

function setSelectedDays(days) {
  dayBtns.forEach(btn => {
    btn.classList.toggle('selected', days.includes(parseInt(btn.dataset.day)));
  });
}

// toggle visibility 
toggleSchedule.addEventListener('change', () => {
  scheduleBody.classList.toggle('visible', toggleSchedule.checked);
  sectionSched.classList.toggle('enabled', toggleSchedule.checked);
});

toggleAuto.addEventListener('change', () => {
  sectionAuto.classList.toggle('enabled', toggleAuto.checked);
});

// helpers 
function calcNextFireTime(timeStr, selectedDays) {
  const [hours, mins] = timeStr.split(':').map(Number);
  const now = new Date();
  const today = now.getDay(); // 0=Sun, 1=Mon...

  // Find the next selected day including today
  for (let i = 0; i < 7; i++) {
    const day = (today + i) % 7;
    if (!selectedDays.includes(day)) continue;

    const candidate = new Date();
    candidate.setDate(now.getDate() + i);
    candidate.setHours(hours, mins, 0, 0);

    // If it's today but time already passed, skip
    if (i === 0 && candidate <= now) continue;

    return candidate.getTime();
  }
  return null;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

function formatDateTime(dateMs) {
  return new Date(dateMs).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function calcAutoResetFireTime(usageData) {
  const resetAt = usageData?.five_hour?.resets_at;
  if (!resetAt) return null;
  return resetAt + 10000;
}

function updateNextTrigger(data) {
  const scheduledFireAt = data.scheduledTrigger?.enabled
    ? calcNextFireTime(data.scheduledTrigger.time, data.scheduledTrigger.days || [])
    : null;
  const autoResetFireAt = data.autoReset?.enabled
    ? calcAutoResetFireTime(data.usageData)
    : null;

  if (scheduledFireAt != null && autoResetFireAt != null) {
    const fireAt = Math.min(scheduledFireAt, autoResetFireAt);
    nextTriggerEl.textContent = `Next trigger at: ${formatDateTime(fireAt)}`;
    return;
  }

  if (scheduledFireAt != null) {
    nextTriggerEl.textContent = `Next trigger at: ${formatDateTime(scheduledFireAt)}`;
    return;
  }

  if (autoResetFireAt != null) {
    nextTriggerEl.textContent = `Next trigger at: ${formatDateTime(autoResetFireAt)}`;
    return;
  }

  if (data.scheduledTrigger?.enabled) {
    nextTriggerEl.textContent = 'Next trigger at: no upcoming scheduled time';
    return;
  }

  if (data.autoReset?.enabled) {
    nextTriggerEl.textContent = 'Next trigger at: open Claude once to initialize auto-reset';
    return;
  }

  nextTriggerEl.textContent = 'Choose an option to set a trigger.';
}

function updateDot() {
  const active = toggleAuto.checked || toggleSchedule.checked;
  statusDot.classList.toggle('active', active);
}

// load saved state
chrome.storage.sync.get(['autoReset', 'scheduledTrigger', 'lastTriggeredAt', 'usageData'], (data) => {
  if (data.autoReset?.enabled) {
    toggleAuto.checked = true;
    sectionAuto.classList.add('enabled');
  }

  if (data.scheduledTrigger?.enabled) {
    toggleSchedule.checked = true;
    scheduleBody.classList.add('visible');
    sectionSched.classList.add('enabled');
    if (data.scheduledTrigger.time) triggerTimeEl.value = data.scheduledTrigger.time;
    if (data.scheduledTrigger.days) setSelectedDays(data.scheduledTrigger.days);
  }

  if (data.lastTriggeredAt) {
    const d = new Date(data.lastTriggeredAt);
    lastTriggeredEl.textContent = `Last triggered: ${d.toLocaleString()}`;
  }

  updateNextTrigger(data);

  updateDot();
});

// save 
btnSave.addEventListener('click', () => {
  const autoEnabled     = toggleAuto.checked;
  const schedEnabled    = toggleSchedule.checked;
  const timeStr         = triggerTimeEl.value;
  const days            = getSelectedDays();

  if (schedEnabled && (!timeStr || days.length === 0)) {
    setStatus('Pick a time and at least one day.', true);
    return;
  }

  // save auto-reset preference
  chrome.storage.sync.set({ autoReset: { enabled: autoEnabled } });

  // handle scheduled alarm
  if (schedEnabled) {
    const fireAt = calcNextFireTime(timeStr, days);
    if (!fireAt) {
      setStatus('No upcoming day matches your selection.', true);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'SET_ALARM',
      fireAt,
      daily: true,
      time: timeStr,
      days
    }, () => {
      const d = new Date(fireAt);
      const timeDisplay = d.toLocaleString([], {
        weekday: 'short', hour: '2-digit', minute: '2-digit'
      });
      setStatus(`Saved — next trigger ${timeDisplay}`);
      updateNextTrigger({
        autoReset: { enabled: autoEnabled },
        scheduledTrigger: { enabled: true, time: timeStr, days },
        usageData: null
      });
    });
  } else {
    chrome.runtime.sendMessage({ type: 'CANCEL_ALARM' }, () => {});
    setStatus('Saved!');
    updateNextTrigger({
      autoReset: { enabled: autoEnabled },
      scheduledTrigger: null,
      usageData: null
    });
  }

  updateDot();
});

// cancel
btnCancel.addEventListener('click', () => {
  toggleAuto.checked     = false;
  toggleSchedule.checked = false;
  scheduleBody.classList.remove('visible');
  sectionAuto.classList.remove('enabled');
  sectionSched.classList.remove('enabled');

  chrome.storage.local.set({ autoReset: { enabled: false } });
  chrome.runtime.sendMessage({ type: 'CANCEL_ALARM' }, () => {});
  setStatus('Cancelled.', true);
  nextTriggerEl.textContent = 'Next trigger at: not set';
  updateDot();
});

// update button
chrome.storage.sync.get('updateInfo', ({ updateInfo }) => {
  if (updateInfo?.updateAvailable) {
    btnUpdate.textContent = `Get Newer Release (v${updateInfo.latestVersion})`;
    btnUpdate.classList.add('update-available');
  }
});

btnUpdate.addEventListener('click', () => {
  chrome.storage.sync.get('updateInfo', ({ updateInfo }) => {
    const url = updateInfo?.updateAvailable
      ? 'https://github.com/ali5917/claude-maxer/archive/refs/heads/main.zip'
      : 'https://github.com/ali5917/claude-maxer';
    chrome.tabs.create({ url });
  });
});