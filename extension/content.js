// Content script for auto-capturing chat conversations

(function () {
  'use strict';

  if (window.__frictionContentLoaded) return;
  window.__frictionContentLoaded = true;

  console.log('[Friction] Content script loaded');

  function detectSite() {
    const url = window.location.href;
    if (url.includes('chat.openai.com') || url.includes('chatgpt.com')) return 'chatgpt';
    if (url.includes('gemini.google.com')) return 'gemini';
    return null;
  }

  const API_BASE = globalThis.FRICTION_CONFIG?.API_BASE;
  if (!API_BASE) {
    console.error('[Friction] Config not available');
    return;
  }

  function getSiteConfig(site) {
    return {
      chatgpt: {
        conversation: '[data-testid="conversation-root"]',
        message: '[data-testid="conversation-message"]'
      },
      gemini: {
        conversation: '[data-testid="conversation"]',
        message: '[data-testid="message"]'
      }
    }[site];
  }

  function extractConversationText(site, config) {
    const convEl = document.querySelector(config.conversation);
    if (!convEl) return null;

    const msgEls = convEl.querySelectorAll(config.message);
    if (msgEls.length === 0) return null;

    const lines = [];
    msgEls.forEach((msg) => {
      const role = msg.getAttribute('data-message-author-role') || '';
      const text = msg.textContent || '';
      const cleaned = text.trim().replace(/\s+/g, ' ');
      if (cleaned.length > 0) {
        lines.push(`${role}: ${cleaned}`);
      }
    });

    return lines.join('\n');
  }

  function extractTimestampOnly() {
    const url = window.location.href;
    const now = new Date();
    const timestamp = now.toLocaleString();
    return `Chat started at ${timestamp} from ${url}`;
  }

  async function computeHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
 }

  async function sendToAPI(text, hash, url, site, mode) {
    try {
      const token = await chrome.storage.local.get(['authToken']);
      const authToken = token.authToken;
      
      if (!authToken) {
        console.log('[Friction] No auth token, skipping save');
        return;
      }

      const response = await fetch(`${API_BASE}/api/moments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          raw_text: text,
          source_type: 'auto',
          source_url: url,
          capture_hash: hash,
          created_at: new Date().toISOString()
        })
      });

      console.log('[Friction] API response status:', response.status);
      const data = await response.json();
      console.log('[Friction] API response:', data);

      if (response.status === 401) {
        console.log('[Friction] Auth expired');
        return;
      }

      if (!data.duplicate) {
        console.log('[Friction] Moment saved successfully');
      } else {
        console.log('[Friction] Duplicate moment skipped');
      }
    } catch (err) {
      console.error('[Friction] API call failed:', err);
    }
  }

  let lastMessageCount = 0;
  let lastConversationHash = '';
  let captureTimeout = null;

  function handleMutation(mutations) {
    if (!mutations.length) return;

    const site = detectSite();
    if (!site) return;

    const config = getSiteConfig(site);
    const convEl = document.querySelector(config.conversation);
    if (!convEl) return;

    const msgEls = convEl.querySelectorAll(config.message);
    const currentCount = msgEls.length;

    console.log('[Friction] Mutation detected, messages:', currentCount, '(was:', lastMessageCount + ')');

    if (currentCount === lastMessageCount) return;

    if (captureTimeout) clearTimeout(captureTimeout);
    captureTimeout = setTimeout(async () => {
      let settings;
      try {
        settings = await chrome.storage.local.get([
          'autoCapture',
          'captureMode',
          'autoCaptureSites'
        ]);
        console.log('[Friction] Capture settings:', settings);
      } catch (err) {
        console.error('[Friction] Failed to read storage:', err.message);
        return;
      }

      if (!settings.autoCapture) {
        console.log('[Friction] Auto capture disabled');
        return;
      }
      if (!settings.autoCaptureSites || !settings.autoCaptureSites[site]) {
        console.log('[Friction] Site', site, 'disabled');
        return;
      }

      const mode = settings.captureMode || 'whole_convo';
      let text;

      if (mode === 'whole_convo') {
        text = extractConversationText(site, config);
      } else {
        text = extractTimestampOnly();
      }

      console.log('[Friction] Extracted text, length:', text?.length);

      if (!text || text.length === 0) {
        console.log('[Friction] No text extracted');
        return;
      }

      const hash = await computeHash(text);
      console.log('[Friction] Computed hash:', hash.slice(0, 16) + '...');

      if (hash === lastConversationHash) {
        console.log('[Friction] Duplicate detected, skipping');
        return;
      }
      lastConversationHash = hash;
      lastMessageCount = currentCount;

      console.log('[Friction] Sending to API...');
      await sendToAPI(text, hash, window.location.href, site, mode);
    }, 2000);
  }

  function startObserving() {
    const site = detectSite();
    if (!site) return;

    const config = getSiteConfig(site);
    const target = document.querySelector(config.conversation) || document.body;

    console.log('[Friction] Starting observer for', site, 'URL:', window.location.href);

    const observer = new MutationObserver(handleMutation);
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    console.log('[Friction] Observer active');

    let lastUrl = window.location.href;
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[Friction] URL changed to', currentUrl);
        handleMutation([{ target: document.body }]);
      }
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }

  setTimeout(startObserving, 1000);
  setTimeout(startObserving, 3000);
  setTimeout(startObserving, 5000);

})();
