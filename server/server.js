const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const PARTY_IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MS_TO_HOURS = 1000 * 60 * 60; // Conversion constant from milliseconds to hours

// Store active parties/rooms
// Structure: { partyCode: { participants: Map(clientId -> {ws, username}), video: {url, title}, passwordHash: string|null, persistent: boolean, createdAt: number, lastActivity: number } }
const parties = new Map();

// Hash password using SHA-256
function hashPassword(password) {
  if (!password) return null;
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Generate a short, human-readable party code
function generatePartyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars like 0, O, I, 1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Broadcast message to all participants in a party except sender
function broadcastToParty(partyCode, message, senderId = null) {
  const party = parties.get(partyCode);
  if (!party) return;

  party.participants.forEach((client, clientId) => {
    if (clientId !== senderId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Send message to all participants in a party including sender
function broadcastToAllInParty(partyCode, message) {
  const party = parties.get(partyCode);
  if (!party) return;

  party.participants.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Get list of participants in a party with sync status
function getParticipantList(partyCode) {
  const party = parties.get(partyCode);
  if (!party) return [];
  const partyVideoUrl = party.video ? party.video.url : null;
  return Array.from(party.participants.values()).map(client => ({
    username: client.username,
    videoUrl: client.videoUrl || null,
    synced: partyVideoUrl ? (client.videoUrl === partyVideoUrl) : false
  }));
}

// Clean up empty parties
function cleanupEmptyParty(partyCode) {
  const party = parties.get(partyCode);
  if (party && party.participants.size === 0) {
    // If party is persistent, update last activity but don't delete
    if (party.persistent) {
      party.lastActivity = Date.now();
      console.log(`Persistent party ${partyCode} is now empty (last activity updated)`);
    } else {
      parties.delete(partyCode);
      console.log(`Party ${partyCode} cleaned up (empty)`);
    }
  }
}

// Clean up idle persistent parties (runs periodically)
function cleanupIdleParties() {
  const now = Date.now();
  for (const [partyCode, party] of parties.entries()) {
    if (party.persistent && party.participants.size === 0) {
      const idleTime = now - party.lastActivity;
      if (idleTime > PARTY_IDLE_TIMEOUT) {
        parties.delete(partyCode);
        const idleHours = Math.round(idleTime / MS_TO_HOURS);
        console.log(`Persistent party ${partyCode} cleaned up (idle for ${idleHours} hours)`);
      }
    }
  }
}

// Run cleanup every hour
setInterval(cleanupIdleParties, 60 * 60 * 1000);

// Create WebSocket server
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', (ws) => {
  let clientId = uuidv4();
  let currentPartyCode = null;
  let username = null;
  ws.isAlive = true;

  console.log(`New connection: ${clientId}`);

  // Heartbeat mechanism
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const timestamp = Date.now();

      switch (message.type) {
        case 'create-party':
          // Create a new party
          const partyCode = generatePartyCode();
          username = message.username || 'Anonymous';
          const passwordHash = hashPassword(message.password);
          const persistent = message.persistent || false;
          
          parties.set(partyCode, {
            participants: new Map([[clientId, { ws, username, videoUrl: null }]]),
            video: null,
            passwordHash: passwordHash,
            persistent: persistent,
            createdAt: timestamp,
            lastActivity: timestamp
          });

          currentPartyCode = partyCode;

          ws.send(JSON.stringify({
            type: 'party-created',
            partyCode,
            username,
            hasPassword: !!passwordHash,
            persistent: persistent,
            timestamp
          }));

          console.log(`Party created: ${partyCode} by ${username}`);
          break;

        case 'join':
          // Join an existing party
          const joinPartyCode = message.partyCode;
          username = message.username || 'Anonymous';

          if (!parties.has(joinPartyCode)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Party not found',
              timestamp
            }));
            break;
          }

          // Check password if party is password-protected
          const party = parties.get(joinPartyCode);
          if (!party) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Party not found',
              timestamp
            }));
            break;
          }
          
          if (party.passwordHash) {
            const providedPasswordHash = hashPassword(message.password);
            if (providedPasswordHash !== party.passwordHash) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Incorrect password',
                timestamp
              }));
              break;
            }
          }

          // Remove from previous party if any
          if (currentPartyCode && parties.has(currentPartyCode)) {
            parties.get(currentPartyCode).participants.delete(clientId);
            broadcastToAllInParty(currentPartyCode, {
              type: 'participants',
              participants: getParticipantList(currentPartyCode),
              timestamp
            });
            cleanupEmptyParty(currentPartyCode);
          }

          // Add to new party
          currentPartyCode = joinPartyCode;
          const joinedParty = parties.get(joinPartyCode);
          joinedParty.participants.set(clientId, { ws, username, videoUrl: null });
          joinedParty.lastActivity = timestamp; // Update last activity time

          // Send join confirmation to the client
          ws.send(JSON.stringify({
            type: 'joined',
            partyCode: joinPartyCode,
            username,
            participants: getParticipantList(joinPartyCode),
            video: joinedParty.video,
            timestamp
          }));

          // Broadcast updated participant list to all
          broadcastToAllInParty(joinPartyCode, {
            type: 'participants',
            participants: getParticipantList(joinPartyCode),
            timestamp
          });

          console.log(`${username} joined party ${joinPartyCode}`);
          break;

        case 'leave':
          // Leave current party
          if (currentPartyCode && parties.has(currentPartyCode)) {
            parties.get(currentPartyCode).participants.delete(clientId);
            
            broadcastToAllInParty(currentPartyCode, {
              type: 'participants',
              participants: getParticipantList(currentPartyCode),
              timestamp
            });

            cleanupEmptyParty(currentPartyCode);
            console.log(`${username} left party ${currentPartyCode}`);
            currentPartyCode = null;
          }

          ws.send(JSON.stringify({
            type: 'left',
            timestamp
          }));
          break;

        case 'sync':
          // Relay sync events to other participants
          if (!currentPartyCode) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Not in a party',
              timestamp
            }));
            break;
          }

          broadcastToParty(currentPartyCode, {
            type: 'sync',
            action: message.action,
            data: message.data,
            username: username,
            timestamp
          }, clientId);

          console.log(`Sync event (${message.action}) from ${username} in party ${currentPartyCode}`);
          break;

        case 'video-info':
          // Update video information for the party
          if (currentPartyCode && parties.has(currentPartyCode)) {
            const party = parties.get(currentPartyCode);
            party.video = message.data;
            
            // Update this participant's video URL
            const participant = party.participants.get(clientId);
            if (participant) {
              participant.videoUrl = message.data.url || null;
            }
            
            // Broadcast video info to other participants (sender already has this info)
            broadcastToParty(currentPartyCode, {
              type: 'video-info',
              data: message.data,
              username: username,
              timestamp
            }, clientId);

            // Broadcast updated participant list with sync status to all (including sender)
            broadcastToAllInParty(currentPartyCode, {
              type: 'participants',
              participants: getParticipantList(currentPartyCode),
              timestamp
            });
          }
          break;

        case 'ping':
          // Respond to ping
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp
          }));
          break;

        default:
          console.log(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        timestamp: Date.now()
      }));
    }
  });

  ws.on('close', () => {
    console.log(`Connection closed: ${clientId}`);
    
    // Remove from party
    if (currentPartyCode && parties.has(currentPartyCode)) {
      parties.get(currentPartyCode).participants.delete(clientId);
      
      broadcastToAllInParty(currentPartyCode, {
        type: 'participants',
        participants: getParticipantList(currentPartyCode),
        timestamp: Date.now()
      });

      cleanupEmptyParty(currentPartyCode);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientId}:`, error);
  });
});

// Heartbeat interval to detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  wss.close(() => {
    console.log('WebSocket server closed');
    process.exit(0);
  });
});
