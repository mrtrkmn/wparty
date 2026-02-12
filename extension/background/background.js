// Background service worker for Watch Party extension
// Manages WebSocket connection and relays messages between content scripts and server

let ws = null;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let heartbeatInterval = null;
let videoTabId = null; // Track the tab that has the video
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 25000; // 25 seconds

// Get server URL from storage or use default
async function getServerUrl() {
  const result = await chrome.storage.local.get(['serverUrl']);
  return result.serverUrl || 'ws://localhost:8080';
}

// Connect to WebSocket server
async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log('Already connected or connecting');
    return;
  }

  const serverUrl = await getServerUrl();
  console.log('Connecting to:', serverUrl);

  try {
    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts = 0;
      
      // Update connection status
      chrome.storage.local.set({ connectionStatus: 'connected' });
      
      // Start heartbeat
      startHeartbeat();
      
      // Notify popup
      chrome.runtime.sendMessage({ type: 'connection-status', status: 'connected' }).catch(() => {});
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Received message:', message);

        // Handle different message types
        switch (message.type) {
          case 'party-created':
            chrome.storage.local.set({
              partyCode: message.partyCode,
              username: message.username,
              inParty: true
            });
            // Notify popup
            chrome.runtime.sendMessage({ type: 'party-created', data: message }).catch(() => {});
            break;

          case 'joined':
            chrome.storage.local.set({
              partyCode: message.partyCode,
              username: message.username,
              participants: message.participants,
              inParty: true
            });
            // Notify popup and content script
            chrome.runtime.sendMessage({ type: 'joined', data: message }).catch(() => {});
            notifyContentScript({ type: 'joined', data: message });
            break;

          case 'left':
            chrome.storage.local.set({
              partyCode: null,
              participants: [],
              inParty: false
            });
            chrome.runtime.sendMessage({ type: 'left' }).catch(() => {});
            notifyContentScript({ type: 'left' });
            break;

          case 'participants':
            chrome.storage.local.set({ participants: message.participants });
            chrome.runtime.sendMessage({ type: 'participants', data: message }).catch(() => {});
            // Forward to content script so it can update in-page overlay
            notifyContentScript({ type: 'participants', data: message });
            break;

          case 'sync':
            // Forward sync event to content script
            notifyContentScript({ type: 'sync', data: message });
            break;

          case 'video-info':
            chrome.storage.local.set({ videoInfo: message.data });
            chrome.runtime.sendMessage({ type: 'video-info', data: message }).catch(() => {});
            // Forward to content script so it knows the party's video URL
            notifyContentScript({ type: 'video-info', data: message });
            break;

          case 'error':
            console.error('Server error:', message.message);
            chrome.runtime.sendMessage({ type: 'error', message: message.message }).catch(() => {});
            break;

          case 'chat':
            // Forward chat message to popup
            chrome.runtime.sendMessage({ type: 'chat', data: message }).catch(() => {});
            break;

          case 'pong':
            // Heartbeat response received
            break;

          default:
            console.log('Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      chrome.storage.local.set({ connectionStatus: 'error' });
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      chrome.storage.local.set({ connectionStatus: 'disconnected' });
      chrome.runtime.sendMessage({ type: 'connection-status', status: 'disconnected' }).catch(() => {});
      
      stopHeartbeat();
      scheduleReconnect();
    };
  } catch (error) {
    console.error('Error creating WebSocket:', error);
    scheduleReconnect();
  }
}

// Disconnect from WebSocket server
function disconnect() {
  if (ws) {
    stopHeartbeat();
    ws.close();
    ws = null;
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectTimeout) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;

  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connect();
  }, delay);
}

// Start heartbeat
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }
  }, HEARTBEAT_INTERVAL);
}

// Stop heartbeat
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Send message to server
function sendToServer(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  } else {
    console.error('WebSocket not connected');
    return false;
  }
}

// Notify content script in the video tab (or active tab as fallback)
async function notifyContentScript(message) {
  try {
    // Try the tracked video tab first
    if (videoTabId) {
      try {
        await chrome.tabs.sendMessage(videoTabId, message);
        return;
      } catch (error) {
        console.log('Could not send to video tab, trying active tab');
        videoTabId = null;
      }
    }

    // Fall back to active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch((error) => {
        console.log('Could not send message to content script:', error);
      });
    }
  } catch (error) {
    console.log('Error notifying content script:', error);
  }
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);

  switch (message.type) {
    case 'connect':
      connect();
      sendResponse({ success: true });
      break;

    case 'disconnect':
      disconnect();
      sendResponse({ success: true });
      break;

    case 'create-party':
      if (sendToServer({ 
        type: 'create-party', 
        username: message.username,
        password: message.password,
        persistent: message.persistent
      })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'join-party':
      if (sendToServer({ 
        type: 'join', 
        partyCode: message.partyCode, 
        username: message.username,
        password: message.password
      })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'leave-party':
      if (sendToServer({ type: 'leave' })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'sync-event':
      // Track the tab that has the video
      if (sender.tab) {
        videoTabId = sender.tab.id;
      }
      if (sendToServer({ type: 'sync', action: message.action, data: message.data })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'video-info':
      // Track the tab that has the video
      if (sender.tab) {
        videoTabId = sender.tab.id;
      }
      if (sendToServer({ type: 'video-info', data: message.data })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'send-chat':
      if (sendToServer({ type: 'chat', message: message.message })) {
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;

    case 'get-status':
      chrome.storage.local.get(['connectionStatus', 'partyCode', 'username', 'participants', 'inParty', 'videoInfo'], (result) => {
        sendResponse({
          connectionStatus: result.connectionStatus || 'disconnected',
          partyCode: result.partyCode,
          username: result.username,
          participants: result.participants || [],
          inParty: result.inParty || false,
          videoInfo: result.videoInfo
        });
      });
      return true; // Keep channel open for async response

    default:
      console.log('Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return true; // Keep channel open for async response
});

// Initialize connection on startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Extension started');
  connect();
});

// Initialize connection when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed');
  // Set default server URL if not set
  chrome.storage.local.get(['serverUrl'], (result) => {
    if (!result.serverUrl) {
      chrome.storage.local.set({ serverUrl: 'ws://localhost:8080' });
    }
  });
  connect();
});

// Connect on initial load
connect();
