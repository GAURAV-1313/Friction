const API_BASE = 'https://friction-production.up.railway.app';
const COOLDOWN_MS = 3000;
let lastCaptureAt = 0;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-moment') return;

  const now = Date.now();
  if (now - lastCaptureAt < COOLDOWN_MS) {
    await showBadge('Wait');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const [{ result: selectionText } = { result: '' }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection().toString()
  });

  const text = (selectionText || '').trim();
  if (!text) {
    await showBadge('No selection');
    return;
  }

  const { authToken } = await chrome.storage.local.get(['authToken']);
  if (!authToken) {
    await showBadge('No token');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/moments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        raw_text: text,
        source_type: 'highlight',
        source_url: tab.url || null,
        created_at: new Date().toISOString()
      })
    });

    if (response.status === 401) {
      await chrome.storage.local.remove(['authToken']);
      await showBadge('Auth');
      return;
    }

    if (!response.ok) {
      await showBadge('Save failed');
      return;
    }

    lastCaptureAt = Date.now();
    await showBadge('Saved');
  } catch (err) {
    await showBadge('Error');
  }
});

async function showBadge(text) {
  await chrome.action.setBadgeText({ text: ' ' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
  await chrome.action.setBadgeText({ text: text.slice(0, 4) });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1200);
}
