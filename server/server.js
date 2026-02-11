const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Store active parties/rooms
// Structure: { partyCode: { participants: Map(clientId -> {ws, username}), video: {url, title} } }
const parties = new Map();

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

// Get list of participant usernames in a party
function getParticipantList(partyCode) {
  const party = parties.get(partyCode);
  if (!party) return [];
  return Array.from(party.participants.values()).map(client => client.username);
}

// Clean up empty parties
function cleanupEmptyParty(partyCode) {
  const party = parties.get(partyCode);
  if (party && party.participants.size === 0) {
    parties.delete(partyCode);
    console.log(`Party ${partyCode} cleaned up (empty)`);
  }
}

// Create WebSocket server
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', (ws) => {
  let clientId = uuidv4();
  let currentPartyCode = null;
  let username = null;
  let isAlive = true;

  console.log(`New connection: ${clientId}`);

  // Heartbeat mechanism
  ws.on('pong', () => {
    isAlive = true;
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
          
          parties.set(partyCode, {
            participants: new Map([[clientId, { ws, username }]]),
            video: null
          });

          currentPartyCode = partyCode;

          ws.send(JSON.stringify({
            type: 'party-created',
            partyCode,
            username,
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
          parties.get(joinPartyCode).participants.set(clientId, { ws, username });

          // Send join confirmation to the client
          ws.send(JSON.stringify({
            type: 'joined',
            partyCode: joinPartyCode,
            username,
            participants: getParticipantList(joinPartyCode),
            video: parties.get(joinPartyCode).video,
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
            parties.get(currentPartyCode).video = message.data;
            
            broadcastToAllInParty(currentPartyCode, {
              type: 'video-info',
              data: message.data,
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
