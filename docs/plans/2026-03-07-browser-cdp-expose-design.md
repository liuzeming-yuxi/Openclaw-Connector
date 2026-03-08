# Browser CDP Expose — Design

## Goal

Let remote OpenClaw agents control the user's local browser by exposing Chrome's DevTools Protocol (CDP) port through the existing SSH tunnel. The Connector itself does NOT implement any CDP automation — it only manages Chrome lifecycle and network tunneling. Third-party tools/skills connect to the exposed CDP endpoint directly.

## Architecture

```
Agent (remote server)
  │ connects to localhost:19222
  ▼
SSH reverse tunnel (remote 19222 → local 9222)
  │
  ▼
Mac local Chrome (--remote-debugging-port=9222)
```

## Components

### 1. Browser Manager (`browser.rs`)

Responsibilities:
- Start Chrome with `--remote-debugging-port=<port>` flag
- Detect Chrome binary location on macOS (`/Applications/Google Chrome.app/...`)
- Check if a Chrome debug instance is already running (probe `http://localhost:<port>/json/version`)
- Stop the managed Chrome instance
- Report status (running, port, PID)

Does NOT:
- Send any CDP commands
- Implement screenshot/click/navigate
- Manage tabs or pages

### 2. SSH Tunnel Extension (`ssh_tunnel.rs`)

Add support for additional reverse port forwards on the existing SSH connection:
- Currently: one reverse tunnel for Gateway WebSocket
- New: ability to add a second reverse tunnel for CDP port
- Reuse the same SSH process (add `-R` flag) or spawn a supplementary tunnel

### 3. Tauri Commands (`lib.rs`)

New commands:
- `start_browser { cdpPort?, remotePort? }` — launch Chrome + start CDP tunnel
- `stop_browser` — kill Chrome + tear down CDP tunnel
- `get_browser_status` — returns `{ running, cdpPort, remotePort, pid? }`

### 4. UI (ConnectionPage.tsx)

New "Browser" card (visible when SSH connected):
- CDP port input (default 9222)
- Remote mapped port input (default 19222)
- Start / Stop button
- Status indicator (Chrome running + tunnel active)
- Option to notify selected sessions about CDP availability via `chat.inject`

## Data Flow

1. User clicks "Start Browser" in Connector UI
2. Connector launches Chrome with `--remote-debugging-port=9222`
3. Connector verifies Chrome is responding on CDP port
4. Connector adds reverse SSH tunnel: `remote:19222 → local:9222`
5. User optionally injects a message to selected sessions:
   `"[System] Browser CDP available at localhost:19222. Use Chrome DevTools Protocol to control the browser."`
6. Agent's third-party tool connects to `ws://localhost:19222/devtools/...`

## Configuration

Add to `AppConfig`:
```
cdpPort: number      // default 9222
cdpRemotePort: number // default 19222
```

## What We Don't Do

- No CDP command proxying through WebSocket
- No node capability declaration for browser (not needed — agents use CDP directly via tunnel)
- No Playwright/Puppeteer dependency
- No headless mode management (user decides)

## Security Considerations

- CDP gives full control over the browser. The SSH tunnel + Gateway token are the security boundary.
- Chrome with `--remote-debugging-port` only binds to `127.0.0.1` by default — no external exposure on the Mac side.
- The remote port is also on `localhost` of the server — only accessible to processes on that machine.
