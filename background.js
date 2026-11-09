chrome.runtime.onInstalled.addListener(() => {
  console.log('Video Finder Extension installed');
});

// DevTools panels can't call chrome.downloads directly, so the panel delegates here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'download') {
    return;
  }

  let parsed;

  try {
    parsed = new URL(msg.url);
  } catch (e) {
    sendResponse({ ok: false, error: 'Invalid URL' });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendResponse({ ok: false, error: 'Unsupported protocol' });
    return;
  }

  chrome.downloads.download({ url: parsed.href, saveAs: false })
    .then(id => sendResponse({ ok: true, id }))
    .catch(e => sendResponse({ ok: false, error: e.message }));

  // Keep the message channel open for the async response.
  return true;
});

// Mouse gestures from content script (gestures.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'gesture' || !sender.tab?.id) {
    return;
  }

  const tabId = sender.tab.id;

  if (msg.action === 'back') {
    chrome.tabs.goBack(tabId).catch(() => {});
  } else if (msg.action === 'forward') {
    chrome.tabs.goForward(tabId).catch(() => {});
  }
});
