# Quick Installation Guide

## Server Setup (5 minutes)

### Option 1: Direct Node.js
```bash
cd server
npm install
npm start
```
Server will be available at `ws://localhost:8080`

### Option 2: Docker
```bash
cd server
docker build -t wparty-server .
docker run -p 8080:8080 wparty-server
```

## Chrome Extension Setup (2 minutes)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Navigate to and select the `extension` folder
5. The Watch Party extension should now appear
6. Pin it to your toolbar (optional but recommended)

## First Use

1. Make sure the server is running
2. Click the Watch Party extension icon
3. Verify the status shows "Connected" (green dot)
4. You're ready to create or join a party!

## Testing with Multiple Users

### Single Computer (Easiest)
1. Open multiple Chrome windows
2. Load the extension in each
3. Create a party in one window
4. Join with the party code in other windows

### Multiple Computers (Real scenario)
1. Run server on a computer accessible to all users
2. Configure server URL in extension settings
3. Share the party code with friends
4. Start watching together!

## Troubleshooting

**"Disconnected" status**
- Check if server is running: `ps aux | grep "node server.js"`
- Verify server URL in extension settings
- Check firewall/network settings

**Video not syncing**
- Refresh the video page
- Make sure all users are in the same party
- Check browser console for errors (F12)

**Extension not loading**
- Verify all files are in the extension folder
- Check for JavaScript errors in chrome://extensions/
- Try reloading the extension

## Need Help?

Check the full README.md for detailed documentation.
