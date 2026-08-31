// runs in PAGE context (injected via <script> tag).
// intercepts fetch to read SSE streams AND handle direct API requests from content.js.

(() => {
  'use strict';

  const MARKER = 'ClaudeMaxer';
  const originalFetch = window.fetch;

  // intercept all fetch calls 
  window.fetch = async (...args) => {
    const response = await originalFetch.apply(window, args);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('event-stream')) {
      interceptSSE(response.clone());
    }

    return response;
  };

  // SSE stream parser extracts message_limit events 
  async function interceptSSE(response) {
    try {
      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const json = JSON.parse(raw);
            if (json?.type === 'message_limit' && json.message_limit) {
              post('message_limit', json.message_limit);
            }
            if (json?.type === 'message_start') {
              post('message_start', null);
            }
            if (json?.type === 'message_stop') {
              post('message_stop', null);
            }
          } catch {}
        }
      }
    } catch {}
  }

  // handle requests from content.js via postMessage
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.marker !== MARKER || data.type !== 'request') return;

    const { kind, payload } = data;

    try {
      if (kind === 'usage') {
        const orgId = payload?.orgId;
        const requestId = payload?.requestId;
        if (!orgId) throw new Error('Missing orgId');

        const res = await originalFetch(
          `https://claude.ai/api/organizations/${orgId}/usage`,
          { method: 'GET', credentials: 'include' }
        );
        const json = await res.json();
        post('usage_response', { ...json, requestId });
        return;
      }
    } catch (e) {
        
    }
  });

  function post(type, payload) {
    window.postMessage({ marker: MARKER, type, payload }, '*');
  }
})();