# OpenClaw Connector (macOS MVP)

Desktop connector built with Tauri 2 + React.

## MVP Features

- Single-server SSH tunnel profile.
- Gateway heartbeat status model.
- Per-agent local node bindings.
- Remote task execution pipeline (`system.run`).
- Emergency disconnect kill switch.

## Development

```bash
pnpm install
pnpm test
pnpm dev
```

## Rust tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
