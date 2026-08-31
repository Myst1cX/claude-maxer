// inject bridge.js into page context to intercept fetch
// fetch usage on page load via /usage endpoint (shows bar immediately)
// update bar from SSE message_limit events (real-time updates after messages)
// handle ?autostart=1 to send "hi" and trigger the reset

(() => {
  'use strict';

  const MARKER = 'ClaudeMaxer';
  const DEBUG = false
  const log = (...args) => { if (DEBUG) console.log('ClaudeMaxer', ...args); };

  // inject shared bar stylesheet 
  function injectBarStyles() {
    if (document.getElementById('cm-bar-styles')) return;
    const link = document.createElement('link');
    link.id = 'cm-bar-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/styles/bar.css');
    (document.head || document.documentElement).appendChild(link);
  }

  injectBarStyles();

  // inject bridge into page context 
  function injectBridge() {
    if (document.getElementById('cm-bridge')) return;
    const script = document.createElement('script');
    script.id = 'cm-bridge';
    script.src = chrome.runtime.getURL('src/injected/bridge.js');
    script.onload = () => setTimeout(fetchUsageOnLoad, 300);
    (document.head || document.documentElement).appendChild(script);
  }

  injectBridge();

  // Finds the smallest container that wraps both the chat input and the
  // send button — i.e. the composer's editor+actions row. This is a
  // structural landmark (based on stable data-testid hooks) rather than
  // Anthropic's internal data-cds styling attributes, which have already
  // been renamed once (ChatComposerActions -> ChatComposerDock) and broke
  // the old attribute-based lookup silently.
  function findComposerRowContainer(anchor) {
    const sendBtn = document.querySelector('[data-testid="chat-input-send"]');
    if (!sendBtn) return null;

    let container = anchor.parentElement;
    while (container) {
      if (container.contains(sendBtn)) return container;
      container = container.parentElement;
    }
    return null;
  }

  // Attach bar early with empty state, will populate when data loads
  function attachBarEarly() {
    if (document.getElementById('cm-bar')) return;
    
    const anchor = document.querySelector('[data-testid="chat-input"]');
    if (!anchor) {
      setTimeout(attachBarEarly, 300);
      return;
    }

    const container = findComposerRowContainer(anchor);

    if (!container?.parentElement) {
      setTimeout(attachBarEarly, 300);
      return;
    }

    const bar = createBar();
    container.parentElement.insertBefore(bar, container.nextSibling);
    log('early bar attachment successful');
    
    // Try to load and render cached usage data
    const cachedUsage = getCachedUsage();
    if (cachedUsage) {
      log('rendering cached usage on reload');
      renderBar(cachedUsage);
      window._cmLastUsage = cachedUsage;
    } else {
      // Render with placeholder empty state so labels/tracks show
      function updateSegment(fillId, markerId, metaId) {
        const fill = document.getElementById(fillId);
        const marker = document.getElementById(markerId);
        const meta = document.getElementById(metaId);
        if (fill) fill.style.width = '0%';
        if (marker) marker.style.left = '0%';
        if (meta) meta.textContent = '–';
      }
      updateSegment('cm-session-fill', 'cm-session-marker', 'cm-session-meta');
      updateSegment('cm-weekly-fill', 'cm-weekly-marker', 'cm-weekly-meta');
    }
  }

  setTimeout(attachBarEarly, 600);

  // get org ID from cookie 
  function getOrgIdFromCookie() {
    try {
      return document.cookie
        .split('; ')
        .find(row => row.startsWith('lastActiveOrg='))
        ?.split('=')[1] || null;
    } catch { return null; }
  }

  // ask bridge to hit /usage endpoint
  // returns a requestId so callers can tell which response is "theirs"
  // (bridge.js should echo payload.requestId back on usage_response if present)
  let requestCounter = 0;
  function fetchUsageOnLoad() {
    const orgId = getOrgIdFromCookie();
    log('fetchUsageOnLoad orgId', orgId, 'full cookie string:', document.cookie);
    if (!orgId) return null;
    const requestId = ++requestCounter;
    window.postMessage({ marker: MARKER, type: 'request', kind: 'usage', payload: { orgId, requestId } }, '*');
    return requestId;
  }

  // parse usage from /usage endpoint — utilization 0-100, resets_at ISO string
  function parseUsageFromEndpoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    function parseWindow(w, hours) {
      if (!w || typeof w.utilization !== 'number') return null;
      return {
        utilization: Math.max(0, Math.min(100, w.utilization)),
        resets_at: typeof w.resets_at === 'string' ? new Date(w.resets_at) : null,
        window_hours: hours
      };
    }
    const five_hour = parseWindow(raw.five_hour, 5);
    const seven_day = parseWindow(raw.seven_day, 168);
    if (!five_hour && !seven_day) return null;
    return { five_hour, seven_day };
  }

  // parse usage from SSE — utilization 0-1, resets_at Unix timestamp
  function parseUsageFromSSE(raw) {
    if (!raw?.windows) return null;
    function parseWindow(w, hours) {
      if (!w || typeof w.utilization !== 'number') return null;
      return {
        utilization: Math.max(0, Math.min(100, w.utilization * 100)),
        resets_at: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000) : null,
        window_hours: hours
      };
    }
    const five_hour = parseWindow(raw.windows['5h'], 5);
    const seven_day = parseWindow(raw.windows['7d'], 168);
    if (!five_hour && !seven_day) return null;
    return { five_hour, seven_day };
  }

  let promptBaseline = null; // {utilization, resetsAtMs}
  let captureBaselineFromNextUsageResponse = false;
  let awaitingFinalUsage = false;
  let lastMessageDelta = null;
  let expectedFinalRequestId = null; // set when we fire the post-message_stop fetch

  // track whether a response is currently streaming, so we can avoid refetching /usage mid-generation
  let isGenerating = false;

  // localStorage key for caching usage
  const USAGE_CACHE_KEY = 'cm-usage-cache';

  // Save usage to localStorage
  function cacheUsage(usage) {
    try {
      localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(usage));
    } catch (e) {
      log('failed to cache usage:', e);
    }
  }

  // Load usage from localStorage
  function getCachedUsage() {
    try {
      const cached = localStorage.getItem(USAGE_CACHE_KEY);
      if (cached) {
        const usage = JSON.parse(cached);
        // Convert resets_at strings back to Date objects
        if (usage.five_hour?.resets_at) {
          usage.five_hour.resets_at = new Date(usage.five_hour.resets_at);
        }
        if (usage.seven_day?.resets_at) {
          usage.seven_day.resets_at = new Date(usage.seven_day.resets_at);
        }
        return usage;
      }
    } catch (e) {
      log('failed to get cached usage:', e);
    }
    return null;
  }

  // token estimate — lazy-loaded tokenizer, only parsed once, only if this feature is used
  let tokenizerPromise = null;
  function getTokenizer() {
    if (!tokenizerPromise) {
      tokenizerPromise = import(chrome.runtime.getURL('src/vendor/o200k_base.js')).then(m => m.encode);
    }
    return tokenizerPromise;
  }

  let cmLastMsgTokens = null;

  function formatTokenCount(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function getTitleBarContainer() {
    const titleSplit = document.querySelector('[data-testid="chat-title-split"]');
    return titleSplit ? titleSplit.parentElement?.parentElement : null;
  }

  function renderTokenBadge() {
    const container = getTitleBarContainer();
    if (!container) return;

    let badge = document.getElementById('cm-token-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'cm-token-badge';
      badge.className = 'cm-token-badge';
      container.appendChild(badge);
    }

    if (cmLastMsgTokens === null) return;

    badge.textContent = `~${formatTokenCount(cmLastMsgTokens)} tokens used by last response`;
    badge.title = "Estimated tokens used by last response";
  }

  function getLastResponseText(actionBarEl) {
    const group = actionBarEl.closest('[data-is-streaming]') || actionBarEl.closest('.group');
    if (!group) return '';
    const body = group.querySelector('.font-claude-response');
    return (body || group).textContent || '';
  }

  // retry a few times since the response DOM may still be settling right after message_stop
  function scheduleTokenEstimate(attempt = 0) {
    const bars = document.querySelectorAll('div[data-message-action-bar]');
    const lastBar = bars[bars.length - 1];
    const text = lastBar ? getLastResponseText(lastBar) : '';

    if (!text) {
      if (attempt < 10) setTimeout(() => scheduleTokenEstimate(attempt + 1), 300);
      return;
    }

    estimateAndDisplayTokens(text);
  }

  async function estimateAndDisplayTokens(text) {
    try {
      const encode = await getTokenizer();
      const count = encode(text).length;
      cmLastMsgTokens = count;
      renderTokenBadge();
      log('token estimate', { thisMessage: count }); 
    } catch (e) {
      console.warn('Claude Maxer Token estimate failed:', e);
    }
  }

  // listen for messages from bridge.js 
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.marker !== MARKER) return;

    if (data.type === 'usage_response') {
      const parsed = parseUsageFromEndpoint(data.payload);
      log('usage_response', {
        requestId: data.payload?.requestId,
        expectedFinalRequestId,
        awaitingFinalUsage,
        promptBaseline,
        parsedFiveHour: parsed?.five_hour,
        rawPayload: data.payload
      });
      if (parsed) {
        updateBar(parsed);
        reportUsage(parsed);
        if (captureBaselineFromNextUsageResponse && parsed.five_hour) {
          promptBaseline = {
            utilization: parsed.five_hour.utilization,
            resetsAtMs: parsed.five_hour.resets_at ? parsed.five_hour.resets_at.getTime() : null
          };
          captureBaselineFromNextUsageResponse = false;
          log('captured baseline', promptBaseline);
        }

        const requestId = data.payload?.requestId;
        const isExpectedFinal = expectedFinalRequestId == null || requestId == null || requestId === expectedFinalRequestId;

        if (awaitingFinalUsage && promptBaseline && parsed.five_hour && isExpectedFinal) {
          const finalResetsAtMs = parsed.five_hour.resets_at ? parsed.five_hour.resets_at.getTime() : null;
          const RESET_JITTER_TOLERANCE_MS = 60 * 1000; // 1 minute
          const sameWindow =
            promptBaseline.resetsAtMs != null &&
            finalResetsAtMs != null &&
            Math.abs(promptBaseline.resetsAtMs - finalResetsAtMs) < RESET_JITTER_TOLERANCE_MS;

          if (sameWindow) {
            lastMessageDelta = Math.max(0, parsed.five_hour.utilization - promptBaseline.utilization);
          } else {
            lastMessageDelta = null;
            log('reset window changed mid-message, dropping delta', { baseline: promptBaseline.resetsAtMs, final: finalResetsAtMs });
          }
          awaitingFinalUsage = false;
          expectedFinalRequestId = null;
          promptBaseline = null;
          log('computed delta', lastMessageDelta);
          scheduleAppendDelta();
        } else if (awaitingFinalUsage && !isExpectedFinal) {
          log('ignoring stale usage_response while awaiting final', { requestId, expectedFinalRequestId });
        }
      }
    }

    if (data.type === 'message_start') {
      log('message_start');
      isGenerating = true;
      awaitingFinalUsage = false;
      expectedFinalRequestId = null;
      lastMessageDelta = null;

      if (window._cmLastUsage?.five_hour) {
        promptBaseline = {
          utilization: window._cmLastUsage.five_hour.utilization,
          resetsAtMs: window._cmLastUsage.five_hour.resets_at ? window._cmLastUsage.five_hour.resets_at.getTime() : null
        };
        captureBaselineFromNextUsageResponse = false;
        log('baseline from cache', promptBaseline);
      } else {
        promptBaseline = null;
        captureBaselineFromNextUsageResponse = true;
        log('no cached usage yet, will capture baseline from next response');
      }

      fetchUsageOnLoad();
    }

    if (data.type === 'message_stop') {
      log('message_stop');
      isGenerating = false;
      awaitingFinalUsage = true;
      scheduleTokenEstimate();
      // SSE utilization can lag slightly behind the endpoint's figure
      setTimeout(() => {
        expectedFinalRequestId = fetchUsageOnLoad();
        log('fired final usage fetch', expectedFinalRequestId);
      }, 1000);
    }

    if (data.type === 'message_limit') {
      const parsed = parseUsageFromSSE(data.payload);
      log('message_limit (SSE)', parsed?.five_hour);
      if (parsed) {
        updateBar(parsed);
        reportUsage(parsed);
      }
    }
  });

  // retry a few times since data-is-streaming may flip false slightly after message_stop fires
  function scheduleAppendDelta(attempt = 0) {
    if (appendDeltaToLastResponse()) return;
    if (attempt < 10) setTimeout(() => scheduleAppendDelta(attempt + 1), 300);
  }

  function appendDeltaToLastResponse() {
    if (lastMessageDelta === null) return false;

    const text = lastMessageDelta < 0.1 ? '<0.1%' : `${lastMessageDelta.toFixed(1)}%`;

    const bars = document.querySelectorAll('div[data-message-action-bar]');
    if (!bars.length) {
      log('appendDeltaToLastResponse: no action bar found in DOM yet');
      return false;
    }
    const last = bars[bars.length - 1];
    if (last.querySelector('.cm-msg-cost')) return true;

    const el = document.createElement('span');
    el.className = 'cm-msg-cost';
    el.textContent = `+${text} session`;
    last.appendChild(el);
    log('appended delta to action bar', text);
    return true;
  }

  // send normalized usage to background, same shape regardless of source
  function reportUsage(parsed) {
    chrome.runtime.sendMessage({
      type: 'USAGE_UPDATE',
      payload: {
        five_hour: parsed.five_hour ? {
          utilization: parsed.five_hour.utilization,
          resets_at: parsed.five_hour.resets_at ? parsed.five_hour.resets_at.getTime() : null
        } : null,
        seven_day: parsed.seven_day ? {
          utilization: parsed.seven_day.utilization,
          resets_at: parsed.seven_day.resets_at ? parsed.seven_day.resets_at.getTime() : null
        } : null
      }
    });
  }

  // format time remaining 
  function formatTimeRemaining(date) {
    if (!date) return null;
    const ms = date - Date.now();
    if (ms <= 0) return 'now';
    const totalMins = Math.floor(ms / 60000);
    const days  = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins  = totalMins % 60;
    if (days > 0)  return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  // compute where we are inside the usage window (0-100)
  function getWindowProgressPct(w) {
    if (!w?.resets_at || typeof w.window_hours !== 'number' || w.window_hours <= 0) {
      return null;
    }

    const totalMs = w.window_hours * 60 * 60 * 1000;
    const remainingMs = w.resets_at - Date.now();
    const elapsedPct = 100 - (remainingMs / totalMs) * 100;
    return Math.max(0, Math.min(100, elapsedPct));
  }

  // create bar element 
  function createBar() {
    const el = document.createElement('div');
    el.id = 'cm-bar';
    el.innerHTML = `
      <div class="cm-segment">
        <span class="cm-label">Session</span>
        <span class="cm-trackwrap">
          <span class="cm-track"><span class="cm-fill" id="cm-session-fill"></span></span>
          <span class="cm-marker" id="cm-session-marker"></span>
        </span>
        <span class="cm-meta" id="cm-session-meta"></span>
      </div>
      <div class="cm-divider"></div>
      <div class="cm-segment">
        <span class="cm-label">Weekly</span>
        <span class="cm-trackwrap">
          <span class="cm-track"><span class="cm-fill" id="cm-weekly-fill"></span></span>
          <span class="cm-marker" id="cm-weekly-marker"></span>
        </span>
        <span class="cm-meta" id="cm-weekly-meta"></span>
      </div>
    `;
    return el;
  }

  // attach bar below the composer input
  function attachBar() {
    if (document.getElementById('cm-bar')) return;

    const anchor = document.querySelector('[data-testid="chat-input"]');
    if (!anchor) {
      log('attachBar: chat-input not found');
      return;
    }

    const container = findComposerRowContainer(anchor);

    if (!container || !container.parentElement) {
      log('attachBar: could not find suitable container');
      return;
    }

    const bar = createBar();
    container.parentElement.insertBefore(bar, container.nextSibling);
    log('attachBar: bar inserted successfully');

    // Render bar immediately with cached data if available
    if (window._cmLastUsage) {
      renderBar(window._cmLastUsage);
    }

    if (!window._cmTick) {
      window._cmTick = setInterval(() => {
        if (window._cmLastUsage) renderBar(window._cmLastUsage);
      }, 30000);
    }
  }

  // render usage into bar
  function renderBar(usage) {
    function updateSegment(fillId, markerId, metaId, w) {
      if (!w) return;
      const fill   = document.getElementById(fillId);
      const marker = document.getElementById(markerId);
      const meta   = document.getElementById(metaId);
      if (!fill || !meta) return;

      const pct = Math.min(100, w.utilization);
      fill.style.width = pct + '%';
      fill.className = 'cm-fill' +
        (pct >= 90 ? ' cm-critical' : pct >= 70 ? ' cm-warn' : '');

      const markerPct = getWindowProgressPct(w);
      if (marker) marker.style.left = (markerPct ?? pct) + '%';

      const timeStr = formatTimeRemaining(w.resets_at);
      meta.textContent = timeStr
        ? `${Math.round(pct)}% · resets in ${timeStr}`
        : `${Math.round(pct)}%`;
    }

    updateSegment('cm-session-fill', 'cm-session-marker', 'cm-session-meta', usage.five_hour);
    updateSegment('cm-weekly-fill',  'cm-weekly-marker',  'cm-weekly-meta',  usage.seven_day);
  }

  // update bar (attach if needed, then render)
  function updateBar(usage) {
    window._cmLastUsage = usage;
    cacheUsage(usage);  // Save to localStorage
    attachBar();
    renderBar(usage);
  }

  // re-attach on SPA navigation 
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;

      cmLastMsgTokens = null;
      document.getElementById('cm-token-badge')?.remove();

      setTimeout(() => {
        if (!isGenerating || !window._cmLastUsage) fetchUsageOnLoad(); // always fetch if we have nothing cached yet
        if (window._cmLastUsage) setTimeout(() => { attachBar(); renderBar(window._cmLastUsage); }, 500);
      }, 1500);
    }
    if (!document.getElementById('cm-bar') && window._cmLastUsage) {
      const anchor = document.querySelector('[data-testid="model-selector-dropdown"]');
      if (anchor) { attachBar(); renderBar(window._cmLastUsage); }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // autostart: send "hi" to trigger reset 
  if (!window.location.search.includes('autostart=1')) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function findEditor() {
    return (
      document.querySelector("[data-testid='chat-input']") ||
      document.querySelector('.tiptap.ProseMirror') ||
      document.querySelector("div[contenteditable='true']")
    );
  }

  function findSendButton() {
    return document.querySelector("button[aria-label='Send message']");
  }

  (async () => {
    let elapsed = 0;
    while (elapsed < 20000) {
      await sleep(500);
      elapsed += 500;
      const editor = findEditor();
      if (!editor) continue;
      await sleep(1500);
      editor.focus();
      editor.click();
      await sleep(200);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, 'hi');
      await sleep(300);
      const sendBtn = findSendButton();
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
        }));
      }
      chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
      break;
    }
    if (elapsed >= 20000) {
      chrome.runtime.sendMessage({ type: 'SEND_FAILED', reason: 'Editor not found.' });
    }
  })();
})();