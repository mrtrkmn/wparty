// Content script for Watch Party extension
// Detects video elements and synchronizes playback across participants

(function() {
  'use strict';

  let videoElement = null;
  let isSyncing = false; // Flag to prevent sync loops
  let isInParty = false;
  let lastSyncTime = 0;
  let lastKnownUrl = window.location.href; // Track URL for SPA navigation
  let overlayElement = null; // In-page participant overlay
  let overlayShadow = null; // Shadow root reference
  let overlayCollapsed = false; // Track collapsed state
  let dragMoveHandler = null; // Track drag handlers for cleanup
  let dragUpHandler = null;
  let theaterModeActive = false; // Track theater mode state
  let hiddenElements = []; // Elements hidden by theater mode
  const SYNC_COOLDOWN = 300; // Minimum time between sync events in ms
  const TIME_DRIFT_TOLERANCE = 1; // Only sync if time difference > 1 second

  // Detect video element on the page
  function detectVideo() {
    const selectors = [
      'video',                                    // Generic HTML5 video
      '.html5-main-video',                        // YouTube
      'video.vp-video',                           // Vimeo
      'video.vjs-tech',                           // Video.js (used by many sites)
      'video[data-a-player-type="twitch"]',       // Twitch
      'video[data-uia="video-player"]',           // Netflix
      '.dv-player-fullscreen video',              // Amazon Prime Video
      'video.btm-video-player',                   // Disney+
      '.rendererContainer video',                 // Netflix (alternative)
      '#dv-web-player video'                      // Amazon Prime Video (alternative)
    ];

    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video && video instanceof HTMLVideoElement) {
        return video;
      }
    }

    return null;
  }

  // Initialize video monitoring
  function initVideo() {
    videoElement = detectVideo();
    
    if (!videoElement) {
      setTimeout(initVideo, 1000);
      return;
    }

    console.log('Watch Party: Video element detected');
    attachVideoListeners();
    if (isInParty) {
      sendVideoInfo();
    }
  }

  // Attach event listeners to video element
  function attachVideoListeners() {
    if (!videoElement) return;

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('seeked', handleSeeked);
    videoElement.addEventListener('ratechange', handleRateChange);
    
    console.log('Watch Party: Video listeners attached');
  }

  // Remove event listeners from video element
  function detachVideoListeners() {
    if (!videoElement) return;

    videoElement.removeEventListener('play', handlePlay);
    videoElement.removeEventListener('pause', handlePause);
    videoElement.removeEventListener('seeked', handleSeeked);
    videoElement.removeEventListener('ratechange', handleRateChange);
  }

  // Handle play event
  function handlePlay() {
    if (isSyncing || !isInParty) return;
    
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;

    console.log('Watch Party: Play event');
    sendSyncEvent('play', {
      currentTime: videoElement.currentTime,
      playbackRate: videoElement.playbackRate
    });
  }

  // Handle pause event
  function handlePause() {
    if (isSyncing || !isInParty) return;
    
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;

    console.log('Watch Party: Pause event');
    sendSyncEvent('pause', {
      currentTime: videoElement.currentTime
    });
  }

  // Handle seeked event
  function handleSeeked() {
    if (isSyncing || !isInParty) return;
    
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;

    console.log('Watch Party: Seeked event');
    sendSyncEvent('seek', {
      currentTime: videoElement.currentTime
    });
  }

  // Handle rate change event
  function handleRateChange() {
    if (isSyncing || !isInParty) return;
    
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;

    console.log('Watch Party: Rate change event');
    sendSyncEvent('ratechange', {
      playbackRate: videoElement.playbackRate,
      currentTime: videoElement.currentTime
    });
  }

  // Send sync event to background script
  function sendSyncEvent(action, data) {
    chrome.runtime.sendMessage({
      type: 'sync-event',
      action: action,
      data: data
    }).catch((error) => {
      console.error('Watch Party: Error sending sync event:', error);
    });
  }

  // Send video information to background script
  function sendVideoInfo() {
    if (!videoElement) return;

    const videoInfo = {
      url: window.location.href,
      title: document.title,
      duration: videoElement.duration
    };

    chrome.runtime.sendMessage({
      type: 'video-info',
      data: videoInfo
    }).catch((error) => {
      console.error('Watch Party: Error sending video info:', error);
    });
  }

  // Apply sync event from remote participant
  function applySyncEvent(action, data) {
    if (!videoElement) return;

    isSyncing = true;

    try {
      switch (action) {
        case 'play':
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              videoElement.currentTime = data.currentTime;
            }
          }
          
          if (data.playbackRate && videoElement.playbackRate !== data.playbackRate) {
            videoElement.playbackRate = data.playbackRate;
          }
          
          if (videoElement.paused) {
            videoElement.play().catch((error) => {
              console.error('Watch Party: Error playing video:', error);
            });
          }
          break;

        case 'pause':
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              videoElement.currentTime = data.currentTime;
            }
          }
          
          if (!videoElement.paused) {
            videoElement.pause();
          }
          break;

        case 'seek':
          if (data.currentTime !== undefined) {
            videoElement.currentTime = data.currentTime;
          }
          break;

        case 'ratechange':
          if (data.playbackRate !== undefined && videoElement.playbackRate !== data.playbackRate) {
            videoElement.playbackRate = data.playbackRate;
          }
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              videoElement.currentTime = data.currentTime;
            }
          }
          break;
      }

      console.log(`Watch Party: Applied sync event - ${action}`, data);
    } catch (error) {
      console.error('Watch Party: Error applying sync event:', error);
    } finally {
      // Reset syncing flag after a short delay to let event handlers settle
      setTimeout(() => {
        isSyncing = false;
      }, SYNC_COOLDOWN);
    }
  }

  // ============================================================
  // Theater Mode: hide all elements except the video
  // ============================================================

  function findVideoContainer(video) {
    // Walk up to find the best container that wraps the video player
    let container = video.parentElement;
    
    // For YouTube, look for #movie_player or #player-container
    const ytPlayer = document.querySelector('#movie_player') || document.querySelector('#player-container-inner');
    if (ytPlayer && ytPlayer.contains(video)) return ytPlayer;

    // For other platforms, walk up a few levels
    for (let i = 0; i < 5 && container; i++) {
      const rect = container.getBoundingClientRect();
      // If the container is reasonably large (at least 300x200), use it
      if (rect.width >= 300 && rect.height >= 200) {
        return container;
      }
      container = container.parentElement;
    }

    // Fallback to video's direct parent
    return video.parentElement;
  }

  function enableTheaterMode() {
    if (theaterModeActive || !videoElement) return;
    theaterModeActive = true;
    hiddenElements = [];

    const videoContainer = findVideoContainer(videoElement);
    if (!videoContainer) return;

    // Create a style element that hides everything except the video container and the overlay
    const styleEl = document.createElement('style');
    styleEl.id = 'wparty-theater-style';
    styleEl.textContent = `
      body > *:not(#wparty-overlay) {
        display: none !important;
      }
      #wparty-theater-wrapper {
        display: block !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        background: #000 !important;
        z-index: 2147483646 !important;
      }
      #wparty-theater-wrapper video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
      }
      #wparty-overlay {
        display: block !important;
      }
    `;
    document.head.appendChild(styleEl);

    // Create a wrapper that sits at the top of body
    const wrapper = document.createElement('div');
    wrapper.id = 'wparty-theater-wrapper';
    
    // Clone the video into the wrapper (or move it)
    // Moving is simpler but may break some players, so we apply styles to make
    // the existing video cover the full viewport
    // Instead: position the video container fixed and fullscreen
    videoContainer.dataset.wpartyOriginalStyle = videoContainer.getAttribute('style') || '';
    videoContainer.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483646 !important;
      background: #000 !important;
    `;

    videoElement.dataset.wpartyOriginalStyle = videoElement.getAttribute('style') || '';
    videoElement.style.cssText += `
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    `;

    // Ensure the video container's ancestors are visible
    let ancestor = videoContainer.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      const origDisplay = window.getComputedStyle(ancestor).display;
      ancestor.dataset.wpartyOrigDisplay = origDisplay;
      ancestor.style.setProperty('display', 'block', 'important');
      hiddenElements.push(ancestor);
      ancestor = ancestor.parentElement;
    }

    console.log('Watch Party: Theater mode enabled');
  }

  function disableTheaterMode() {
    if (!theaterModeActive) return;
    theaterModeActive = false;

    // Remove theater style
    const styleEl = document.getElementById('wparty-theater-style');
    if (styleEl) styleEl.remove();

    // Remove theater wrapper
    const wrapper = document.getElementById('wparty-theater-wrapper');
    if (wrapper) wrapper.remove();

    // Restore video container styles
    if (videoElement) {
      const container = findVideoContainer(videoElement);
      if (container && container.dataset.wpartyOriginalStyle !== undefined) {
        container.setAttribute('style', container.dataset.wpartyOriginalStyle);
        delete container.dataset.wpartyOriginalStyle;
      }
      if (videoElement.dataset.wpartyOriginalStyle !== undefined) {
        videoElement.setAttribute('style', videoElement.dataset.wpartyOriginalStyle);
        delete videoElement.dataset.wpartyOriginalStyle;
      }
    }

    // Restore ancestor display values
    for (const el of hiddenElements) {
      if (el.dataset.wpartyOrigDisplay !== undefined) {
        el.style.display = el.dataset.wpartyOrigDisplay;
        delete el.dataset.wpartyOrigDisplay;
      }
    }
    hiddenElements = [];

    console.log('Watch Party: Theater mode disabled');
  }

  // ============================================================
  // Participant Overlay
  // ============================================================

  function createOverlay() {
    if (overlayElement) return;

    overlayElement = document.createElement('div');
    overlayElement.id = 'wparty-overlay';

    const shadow = overlayElement.attachShadow({ mode: 'closed' });
    overlayShadow = shadow;

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        display: block !important;
      }
      .wparty-panel {
        background: rgba(30, 30, 46, 0.92);
        border: 1px solid rgba(139, 92, 246, 0.4);
        border-radius: 10px;
        color: #e0e0e0;
        min-width: 180px;
        max-width: 260px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        overflow: hidden;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        transition: width 0.2s, min-width 0.2s;
      }
      .wparty-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(139, 92, 246, 0.3));
        cursor: move;
        user-select: none;
        -webkit-user-select: none;
      }
      .wparty-header-left {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        font-size: 12px;
        color: #fff;
      }
      .wparty-toggle {
        background: none;
        border: none;
        color: #c4b5fd;
        cursor: pointer;
        font-size: 14px;
        padding: 0 2px;
        line-height: 1;
        opacity: 0.8;
      }
      .wparty-toggle:hover {
        opacity: 1;
      }
      .wparty-body {
        padding: 8px 10px;
      }
      .wparty-body.collapsed {
        display: none;
      }
      .wparty-participant {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 5px;
        margin-bottom: 3px;
        font-size: 12px;
        color: #e0e0e0;
      }
      .wparty-participant:last-child {
        margin-bottom: 0;
      }
      .wparty-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .wparty-dot.synced {
        background: #22c55e;
        box-shadow: 0 0 5px rgba(34, 197, 94, 0.5);
      }
      .wparty-dot.not-synced {
        background: #eab308;
        box-shadow: 0 0 5px rgba(234, 179, 8, 0.5);
      }
      .wparty-dot.no-video {
        background: #6b7280;
      }
      .wparty-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wparty-count {
        background: rgba(139, 92, 246, 0.3);
        color: #c4b5fd;
        border-radius: 8px;
        padding: 1px 6px;
        font-size: 11px;
        font-weight: 600;
      }
      .wparty-panel.collapsed-panel {
        min-width: auto;
      }
    `;

    const panel = document.createElement('div');
    panel.className = 'wparty-panel';

    const header = document.createElement('div');
    header.className = 'wparty-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'wparty-header-left';
    headerLeft.innerHTML = '<span>🎬</span><span>Watch Party</span>';

    const countBadge = document.createElement('span');
    countBadge.className = 'wparty-count';
    countBadge.textContent = '0';
    headerLeft.appendChild(countBadge);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'wparty-toggle';
    toggleBtn.textContent = '▾';
    toggleBtn.title = 'Toggle participants list';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      overlayCollapsed = !overlayCollapsed;
      const body = shadow.querySelector('.wparty-body');
      if (overlayCollapsed) {
        body.classList.add('collapsed');
        panel.classList.add('collapsed-panel');
        toggleBtn.textContent = '▸';
      } else {
        body.classList.remove('collapsed');
        panel.classList.remove('collapsed-panel');
        toggleBtn.textContent = '▾';
      }
    });

    header.appendChild(headerLeft);
    header.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.className = 'wparty-body';

    panel.appendChild(header);
    panel.appendChild(body);
    shadow.appendChild(style);
    shadow.appendChild(panel);

    document.documentElement.appendChild(overlayElement);

    // Make draggable via header
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.wparty-toggle')) return;
      isDragging = true;
      const rect = overlayElement.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    dragMoveHandler = (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      overlayElement.style.left = x + 'px';
      overlayElement.style.top = y + 'px';
      overlayElement.style.right = 'auto';
    };

    dragUpHandler = () => {
      isDragging = false;
    };

    document.addEventListener('mousemove', dragMoveHandler);
    document.addEventListener('mouseup', dragUpHandler);

    console.log('Watch Party: Overlay created');
  }

  // Remove overlay from page
  function removeOverlay() {
    if (dragMoveHandler) {
      document.removeEventListener('mousemove', dragMoveHandler);
      dragMoveHandler = null;
    }
    if (dragUpHandler) {
      document.removeEventListener('mouseup', dragUpHandler);
      dragUpHandler = null;
    }
    if (overlayElement) {
      overlayElement.remove();
      overlayElement = null;
    }
    overlayShadow = null;
  }

  // Update overlay with participant data
  function updateOverlay(participants) {
    if (!overlayElement || !overlayShadow) return;

    const body = overlayShadow.querySelector('.wparty-body');
    const countBadge = overlayShadow.querySelector('.wparty-count');
    if (!body || !countBadge) return;

    countBadge.textContent = participants.length;
    body.innerHTML = '';

    participants.forEach(participant => {
      const row = document.createElement('div');
      row.className = 'wparty-participant';

      const dot = document.createElement('span');
      dot.className = 'wparty-dot';

      if (typeof participant === 'string') {
        dot.classList.add('no-video');
        const name = document.createElement('span');
        name.className = 'wparty-name';
        name.textContent = participant;
        row.appendChild(dot);
        row.appendChild(name);
      } else {
        if (!participant.videoUrl) {
          dot.classList.add('no-video');
          dot.title = 'No video detected';
        } else if (participant.synced) {
          dot.classList.add('synced');
          dot.title = 'Synced';
        } else {
          dot.classList.add('not-synced');
          dot.title = 'Watching different video';
        }

        const name = document.createElement('span');
        name.className = 'wparty-name';
        name.textContent = participant.username;

        row.appendChild(dot);
        row.appendChild(name);
      }

      body.appendChild(row);
    });
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Watch Party: Content script received message:', message.type);

    switch (message.type) {
      case 'sync':
        if (message.data) {
          applySyncEvent(message.data.action, message.data.data || {});
        }
        break;

      case 'joined':
        isInParty = true;
        console.log('Watch Party: Joined party');
        createOverlay();
        if (videoElement) {
          enableTheaterMode();
          sendVideoInfo();
        }
        if (message.data && message.data.participants) {
          updateOverlay(message.data.participants);
        }
        break;

      case 'left':
        isInParty = false;
        console.log('Watch Party: Left party');
        disableTheaterMode();
        removeOverlay();
        break;

      case 'participants':
        if (message.data && message.data.participants) {
          if (isInParty) {
            if (!overlayElement) createOverlay();
            updateOverlay(message.data.participants);
          }
        }
        break;

      case 'video-info':
        if (message.data && message.data.data) {
          console.log('Watch Party: Party video info updated:', message.data.data.url);
        }
        break;

      default:
        break;
    }

    sendResponse({ success: true });
    return true;
  });

  // Check party status on load (in case content script loads after joining)
  async function checkPartyStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get-status' });
      if (response && response.inParty) {
        isInParty = true;
        createOverlay();
        if (response.participants) {
          updateOverlay(response.participants);
        }
        if (videoElement) {
          enableTheaterMode();
          sendVideoInfo();
        }
      }
    } catch (error) {
      // Extension context may not be ready yet
    }
  }

  // Initialize when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initVideo();
      checkPartyStatus();
    });
  } else {
    initVideo();
    checkPartyStatus();
  }

  // Re-detect video if page changes (for SPAs)
  const observer = new MutationObserver(() => {
    if (!videoElement || !document.contains(videoElement)) {
      detachVideoListeners();
      initVideo();
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // Detect URL changes for SPAs (e.g., YouTube navigation)
  setInterval(() => {
    if (window.location.href !== lastKnownUrl) {
      lastKnownUrl = window.location.href;
      console.log('Watch Party: URL changed, re-detecting video');
      detachVideoListeners();
      videoElement = null;
      // Disable theater mode on navigation - will re-enable when new video found
      disableTheaterMode();
      initVideo();
    }
  }, 1000);

  console.log('Watch Party: Content script initialized');
})();
