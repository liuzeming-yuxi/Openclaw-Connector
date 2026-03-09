# Security

[简体中文](SECURITY.zh-CN.md) | English

OpenClaw Connector bridges remote AI agents with your local machine. This means agents **can execute commands on your computer and control your browser**. Understanding the security model is essential before use.

## What This App Can Do

### Local Command Execution

When connected, OpenClaw agents can execute **arbitrary shell commands** on your machine through the `system.run` action. This is by design — it's how agents interact with your local environment.

- Commands run with **your user's permissions** (not root, unless you're logged in as root)
- There is no built-in allowlist or sandbox — any command your user can run, agents can run
- Command output (stdout/stderr) is sent back to the agent

### Browser Automation (CDP)

When Browser CDP is enabled, agents can:

- Open and navigate web pages
- Click, type, and interact with page elements
- Take screenshots
- Read page content and cookies from the CDP browser instance

This only affects the **dedicated CDP Chrome instance** — not your regular browser.

## Security Design

### SSH Tunnel (Encrypted Transport)

All communication between your Mac and the server goes through an **encrypted SSH tunnel**. No data is transmitted in plaintext.

- The OpenClaw gateway is **never exposed to the public internet**
- Only your machine, via SSH tunnel, can access the gateway
- The tunnel uses your existing SSH key for authentication

### Device Identity (Ed25519)

Each Connector instance generates a unique **Ed25519 keypair** on first launch. This provides:

- Cryptographic device identity
- Prevention of device impersonation

### Emergency Disconnect

The one-click emergency disconnect:

- **Kills the SSH tunnel** immediately
- **Terminates all Chrome CDP processes**
- **Stops the WebSocket connection** to the gateway
- After disconnect, agents can no longer reach your machine

## Recommendations

### SSH Key Best Practices

- Use a **dedicated SSH key** for the Connector, not your personal key
- Consider restricting the key on the server side (`ForceCommand`, `AllowTcpForwarding`)
- Use Ed25519 keys over RSA for better security

### Gateway Token

- The Gateway Token is stored locally in `~/Library/Application Support/ai.openclaw.connector/connector-config.json`
- Treat it like a password — do not share it or commit it to version control
- Rotate the token periodically on the server

### Network Considerations

- Only connect to servers you trust
- Be aware that agents can access any local network resource your machine can reach
- If you're on a corporate network, understand the implications before connecting

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

- **Do NOT** open a public GitHub issue
- Email the maintainer directly or use [GitHub's private vulnerability reporting](https://github.com/liuzeming-yuxi/Openclaw-Connector/security/advisories/new)

We will acknowledge receipt within 48 hours and work on a fix.
