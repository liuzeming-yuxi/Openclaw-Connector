# OpenClaw Connector

[简体中文](README.zh-CN.md) | English

A macOS desktop app that connects your local machine to [OpenClaw](https://github.com/openclaw/openclaw) gateway via SSH tunnel, enabling AI agents to interact with your local environment.

![Screenshot](docs/images/screenshot.png)

## Why OpenClaw Connector?

[OpenClaw](https://github.com/openclaw/openclaw) agents run on your server, but often need to interact with your **local environment** — running commands, controlling browsers, accessing local files.

OpenClaw Connector solves two problems:

1. **Bridging server and local** — It creates a secure tunnel between OpenClaw agents and your local machine, so agents can execute tasks on your computer as if they were sitting next to you.

2. **Secure gateway access** — The OpenClaw gateway should never be exposed to the public internet. This app lets you access it securely from your local machine through an encrypted SSH tunnel — no open ports, no public URLs.

## Features

- **SSH Tunnel** — Secure reverse tunnel to your Linux gateway with auto-reconnect
- **Agent Bindings** — Bind AI agents to your local node for remote task execution
- **Browser CDP** — Expose local Chrome browser to agents via Chrome DevTools Protocol
- **Session Management** — Notify agents across chat sessions with one click
- **Device Identity** — Ed25519 keypair for secure device authentication
- **Emergency Disconnect** — One-click kill switch to instantly sever all connections

## Quick Start

### Prerequisites

- **macOS** 12+
- **Node.js** 18+ and [pnpm](https://pnpm.io/)
- **Rust** toolchain ([rustup](https://rustup.rs/))
- A running OpenClaw gateway on a remote Linux server

### Install & Run

```bash
# Clone the repo
git clone https://github.com/liuzeming-yuxi/Openclaw-Connector.git
cd Openclaw-Connector

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

### Build for Production

```bash
pnpm tauri build
```

The `.app` bundle will be generated in `src-tauri/target/release/bundle/macos/`.

> **New to OpenClaw?** See the [User Guide](docs/guide.md) for detailed setup instructions and parameter explanations.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 19 + TypeScript + Tailwind CSS 4 |
| State Management | Zustand 5 |
| Backend | Rust (Tokio async runtime) |
| Tunnel | SSH reverse port forwarding |
| Browser Automation | Chrome DevTools Protocol (CDP) |

## Project Structure

```
├── src/                    # React frontend
│   ├── pages/              # Page components
│   ├── components/ui/      # Reusable UI components
│   ├── store/              # Zustand state stores
│   └── types/              # TypeScript type definitions
├── src-tauri/              # Rust backend
│   └── src/
│       ├── lib.rs          # Tauri command handlers
│       ├── ssh_tunnel.rs   # SSH tunnel management
│       ├── browser.rs      # Chrome CDP lifecycle
│       ├── ws_client.rs    # WebSocket client
│       ├── config.rs       # Configuration persistence
│       ├── health.rs       # Gateway health monitoring
│       └── device_identity.rs  # Ed25519 device keys
├── docs/                   # Documentation
└── package.json
```

## Development

```bash
# Run frontend + backend in dev mode
pnpm tauri dev

# Run frontend tests
pnpm test

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Type check
pnpm build
```

## Roadmap

- [ ] Cross-platform support (Windows & Linux)
- [ ] Multi-language UI (i18n)
- [ ] Theme switching (Light / Dark mode)
- [ ] OpenClaw health check & auto-repair
- [ ] Browser automation beyond Chrome (Firefox, Edge, etc.)
- [ ] Comprehensive CI/CD pipeline
- [ ] PR-level CI checks (lint, test, clippy)
- [ ] Architecture / sequence diagram
- [ ] Safer port management (avoid killing unrelated processes)
- [ ] Operator WebSocket graceful shutdown on disconnect
- [ ] Unified config source of truth (frontend vs backend)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=liuzeming-yuxi/Openclaw-Connector&type=Date)](https://star-history.com/#liuzeming-yuxi/Openclaw-Connector&Date)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
