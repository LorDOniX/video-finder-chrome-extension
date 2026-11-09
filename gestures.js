// Mouse gestures: hold the right button and drag left = back, drag right = forward.
(() => {
  // Movement beyond this distance turns a right click into a gesture (context menu is suppressed).
  const GESTURE_START_DISTANCE = 10;
  // Minimum horizontal distance needed to trigger an action.
  const MIN_DISTANCE = 50;

  let start = null;
  let isGesture = false;
  let suppressContextMenu = false;

  window.addEventListener('mousedown', e => {
    if (e.button !== 2) {
      return;
    }

    // Canvas apps (games, editors, maps) often use right-drag themselves – leave them alone.
    // composedPath() also reaches canvases inside shadow DOM.
    if (e.composedPath().some(node => node.nodeName === 'CANVAS')) {
      start = null;
      isGesture = false;
      suppressContextMenu = false;
      return;
    }

    start ={ x: e.clientX, y: e.clientY };
    isGesture = false;
    suppressContextMenu = false;
  }, true);

  window.addEventListener('mousemove', e => {
    if (!start) {
      return;
    }

    // Right button was released outside the window.
    if (!(e.buttons & 2)) {
      start = null;
      return;
    }

    if (!isGesture && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= GESTURE_START_DISTANCE) {
      isGesture = true;
    }
  }, true);

  window.addEventListener('mouseup', e => {
    if (e.button !== 2 || !start) {
      return;
    }

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    suppressContextMenu = isGesture;
    start = null;
    isGesture = false;

    // Only mostly horizontal strokes count.
    if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 2) {
      return;
    }

    runAction(dx < 0 ? 'back' : 'forward');
  }, true);

  window.addEventListener('contextmenu', e => {
    // On Windows the menu fires after mouseup, elsewhere it may fire while the button is still held.
    if (suppressContextMenu || isGesture) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    suppressContextMenu = false;
  }, true);

  function runAction(action) {
    try {
      chrome.runtime.sendMessage({ type: 'gesture', action }).catch(() => fallback(action));
    } catch (e) {
      // Extension context invalidated (e.g. after reload).
      fallback(action);
    }
  }

  function fallback(action) {
    if (action === 'back') {
      history.back();
    } else {
      history.forward();
    }
  }
})();
