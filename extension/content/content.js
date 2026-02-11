// Content script for Watch Party extension
// Detects video elements and synchronizes playback across participants

(function() {
  'use strict';

  let videoElement = null;
  let isSyncing = false; // Flag to prevent sync loops
  let isInParty = false;
  let lastSyncTime = 0;
  const SYNC_COOLDOWN = 500; // Minimum time between sync events in ms
  const TIME_DRIFT_TOLERANCE = 2; // Only sync if time difference > 2 seconds

  // Detect video element on the page
  function detectVideo() {
    // Try common video selectors for different platforms
    // Note: Streaming platform selectors (Netflix, Prime Video, Disney+) may change
    // as these services update their players. These selectors were verified as of 2024.
    const selectors = [
      'video',                                    // Generic HTML5 video
      '.html5-main-video',                        // YouTube
      'video.vp-video',                           // Vimeo
      'video.vjs-tech',                           // Video.js (used by many sites)
      'video[data-a-player-type="twitch"]',       // Twitch
      'video[data-uia="video-player"]',           // Netflix (primary selector)
      '.dv-player-fullscreen video',              // Amazon Prime Video
      'video.btm-video-player',                   // Disney+
      '.rendererContainer video',                 // Netflix (alternative selector)
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
      // Retry after a short delay (some sites load videos dynamically)
      setTimeout(initVideo, 1000);
      return;
    }

    console.log('Watch Party: Video element detected');
    attachVideoListeners();
    sendVideoInfo();
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
          // Check time drift and sync if needed
          const timeDiff = Math.abs(videoElement.currentTime - data.currentTime);
          if (timeDiff > TIME_DRIFT_TOLERANCE) {
            videoElement.currentTime = data.currentTime;
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
          if (Math.abs(videoElement.currentTime - data.currentTime) > TIME_DRIFT_TOLERANCE) {
            videoElement.currentTime = data.currentTime;
          }
          
          if (!videoElement.paused) {
            videoElement.pause();
          }
          break;

        case 'seek':
          if (Math.abs(videoElement.currentTime - data.currentTime) > TIME_DRIFT_TOLERANCE) {
            videoElement.currentTime = data.currentTime;
          }
          break;

        case 'ratechange':
          if (videoElement.playbackRate !== data.playbackRate) {
            videoElement.playbackRate = data.playbackRate;
          }
          break;
      }

      console.log(`Watch Party: Applied sync event - ${action}`, data);
    } catch (error) {
      console.error('Watch Party: Error applying sync event:', error);
    } finally {
      // Reset syncing flag after a short delay
      setTimeout(() => {
        isSyncing = false;
      }, 100);
    }
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Watch Party: Content script received message:', message);

    switch (message.type) {
      case 'sync':
        applySyncEvent(message.data.action, message.data.data);
        break;

      case 'joined':
        isInParty = true;
        console.log('Watch Party: Joined party');
        sendVideoInfo();
        break;

      case 'left':
        isInParty = false;
        console.log('Watch Party: Left party');
        break;

      default:
        console.log('Watch Party: Unknown message type:', message.type);
    }

    sendResponse({ success: true });
    return true;
  });

  // Initialize when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVideo);
  } else {
    initVideo();
  }

  // Re-detect video if page changes (for SPAs)
  const observer = new MutationObserver(() => {
    if (!videoElement || !document.contains(videoElement)) {
      detachVideoListeners();
      initVideo();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('Watch Party: Content script initialized');
})();
