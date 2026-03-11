# Friction Chrome Extension

Capture learning moments from any page and generate reports in the Friction web app.

## Features
- Capture selected text as a moment
- Side panel to view findings and manage status
- Connects to local or production backend
- Keyboard shortcut: `Alt+M`

## Quick Start (Local)
1. Open `config.js` and set `ENV = 'local'`.
2. Start backend on `http://localhost:4000` and web app on `http://localhost:3000`.
3. In Chrome, open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this `extension` folder.

## Quick Start (Production)
1. Open `config.js` and set `ENV = 'production'`.
2. Load the extension as above.
3. Click **Login** in the web app to get a token.
4. In the extension, click **Connect** and paste the token.

## Keyboard Shortcut
- Default: `Alt+M`
- Change in `chrome://extensions/shortcuts`.

## Permissions
- `storage`: save auth token and preferences
- `tabs`, `activeTab`, `scripting`: capture selected text
- `sidePanel`: open the side panel UI

## Troubleshooting
- **No data / unauthorized**: re-login and re-paste token in the extension.
- **Local API not reachable**: ensure backend is running on `localhost:4000` and `ENV = 'local'`.
- **Side panel empty**: click refresh and confirm you have recent moments.

## Files
- `popup.html`, `popup.js`, `popup.css`: popup UI
- `sidepanel.html`, `sidepanel.js`: side panel UI
- `background.js`: service worker
- `config.js`: environment routing
- `manifest.json`: extension configuration
