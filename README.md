# 🎬 Watch Party

A Chrome extension that synchronizes video playback across multiple participants in real-time. Watch videos together with friends, no matter where they are!

## Features

- 🎥 **Real-time Synchronization**: Play, pause, seek, and rate changes are synced across all participants
- 👥 **Multi-participant Support**: Watch with 2 or more people simultaneously
- 🌐 **Multiple Platform Support**: Works with YouTube, Vimeo, Dailymotion, Twitch, Netflix, Amazon Prime Video, Disney+, and any HTML5 video
- 🔒 **Private Parties**: Create and join parties with unique 6-character codes
- 🔐 **Password Protection**: Optional password protection for parties
- 🏠 **Persistent Rooms**: Optional 24-hour persistence for party rooms
- 👥 **Participant List**: See who's watching with you
- 🎨 **Modern UI**: Beautiful dark-themed interface
- 🔄 **Auto-reconnect**: Automatic reconnection with exponential backoff
- ⚙️ **Configurable Server**: Set your own signaling server URL

## Supported Websites

- **YouTube** (youtube.com, including Shorts)
- **Vimeo** (vimeo.com)
- **Dailymotion** (dailymotion.com)
- **Twitch** (twitch.tv)
- **Netflix** (netflix.com)
- **Amazon Prime Video** (primevideo.com, amazon.com)
- **Disney+** (disneyplus.com)
- **Generic HTML5 video** - Any website with a `<video>` element

## How It Works

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   User 1    │         │   Server    │         │   User 2    │
│  (Creator)  │         │ (WebSocket) │         │  (Joiner)   │
└─────────────┘         └─────────────┘         └─────────────┘
       │                       │                       │
       │  1. Create Party      │                       │
       │──────────────────────>│                       │
       │  Party Code: ABC123   │                       │
       │<──────────────────────│                       │
       │                       │                       │
       │                       │  2. Join Party (ABC123)
       │                       │<──────────────────────│
       │  3. Participant List  │  Participant List     │
       │<──────────────────────│──────────────────────>│
       │                       │                       │
       │  4. User 1 plays video│                       │
       │──────────────────────>│                       │
       │                       │  5. Sync: play event  │
       │                       │──────────────────────>│
       │                       │   (Video plays for User 2)
       │                       │                       │
```

## Installation

### Server Setup

1. **Install Node.js** (v18 or later)

2. **Install dependencies**:
   ```bash
   cd server
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

   The server will run on `ws://localhost:8080` by default.

4. **Using Docker** (alternative):
   ```bash
   cd server
   docker build -t wparty-server .
   docker run -p 8080:8080 wparty-server
   ```

5. **Environment Variables**:
   - `PORT`: Server port (default: 8080)

### Chrome Extension Setup

1. **Open Chrome** and navigate to `chrome://extensions/`

2. **Enable Developer Mode** (toggle in the top right)

3. **Click "Load unpacked"**

4. **Select the `extension` folder** from this repository

5. **The Watch Party extension** should now appear in your extensions list

6. **Pin the extension** to your toolbar for easy access

## Usage

### Creating a Party

1. Click the Watch Party extension icon
2. Enter your name
3. Click "Create Party"
4. Share the 6-character party code with friends

### Joining a Party

1. Get the party code from your friend
2. Click the Watch Party extension icon
3. Enter your name
4. Enter the party code
5. Click "Join Party"

### Watching Together

1. Navigate to a supported video site (e.g., YouTube)
2. The extension will automatically detect the video
3. All playback controls (play, pause, seek, speed) are synced
4. The participant list shows who's currently watching

### Leaving a Party

1. Click the Watch Party extension icon
2. Click "Leave Party"

## Configuration

### Changing the Server URL

1. Click the Watch Party extension icon
2. In the settings section (visible when not in a party)
3. Enter your server URL (e.g., `wss://your-server.com`)
4. Click "Save"

## Development

### Project Structure

```
wparty/
├── extension/              # Chrome extension
│   ├── manifest.json      # Extension manifest (V3)
│   ├── popup/             # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── content/           # Content scripts
│   │   └── content.js
│   ├── background/        # Service worker
│   │   └── background.js
│   └── icons/             # Extension icons
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── server/                # WebSocket signaling server
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
├── README.md
└── LICENSE
```

### WebSocket Protocol

All messages are JSON with this structure:

```json
{
  "type": "message-type",
  "partyCode": "ABC123",
  "username": "User1",
  "action": "play|pause|seek|ratechange",
  "data": {
    "currentTime": 123.45,
    "playbackRate": 1.0
  },
  "participants": ["User1", "User2"],
  "timestamp": 1234567890
}
```

**Message Types**:
- `create-party`: Create a new party
- `join`: Join an existing party
- `leave`: Leave current party
- `sync`: Synchronize playback event
- `participants`: Updated participant list
- `video-info`: Video metadata update
- `party-created`: Party creation confirmation
- `joined`: Join confirmation
- `left`: Leave confirmation
- `error`: Error message
- `ping/pong`: Heartbeat

### Key Implementation Details

1. **Sync Loop Prevention**: The content script uses an `isSyncing` flag to prevent infinite sync loops when applying remote events.

2. **Time Drift Tolerance**: Only seeks if time difference exceeds 2 seconds to avoid micro-adjustments.

3. **Reconnection Logic**: Exponential backoff with a maximum delay of 30 seconds.

4. **Heartbeat**: Client sends ping every 25 seconds, server checks every 30 seconds.

5. **Party Codes**: 6 alphanumeric characters (uppercase), avoiding confusing characters like 0, O, I, 1.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Extension not detecting video
- Make sure the page has fully loaded
- Refresh the page after installing the extension
- Check if the site is in the supported list

### Cannot connect to server
- Verify the server is running
- Check the server URL in extension settings
- Ensure there's no firewall blocking the connection
- Check browser console for error messages

### Sync not working
- Verify all participants are in the same party
- Check that all participants are on the same video
- Ensure the video is an HTML5 video element

### Party code not working
- Party codes are case-sensitive (uppercase)
- Ensure the party creator's server is running
- The party may have been cleaned up if everyone left

## Security Considerations

- Party codes are randomly generated and should be kept private
- The server does not store video content, only metadata
- All synchronization happens through the signaling server
- No authentication is required (suitable for private/trusted groups)

## License

MIT License - see [LICENSE](LICENSE) file for details

## Acknowledgments

- Built with WebSocket for real-time communication
- Uses Chrome Extension Manifest V3
- Inspired by the need to watch videos together while apart

## Future Enhancements

- [x] Password-protected parties ✅
- [x] Persistent party rooms ✅
- [x] More streaming platform support (Netflix, Amazon Prime Video, Disney+) ✅
- [ ] Mobile app support
- [ ] Browser extension for Firefox and Edge

---

Made with ❤️ for watching together, even when apart.
