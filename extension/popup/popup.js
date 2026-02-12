// Popup script for Watch Party extension
document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const notInPartyView = document.getElementById('notInParty');
  const inPartyView = document.getElementById('inParty');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const errorMessage = document.getElementById('errorMessage');

  // Not in party elements
  const createUsernameInput = document.getElementById('createUsername');
  const createPasswordInput = document.getElementById('createPassword');
  const persistentCheckbox = document.getElementById('persistentCheckbox');
  const createPartyBtn = document.getElementById('createPartyBtn');
  const joinUsernameInput = document.getElementById('joinUsername');
  const partyCodeInput = document.getElementById('partyCodeInput');
  const joinPasswordInput = document.getElementById('joinPassword');
  const joinPartyBtn = document.getElementById('joinPartyBtn');
  const serverUrlInput = document.getElementById('serverUrl');
  const saveServerBtn = document.getElementById('saveServerBtn');

  // In party elements
  const partyCodeDisplay = document.getElementById('partyCodeDisplay');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const usernameDisplay = document.getElementById('usernameDisplay');
  const videoInfoSection = document.getElementById('videoInfoSection');
  const videoTitle = document.getElementById('videoTitle');
  const videoLink = document.getElementById('videoLink');
  const participantCount = document.getElementById('participantCount');
  const participantsList = document.getElementById('participantsList');
  const leavePartyBtn = document.getElementById('leavePartyBtn');

  // Load saved username from storage
  const savedData = await chrome.storage.local.get(['username', 'serverUrl']);
  if (savedData.username) {
    createUsernameInput.value = savedData.username;
    joinUsernameInput.value = savedData.username;
  }
  if (savedData.serverUrl) {
    serverUrlInput.value = savedData.serverUrl;
  } else {
    serverUrlInput.value = 'ws://localhost:8080';
  }

  // Update UI based on current status
  async function updateUI() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get-status' });
      
      // Update connection status
      updateConnectionStatus(response.connectionStatus);

      // Update view based on party status
      if (response.inParty && response.partyCode) {
        showInPartyView(response);
      } else {
        showNotInPartyView();
      }
    } catch (error) {
      console.error('Error updating UI:', error);
      showError('Failed to get status from extension');
    }
  }

  // Update connection status indicator
  function updateConnectionStatus(status) {
    statusDot.className = 'status-dot';
    
    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        break;
      case 'connecting':
        statusDot.classList.add('connecting');
        statusText.textContent = 'Connecting...';
        break;
      case 'disconnected':
      case 'error':
      default:
        statusText.textContent = 'Disconnected';
        break;
    }
  }

  // Show not in party view
  function showNotInPartyView() {
    notInPartyView.style.display = 'block';
    inPartyView.style.display = 'none';
  }

  // Show in party view
  function showInPartyView(data) {
    notInPartyView.style.display = 'none';
    inPartyView.style.display = 'block';

    // Update party info
    partyCodeDisplay.textContent = data.partyCode || '------';
    usernameDisplay.textContent = data.username || '-';

    // Update video info
    if (data.videoInfo && data.videoInfo.title) {
      videoInfoSection.style.display = 'block';
      videoTitle.textContent = data.videoInfo.title;
      if (data.videoInfo.url) {
        videoLink.href = data.videoInfo.url;
        videoLink.style.display = 'inline-block';
      } else {
        videoLink.style.display = 'none';
      }
    } else {
      videoInfoSection.style.display = 'none';
    }

    // Update participants list
    updateParticipantsList(data.participants || []);
  }

  // Update participants list with sync status indicators
  function updateParticipantsList(participants) {
    participantCount.textContent = participants.length;
    participantsList.innerHTML = '';

    participants.forEach(participant => {
      const li = document.createElement('li');

      // Handle both string format (legacy) and object format
      if (typeof participant === 'string') {
        li.textContent = participant;
      } else {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'participant-name';
        nameSpan.textContent = participant.username;

        const statusSpan = document.createElement('span');
        statusSpan.className = 'sync-indicator';

        if (!participant.videoUrl) {
          statusSpan.classList.add('no-video');
          statusSpan.title = 'No video detected';
        } else if (participant.synced) {
          statusSpan.classList.add('synced');
          statusSpan.title = 'Synced';
        } else {
          statusSpan.classList.add('not-synced');
          statusSpan.title = 'Watching different video';
        }

        li.appendChild(nameSpan);
        li.appendChild(statusSpan);
      }

      participantsList.appendChild(li);
    });
  }

  // Show error message
  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    setTimeout(() => {
      errorMessage.style.display = 'none';
    }, 5000);
  }

  // Create party
  createPartyBtn.addEventListener('click', async () => {
    const username = createUsernameInput.value.trim();
    const password = createPasswordInput.value.trim();
    const persistent = persistentCheckbox.checked;
    
    if (!username) {
      showError('Please enter your name');
      return;
    }

    createPartyBtn.disabled = true;
    createPartyBtn.textContent = 'Creating...';

    try {
      // Save username
      await chrome.storage.local.set({ username });

      const response = await chrome.runtime.sendMessage({
        type: 'create-party',
        username: username,
        password: password || null,
        persistent: persistent
      });

      if (response.success) {
        // Clear password field and checkbox
        createPasswordInput.value = '';
        persistentCheckbox.checked = false;
        // UI will be updated by message listener
      } else {
        showError(response.error || 'Failed to create party');
      }
    } catch (error) {
      console.error('Error creating party:', error);
      showError('Failed to create party. Is the server running?');
    } finally {
      createPartyBtn.disabled = false;
      createPartyBtn.textContent = 'Create Party';
    }
  });

  // Join party
  joinPartyBtn.addEventListener('click', async () => {
    const username = joinUsernameInput.value.trim();
    const partyCode = partyCodeInput.value.trim().toUpperCase();
    const password = joinPasswordInput.value.trim();

    if (!username) {
      showError('Please enter your name');
      return;
    }

    if (!partyCode || partyCode.length !== 6) {
      showError('Please enter a valid 6-character party code');
      return;
    }

    joinPartyBtn.disabled = true;
    joinPartyBtn.textContent = 'Joining...';

    try {
      // Save username
      await chrome.storage.local.set({ username });

      const response = await chrome.runtime.sendMessage({
        type: 'join-party',
        partyCode: partyCode,
        username: username,
        password: password || null
      });

      if (response.success) {
        // Clear password field
        joinPasswordInput.value = '';
        // UI will be updated by message listener
        partyCodeInput.value = '';
      } else {
        showError(response.error || 'Failed to join party');
      }
    } catch (error) {
      console.error('Error joining party:', error);
      showError('Failed to join party. Check the party code and try again.');
    } finally {
      joinPartyBtn.disabled = false;
      joinPartyBtn.textContent = 'Join Party';
    }
  });

  // Leave party
  leavePartyBtn.addEventListener('click', async () => {
    leavePartyBtn.disabled = true;
    leavePartyBtn.textContent = 'Leaving...';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'leave-party' });

      if (response.success) {
        showNotInPartyView();
      } else {
        showError(response.error || 'Failed to leave party');
      }
    } catch (error) {
      console.error('Error leaving party:', error);
      showError('Failed to leave party');
    } finally {
      leavePartyBtn.disabled = false;
      leavePartyBtn.textContent = 'Leave Party';
    }
  });

  // Copy party code
  copyCodeBtn.addEventListener('click', async () => {
    const code = partyCodeDisplay.textContent;
    
    try {
      await navigator.clipboard.writeText(code);
      copyCodeBtn.textContent = '✓';
      setTimeout(() => {
        copyCodeBtn.textContent = '📋';
      }, 2000);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      showError('Failed to copy party code');
    }
  });

  // Save server URL
  saveServerBtn.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim();

    if (!serverUrl) {
      showError('Please enter a server URL');
      return;
    }

    // Validate URL format
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      showError('Server URL must start with ws:// or wss://');
      return;
    }

    try {
      await chrome.storage.local.set({ serverUrl });
      
      // Reconnect with new URL
      await chrome.runtime.sendMessage({ type: 'disconnect' });
      await new Promise(resolve => setTimeout(resolve, 500));
      await chrome.runtime.sendMessage({ type: 'connect' });

      saveServerBtn.textContent = 'Saved!';
      setTimeout(() => {
        saveServerBtn.textContent = 'Save';
      }, 2000);
    } catch (error) {
      console.error('Error saving server URL:', error);
      showError('Failed to save server URL');
    }
  });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Popup received message:', message);

    switch (message.type) {
      case 'connection-status':
        updateConnectionStatus(message.status);
        break;

      case 'party-created':
      case 'joined':
        updateUI();
        break;

      case 'left':
        showNotInPartyView();
        break;

      case 'participants':
        updateParticipantsList(message.data.participants);
        break;

      case 'video-info':
        if (message.data.data && message.data.data.title) {
          videoInfoSection.style.display = 'block';
          videoTitle.textContent = message.data.data.title;
          if (message.data.data.url) {
            videoLink.href = message.data.data.url;
            videoLink.style.display = 'inline-block';
          } else {
            videoLink.style.display = 'none';
          }
        }
        break;

      case 'error':
        showError(message.message);
        break;
    }

    sendResponse({ success: true });
    return true;
  });

  // Auto-uppercase party code input
  partyCodeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // Initialize UI
  updateUI();
});
