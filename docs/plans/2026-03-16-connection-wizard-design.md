# Connection Wizard Design

## Goal

Replace the current single-form profile creation with a step-by-step wizard that validates SSH and Gateway connectivity before saving.

## Problem

Current flow: fill form → save → navigate to detail → click connect → discover config errors (wrong username, unreachable host, bad token). The feedback loop is too long.

## Solution: 3-Step Wizard

### Step 1: SSH Connection

- Fields: Host, User, Key Path (default `~/.ssh/id_rsa`)
- "Test Connection" button → Rust backend attempts SSH connect (10s timeout)
- Success: green checkmark, "Next" button unlocks
- Failure: red error message (e.g., "Permission denied", "Host unreachable"), user fixes and retries
- Cannot proceed without passing SSH test

### Step 2: Gateway Configuration

- On enter: auto-read remote `~/.openclaw/openclaw.json` via SSH `cat` command
- Success: Token and Port auto-filled, shown as read-only with green checkmark
- Failure: manual input fields for Token (Port defaults from Step 1 key path)
- "Test Gateway" button → establish SSH tunnel + connect WebSocket + authenticate Token
- WS test must pass to proceed

### Step 3: Name & Save

- Profile name input (default: `user@host`)
- "Save" button creates profile and switches it to active

## Backend Commands

### `test_ssh_connection`

```
Input: host: String, user: String, key_path: Option<String>
Flow: Create SSH session → authenticate → disconnect immediately
Output: Ok(()) | Err(description)
Timeout: 10s
```

### `read_remote_gateway_config`

```
Input: host: String, user: String, key_path: Option<String>
Flow: SSH connect → exec "cat ~/.openclaw/openclaw.json" → parse JSON → extract token + port
Output: Ok({ token: String, port: u16 }) | Err(description)
Reuses: existing SSH library from connect()
```

WS test reuses existing `connect()` command — Step 2 Gateway test is effectively a real connection attempt.

## Frontend Changes

### New: `ProfileWizard.tsx` (replaces `NewProfileForm.tsx`)

- Internal `step` state: `1 | 2 | 3`
- Each step: input fields + test button + status feedback (idle/testing/success/error)
- Bottom nav: `[Cancel] [← Back] [Next →]` (disabled based on step + validation)
- Step 2 auto-triggers remote config read on mount

### Modified: `ConnectionPage.tsx`

- Replace `<NewProfileForm>` with `<ProfileWizard>`, same props

### Unchanged

- ProfileDetail, ProfileSidebar, stores, backend connect()

## i18n Keys

```
wizard.step1_title: "SSH 连接"
wizard.step2_title: "Gateway 配置"
wizard.step3_title: "命名保存"
wizard.test_ssh: "测试连接"
wizard.test_gateway: "测试 Gateway"
wizard.testing: "测试中..."
wizard.ssh_success: "SSH 连接成功"
wizard.ssh_failed: "SSH 连接失败：{{msg}}"
wizard.reading_config: "正在读取远程配置..."
wizard.config_read_success: "Token 已自动获取"
wizard.config_read_failed: "未读取到配置，请手动输入"
wizard.ws_success: "Gateway 连接成功"
wizard.ws_failed: "Gateway 连接失败：{{msg}}"
wizard.next: "下一步"
wizard.back: "上一步"
wizard.profile_name: "配置名称"
wizard.default_name: "{{user}}@{{host}}"
```
