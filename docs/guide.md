# User Guide

[简体中文](guide.zh-CN.md) | English

This guide walks you through setting up OpenClaw Connector from scratch. No prior knowledge of SSH tunnels or AI agent infrastructure is required.

## Before You Start

You need two things ready before using OpenClaw Connector:

### 1. A server running OpenClaw gateway

OpenClaw Connector is a **client** — it connects to an [OpenClaw](https://github.com/openclaw/openclaw) gateway running on a remote Linux server. You (or your team admin) must install and configure the gateway first.

> If you haven't set up the gateway yet, see the [OpenClaw documentation](https://github.com/openclaw/openclaw).

### 2. SSH access to the server

Your local machine must be able to connect to the server via SSH. To verify:

```bash
ssh your-username@your-server-ip
```

If this command logs you into the server, you're good. If not, you'll need to:
- Get the server's IP address and your SSH credentials from the admin
- Set up an SSH key pair (see [GitHub's SSH guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent))

## Configuration Parameters

When you open the app, you'll see a connection form. Here's what each field means:

### Connection Settings

| Parameter | What it is | How to find it | Example |
|-----------|-----------|----------------|---------|
| **Host** | The IP address or domain name of your Linux server | Ask your server admin, or check your cloud provider dashboard | `203.0.113.50` or `my-server.example.com` |
| **User** | The SSH username for logging into the server | Same username you use with `ssh user@host` | `root`, `ubuntu`, `deploy` |
| **Key Path** | Path to your SSH private key on your Mac | Usually in `~/.ssh/`. If you're unsure, run `ls ~/.ssh/` in Terminal | `~/.ssh/id_ed25519` or `~/.ssh/id_rsa` |
| **Gateway Token** | Authentication token for the OpenClaw gateway | Found in the gateway's configuration file on the server, look for `gateway.auth.token` | A long string like `sk-abc123...` |

### Port Settings

| Parameter | What it is | Default | When to change |
|-----------|-----------|---------|----------------|
| **Remote Port** | The port where OpenClaw gateway is listening on the server | `18789` | Only if your admin configured a different port |
| **Local Port** | The port mapped to your local machine via SSH tunnel | `18789` | Only if the port is already in use locally |

> **Tip:** In most cases, keep both ports the same. The app creates an SSH tunnel that maps the remote port to your local machine, so you can access the gateway as if it were running locally.

### Other Settings

| Parameter | What it is | Default |
|-----------|-----------|---------|
| **Node Name** | A friendly name for your local machine, shown to AI agents | Auto-generated |

## Connecting Step by Step

1. **Fill in the form** — Enter your server's host, username, key path, and gateway token
2. **Click "Connect"** — The app will establish an SSH tunnel to your server
3. **Check the status badge** — It should show a green "Connected" indicator
4. **Open the management console** (optional) — Click "Management Console" to access the gateway web UI in your browser

## Browser Automation (CDP)

This is an **optional** feature that lets AI agents control your local Chrome browser.

### What is CDP?

CDP (Chrome DevTools Protocol) is the same technology that browser developer tools use. When enabled, AI agents can:
- Open web pages
- Click buttons and fill forms
- Take screenshots
- Extract page content

### CDP Settings

| Parameter | What it is | Default |
|-----------|-----------|---------|
| **CDP Port (Local)** | The port Chrome listens on for automation commands | `9222` |
| **Remote Port** | The port mapped to the server so agents can reach your browser | `19222` |

### How to use it

1. Click "Start Browser" — Chrome opens with a dedicated profile for automation
2. The agent can now control this Chrome window through CDP

> **Note:** This opens a separate Chrome instance with its own profile. It won't affect your regular Chrome browser.

## Session Notifications

After connecting, you can notify AI agents about your local node:

1. Expand an agent in the "Session Injection" card
2. Click "Notify" next to a session — the agent will receive a system message with your node info
3. The agent can then execute commands on your local machine

## Troubleshooting

### "Connection failed"

- Verify SSH works: run `ssh -i ~/.ssh/your_key user@host` in Terminal
- Check that the key path in the app matches your actual SSH key location
- Make sure the server's SSH port (22) is accessible from your network

### "Can't find Gateway Token"

SSH into your server and check the OpenClaw gateway config file. Look for a field like `gateway.auth.token` or similar. Ask your admin if unsure.

### "Status shows connected but console won't open"

- Make sure the local port isn't occupied by another application
- Try changing the local port to a different number (e.g., `18790`)

### "Browser won't start"

- Make sure Google Chrome is installed on your Mac
- If Chrome is already running, the CDP browser opens as a separate instance — this is normal
