// Content script for Watch Party extension
// Detects video elements and synchronizes playback across participants

(function() {
  'use strict';

  let videoElement = null;
  let isSyncing = false; // Flag to prevent sync loops
  let isInParty = false;
  let currentPartyCode = null; // Track the current party code
  let lastSyncTime = 0;
  let lastKnownUrl = window.location.href; // Track URL for SPA navigation
  let lastSentVideoUrl = null; // Track the last video URL sent to server
  let overlayElement = null; // In-page participant overlay
  let overlayShadow = null; // Shadow root reference
  let overlayCollapsed = false; // Track collapsed state
  let dragMoveHandler = null; // Track drag handlers for cleanup
  let dragUpHandler = null;
  let theaterModeActive = false; // Track theater mode state
  let hiddenElements = []; // Elements hidden by theater mode
  const SYNC_COOLDOWN = 300; // Minimum time between sync events in ms
  const TIME_DRIFT_TOLERANCE = 1; // Only sync if time difference > 1 second
  const PARTY_CODE_PLACEHOLDER = '------';
  let currentVideoUrl = null; // Track the current video URL for overlay display

  // Detect if the current site is Netflix (DRM-protected, requires special handling)
  function isNetflix() {
    const hostname = window.location.hostname;
    return hostname === 'netflix.com' || hostname.endsWith('.netflix.com');
  }

  // Detect if the current site is YouTube
  function isYouTube() {
    const hostname = window.location.hostname;
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  }

  // Send T keyboard event to YouTube player to toggle YouTube's native theater mode
  function sendYouTubeTheaterKey() {
    if (!isYouTube()) return;
    const target = document.querySelector('#movie_player, #player-container, .html5-video-player') || document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', keyCode: 84, bubbles: true }));
  }

  // Find Netflix's play/pause button and simulate a click to toggle playback.
  // This avoids directly calling .play()/.pause() on the video element which
  // triggers Netflix's Widevine DRM error M7375.
  function netflixTogglePlayPause() {
    // Netflix uses a button with data-uia="control-play-pause-*"
    const playPauseBtn = document.querySelector('[data-uia="control-play-pause-pause"], [data-uia="control-play-pause-play"], .button-nfplayerPause, .button-nfplayerPlay');
    if (playPauseBtn) {
      playPauseBtn.click();
      return true;
    }

    // Fallback: simulate a Space key press on the document, which Netflix's
    // player intercepts to toggle play/pause
    const target = document.querySelector('.watch-video, .NFPlayer, .VideoContainer') || document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
    return true;
  }

  // Seek on Netflix by dispatching seek commands through the Netflix player API
  // or simulating user-initiated seek. Direct setting of videoElement.currentTime
  // can trigger DRM error M7375.
  function netflixSeek(targetTime) {
    if (!videoElement) return false;

    // Netflix exposes its player API on the video player's Cadmium interface.
    // Try to find the Netflix player API via the known accessor.
    const videoPlayer = netflix_getPlayerAPI();
    if (videoPlayer) {
      try {
        // Netflix API seek uses milliseconds
        videoPlayer.seek(targetTime * 1000);
        return true;
      } catch (e) {
        console.log('Watch Party: Netflix API seek failed, using fallback');
      }
    }

    // Fallback: set currentTime directly. This may work for seek operations
    // on some Netflix content but could fail on stricter DRM-protected titles.
    console.log('Watch Party: Netflix API unavailable, falling back to direct seek');
    videoElement.currentTime = targetTime;
    return true;
  }

  // Attempt to get the Netflix player API (Cadmium player)
  function netflix_getPlayerAPI() {
    try {
      const videoPlayerEl = document.querySelector('.NFPlayer, .watch-video--player-view');
      if (videoPlayerEl) {
        const sessionId = netflix_getSessionId();
        if (sessionId && window.netflix && window.netflix.appContext) {
          const playerApp = window.netflix.appContext.state.playerApp;
          if (playerApp) {
            return playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId(sessionId);
          }
        }
      }
    } catch (e) {
      // Netflix API not available or structure changed
    }
    return null;
  }

  // Get Netflix session ID from the player
  function netflix_getSessionId() {
    try {
      if (window.netflix && window.netflix.appContext) {
        const playerApp = window.netflix.appContext.state.playerApp;
        if (playerApp) {
          const sessionIds = playerApp.getAPI().videoPlayer.getAllPlayerSessionIds();
          // Use the last session ID as it corresponds to the most recently created player
          if (sessionIds && sessionIds.length > 0) {
            return sessionIds[sessionIds.length - 1];
          }
        }
      }
    } catch (e) {
      // Netflix API not available
    }
    return null;
  }

  // Normalize YouTube URLs so Shorts and regular watch URLs for the same video are equivalent
  function normalizeYouTubeUrl(url) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace('www.', '');
      if (hostname !== 'youtube.com') return url;

      // Convert /shorts/VIDEO_ID to /watch?v=VIDEO_ID
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) {
        parsed.pathname = '/watch';
        parsed.searchParams.set('v', shortsMatch[1]);
        return parsed.toString();
      }
      return url;
    } catch (e) {
      return url;
    }
  }

  // Detect if an advertisement is currently playing
  function isAdPlaying() {
    // YouTube: the player gets an 'ad-showing' class during ads
    const ytPlayer = document.querySelector('#movie_player.ad-showing, #movie_player.ad-showing .html5-main-video');
    if (ytPlayer) return true;

    // YouTube: ad overlay or ad module visible (regular and Shorts)
    if (document.querySelector('.ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-text, ytd-reel-video-renderer .ytp-ad-player-overlay')) return true;

    // Twitch: pre-roll or mid-roll ad indicators
    if (document.querySelector('[data-a-target="player-ad-overlay"], .player-ad-overlay')) return true;

    // Generic: some players use a data attribute or class on the video element
    if (videoElement && (videoElement.classList.contains('ad-playing') || videoElement.dataset.adPlaying === 'true')) return true;

    return false;
  }

  // Detect video element on the page
  function detectVideo() {
    const selectors = [
      'video',                                    // Generic HTML5 video
      '.html5-main-video',                        // YouTube
      'ytd-shorts video',                         // YouTube Shorts
      'ytd-reel-video-renderer video',            // YouTube Shorts (alternative)
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
    videoElement.addEventListener('loadeddata', handleVideoLoaded);
    
    console.log('Watch Party: Video listeners attached');
  }

  // Remove event listeners from video element
  function detachVideoListeners() {
    if (!videoElement) return;

    videoElement.removeEventListener('play', handlePlay);
    videoElement.removeEventListener('pause', handlePause);
    videoElement.removeEventListener('seeked', handleSeeked);
    videoElement.removeEventListener('ratechange', handleRateChange);
    videoElement.removeEventListener('loadeddata', handleVideoLoaded);
  }

  // Handle play event
  function handlePlay() {
    if (isSyncing || !isInParty) return;
    if (isAdPlaying()) return;
    
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
    if (isAdPlaying()) return;
    
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
    if (isAdPlaying()) return;
    
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
    if (isAdPlaying()) return;
    
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;

    console.log('Watch Party: Rate change event');
    sendSyncEvent('ratechange', {
      playbackRate: videoElement.playbackRate,
      currentTime: videoElement.currentTime
    });
  }

  // Handle new video loaded (e.g., YouTube autoplay next, playlist, Shorts)
  function handleVideoLoaded() {
    if (!isInParty) return;
    const currentUrl = normalizeYouTubeUrl(window.location.href);
    if (currentUrl !== lastSentVideoUrl) {
      console.log('Watch Party: New video loaded, sending updated info');
      sendVideoInfo();
    }
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

    const currentUrl = normalizeYouTubeUrl(window.location.href);
    lastSentVideoUrl = currentUrl;
    currentVideoUrl = currentUrl;
    updateOverlayUrl(currentUrl);

    const videoInfo = {
      url: currentUrl,
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
    if (isAdPlaying()) return;

    isSyncing = true;
    const onNetflix = isNetflix();

    try {
      switch (action) {
        case 'play':
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              if (onNetflix) {
                netflixSeek(data.currentTime);
              } else {
                videoElement.currentTime = data.currentTime;
              }
            }
          }
          
          if (data.playbackRate && videoElement.playbackRate !== data.playbackRate) {
            if (!onNetflix) {
              videoElement.playbackRate = data.playbackRate;
            }
          }
          
          if (videoElement.paused) {
            if (onNetflix) {
              netflixTogglePlayPause();
            } else {
              videoElement.play().catch((error) => {
                console.error('Watch Party: Error playing video:', error);
              });
            }
          }
          break;

        case 'pause':
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              if (onNetflix) {
                netflixSeek(data.currentTime);
              } else {
                videoElement.currentTime = data.currentTime;
              }
            }
          }
          
          if (!videoElement.paused) {
            if (onNetflix) {
              netflixTogglePlayPause();
            } else {
              videoElement.pause();
            }
          }
          break;

        case 'seek':
          if (data.currentTime !== undefined) {
            if (onNetflix) {
              netflixSeek(data.currentTime);
            } else {
              videoElement.currentTime = data.currentTime;
            }
          }
          break;

        case 'ratechange':
          if (data.playbackRate !== undefined && videoElement.playbackRate !== data.playbackRate) {
            if (!onNetflix) {
              videoElement.playbackRate = data.playbackRate;
            }
          }
          if (data.currentTime !== undefined) {
            const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
            if (timeDiff > TIME_DRIFT_TOLERANCE) {
              if (onNetflix) {
                netflixSeek(data.currentTime);
              } else {
                videoElement.currentTime = data.currentTime;
              }
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

    // For YouTube Shorts, look for the reel renderer or shorts container
    const ytShorts = document.querySelector('ytd-reel-video-renderer') || document.querySelector('#shorts-container');
    if (ytShorts && ytShorts.contains(video)) return ytShorts;

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

    // Inject a style element that creates the theater-mode overlay.  A fixed
    // black backdrop sits beneath the video's ancestor branch.  We then walk
    // up the DOM from the video to the direct child of <body> and promote
    // that subtree above the backdrop so the video remains visible.
    const styleEl = document.createElement('style');
    styleEl.id = 'wparty-theater-style';
    styleEl.textContent = `
      #wparty-theater-backdrop {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483644 !important;
        background: #000 !important;
      }
    `;
    document.head.appendChild(styleEl);

    // Create the backdrop element
    const backdrop = document.createElement('div');
    backdrop.id = 'wparty-theater-backdrop';
    document.documentElement.appendChild(backdrop);

    // Find the direct child of <body> that contains the video
    let bodyChild = videoElement;
    while (bodyChild && bodyChild.parentElement && bodyChild.parentElement !== document.body) {
      bodyChild = bodyChild.parentElement;
    }

    // Promote the body-child branch above the backdrop
    if (bodyChild && bodyChild.parentElement === document.body) {
      const orig = bodyChild.getAttribute('style') || '';
      bodyChild.dataset.wpartyOrigStyle = orig;
      hiddenElements.push(bodyChild);
      bodyChild.style.cssText = orig + `;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483645 !important;
        overflow: hidden !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: none !important;
        max-width: none !important;
        max-height: none !important;
      `;
    }

    // Make the video fill its promoted container
    const origVideo = videoElement.getAttribute('style') || '';
    videoElement.dataset.wpartyOrigStyle = origVideo;
    hiddenElements.push(videoElement);
    videoElement.style.cssText = origVideo + `;
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
      background: #000 !important;
    `;

    // Walk intermediate ancestors (between video and the body-child) and
    // make them fill their parent so the video can expand fully.
    let el = videoElement.parentElement;
    while (el && el !== bodyChild && el !== document.body) {
      const orig = el.getAttribute('style') || '';
      el.dataset.wpartyOrigStyle = orig;
      hiddenElements.push(el);
      el.style.cssText = orig + `;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
      `;
      el = el.parentElement;
    }

    console.log('Watch Party: Theater mode enabled');
  }

  function disableTheaterMode() {
    if (!theaterModeActive) return;
    theaterModeActive = false;

    // Remove the injected style and backdrop
    const styleEl = document.getElementById('wparty-theater-style');
    if (styleEl) styleEl.remove();
    const backdrop = document.getElementById('wparty-theater-backdrop');
    if (backdrop) backdrop.remove();

    // Restore original styles for all modified elements
    for (const el of hiddenElements) {
      if (el.dataset.wpartyOrigStyle !== undefined) {
        el.setAttribute('style', el.dataset.wpartyOrigStyle);
        delete el.dataset.wpartyOrigStyle;
      }
    }
    hiddenElements = [];

    // Sync overlay toggle
    updateOverlayTheaterToggle(false);

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
      .wparty-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #6b7280;
      }
      .wparty-status-dot.connected {
        background: #22c55e;
        box-shadow: 0 0 5px rgba(34, 197, 94, 0.5);
      }
      .wparty-status-dot.disconnected {
        background: #ef4444;
        box-shadow: 0 0 5px rgba(239, 68, 68, 0.5);
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
      .wparty-party-code {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        margin-bottom: 6px;
        background: rgba(99, 102, 241, 0.15);
        border-radius: 6px;
        font-size: 11px;
        color: #c4b5fd;
      }
      .wparty-party-code-value {
        font-family: monospace;
        font-weight: 700;
        font-size: 13px;
        color: #a78bfa;
        letter-spacing: 1px;
      }
      .wparty-party-code-copy {
        background: none;
        border: none;
        color: #c4b5fd;
        cursor: pointer;
        font-size: 12px;
        padding: 0 2px;
        opacity: 0.7;
        margin-left: auto;
      }
      .wparty-party-code-copy:hover {
        opacity: 1;
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
      .wparty-url-section {
        padding: 6px 8px;
        margin-top: 6px;
        background: rgba(99, 102, 241, 0.10);
        border-radius: 6px;
        font-size: 11px;
        color: #c4b5fd;
        display: flex;
        align-items: center;
        gap: 4px;
        overflow: hidden;
      }
      .wparty-url-section a {
        color: #a78bfa;
        text-decoration: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .wparty-url-section a:hover {
        text-decoration: underline;
        color: #c4b5fd;
      }
      .wparty-theater-section {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 8px;
        margin-top: 6px;
        background: rgba(99, 102, 241, 0.10);
        border-radius: 6px;
        font-size: 11px;
        color: #c4b5fd;
      }
      .wparty-theater-label {
        font-size: 11px;
        color: #c4b5fd;
      }
      .wparty-theater-toggle {
        position: relative;
        width: 32px;
        height: 18px;
        flex-shrink: 0;
      }
      .wparty-theater-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
      }
      .wparty-theater-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: #4b5563;
        border-radius: 18px;
        transition: background 0.3s;
      }
      .wparty-theater-slider::before {
        content: '';
        position: absolute;
        width: 14px;
        height: 14px;
        left: 2px;
        bottom: 2px;
        background: #e0e0e0;
        border-radius: 50%;
        transition: transform 0.3s;
      }
      .wparty-theater-toggle input:checked + .wparty-theater-slider {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      }
      .wparty-theater-toggle input:checked + .wparty-theater-slider::before {
        transform: translateX(14px);
      }
    `;

    const panel = document.createElement('div');
    panel.className = 'wparty-panel';

    const header = document.createElement('div');
    header.className = 'wparty-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'wparty-header-left';

    const statusDot = document.createElement('span');
    statusDot.className = 'wparty-status-dot';
    statusDot.title = 'Connection status';
    headerLeft.appendChild(statusDot);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Watch Party';
    headerLeft.appendChild(titleSpan);

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

    // Party code section
    const partyCodeSection = document.createElement('div');
    partyCodeSection.className = 'wparty-party-code';

    const partyCodeLabel = document.createElement('span');
    partyCodeLabel.textContent = 'Code:';

    const partyCodeValue = document.createElement('span');
    partyCodeValue.className = 'wparty-party-code-value';
    partyCodeValue.textContent = currentPartyCode || PARTY_CODE_PLACEHOLDER;

    const partyCodeCopy = document.createElement('button');
    partyCodeCopy.className = 'wparty-party-code-copy';
    partyCodeCopy.textContent = '📋';
    partyCodeCopy.title = 'Copy party code';
    partyCodeCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentPartyCode) {
        navigator.clipboard.writeText(currentPartyCode).then(() => {
          partyCodeCopy.textContent = '✓';
          setTimeout(() => { partyCodeCopy.textContent = '📋'; }, 1500);
        }).catch(() => {
          partyCodeCopy.textContent = '✗';
          setTimeout(() => { partyCodeCopy.textContent = '📋'; }, 1500);
        });
      }
    });

    partyCodeSection.appendChild(partyCodeLabel);
    partyCodeSection.appendChild(partyCodeValue);
    partyCodeSection.appendChild(partyCodeCopy);
    body.appendChild(partyCodeSection);

    // URL section
    const urlSection = document.createElement('div');
    urlSection.className = 'wparty-url-section';
    const urlLabel = document.createElement('span');
    urlLabel.textContent = '🔗';
    const urlLink = document.createElement('a');
    urlLink.className = 'wparty-url-link';
    urlLink.href = currentVideoUrl || window.location.href;
    urlLink.textContent = currentVideoUrl || window.location.href;
    urlLink.title = currentVideoUrl || window.location.href;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlSection.appendChild(urlLabel);
    urlSection.appendChild(urlLink);
    body.appendChild(urlSection);

    // Theater mode toggle section
    const theaterSection = document.createElement('div');
    theaterSection.className = 'wparty-theater-section';

    const theaterLabel = document.createElement('span');
    theaterLabel.className = 'wparty-theater-label';
    theaterLabel.textContent = '🎭 Theater Mode';

    const theaterToggleWrapper = document.createElement('div');
    theaterToggleWrapper.className = 'wparty-theater-toggle';

    const theaterCheckbox = document.createElement('input');
    theaterCheckbox.type = 'checkbox';
    theaterCheckbox.checked = theaterModeActive;
    theaterCheckbox.className = 'wparty-theater-checkbox';

    const theaterSlider = document.createElement('span');
    theaterSlider.className = 'wparty-theater-slider';

    theaterCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      const enabled = theaterCheckbox.checked;
      chrome.storage.local.set({ theaterMode: enabled });
      if (enabled) {
        sendYouTubeTheaterKey();
        enableTheaterMode();
      } else {
        sendYouTubeTheaterKey();
        disableTheaterMode();
      }
    });

    theaterSlider.addEventListener('click', (e) => {
      e.stopPropagation();
      theaterCheckbox.checked = !theaterCheckbox.checked;
      theaterCheckbox.dispatchEvent(new Event('change'));
    });

    theaterToggleWrapper.appendChild(theaterCheckbox);
    theaterToggleWrapper.appendChild(theaterSlider);
    theaterSection.appendChild(theaterLabel);
    theaterSection.appendChild(theaterToggleWrapper);
    body.appendChild(theaterSection);

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

    // Remove existing participant rows (but keep the party code section)
    const existingRows = body.querySelectorAll('.wparty-participant');
    existingRows.forEach(row => row.remove());

    // Update party code display
    const codeValue = body.querySelector('.wparty-party-code-value');
    if (codeValue && currentPartyCode) {
      codeValue.textContent = currentPartyCode;
    }

    // Update URL display
    const urlLink = body.querySelector('.wparty-url-link');
    if (urlLink) {
      const displayUrl = currentVideoUrl || window.location.href;
      urlLink.href = displayUrl;
      urlLink.textContent = displayUrl;
      urlLink.title = displayUrl;
    }

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

  // Update connection status indicator in the overlay
  function updateOverlayConnectionStatus(status) {
    if (!overlayShadow) return;
    const dot = overlayShadow.querySelector('.wparty-status-dot');
    if (!dot) return;

    dot.className = 'wparty-status-dot';
    if (status === 'connected') {
      dot.classList.add('connected');
      dot.title = 'Connected to server';
    } else {
      dot.classList.add('disconnected');
      dot.title = 'Disconnected from server';
    }
  }

  // Update party code display in the overlay
  function updateOverlayPartyCode(code) {
    if (!overlayShadow) return;
    const codeValue = overlayShadow.querySelector('.wparty-party-code-value');
    if (codeValue) {
      codeValue.textContent = code || PARTY_CODE_PLACEHOLDER;
    }
  }

  // Update URL display in the overlay
  function updateOverlayUrl(url) {
    if (!overlayShadow) return;
    const urlLink = overlayShadow.querySelector('.wparty-url-link');
    if (urlLink) {
      const displayUrl = url || window.location.href;
      urlLink.href = displayUrl;
      urlLink.textContent = displayUrl;
      urlLink.title = displayUrl;
    }
  }

  // Update theater mode toggle state in the overlay
  function updateOverlayTheaterToggle(enabled) {
    if (!overlayShadow) return;
    const checkbox = overlayShadow.querySelector('.wparty-theater-checkbox');
    if (checkbox) {
      checkbox.checked = enabled;
    }
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
        if (message.data && message.data.partyCode) {
          currentPartyCode = message.data.partyCode;
        }
        console.log('Watch Party: Joined party');
        createOverlay();
        updateOverlayPartyCode(currentPartyCode);
        updateOverlayConnectionStatus('connected');
        if (videoElement) {
          sendVideoInfo();
        }
        if (message.data && message.data.participants) {
          updateOverlay(message.data.participants);
        }
        break;

      case 'left':
        isInParty = false;
        currentPartyCode = null;
        console.log('Watch Party: Left party');
        sendYouTubeTheaterKey();
        disableTheaterMode();
        chrome.storage.local.set({ theaterMode: false });
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

      case 'connection-status':
        updateOverlayConnectionStatus(message.status);
        break;

      case 'video-info':
        if (message.data && message.data.data) {
          console.log('Watch Party: Party video info updated:', message.data.data.url);
          if (message.data.data.url) {
            currentVideoUrl = message.data.data.url;
            updateOverlayUrl(currentVideoUrl);
          }
        }
        break;

      case 'video-changed':
        if (message.data && message.data.url) {
          const newUrl = normalizeYouTubeUrl(message.data.url);
          // Only navigate if the URL is different from the current page (normalize YouTube URLs for comparison)
          if (newUrl !== normalizeYouTubeUrl(window.location.href)) {
            console.log('Watch Party: Video changed by ' + (message.username || 'participant') + ', navigating to:', newUrl);
            window.location.href = newUrl;
          }
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
        if (response.partyCode) {
          currentPartyCode = response.partyCode;
        }
        createOverlay();
        updateOverlayPartyCode(currentPartyCode);
        updateOverlayConnectionStatus(response.connectionStatus || 'disconnected');
        if (response.participants) {
          updateOverlay(response.participants);
        }
        if (videoElement) {
          sendVideoInfo();
        }
        // Restore theater mode if it was enabled
        const stored = await chrome.storage.local.get(['theaterMode']);
        if (stored.theaterMode && videoElement) {
          sendYouTubeTheaterKey();
          enableTheaterMode();
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

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    // Wait for body to be available before observing
    const bodyWaiter = new MutationObserver(() => {
      if (document.body) {
        bodyWaiter.disconnect();
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    });
    bodyWaiter.observe(document.documentElement, { childList: true });
  }

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
