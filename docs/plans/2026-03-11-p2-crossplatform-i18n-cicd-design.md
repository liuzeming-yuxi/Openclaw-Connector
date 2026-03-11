# P2 Design: Cross-Platform, i18n, CI/CD

## Overview

Three P2 features for OpenClaw Connector:
1. **Cross-Platform** — Remove macOS-only code, support Windows & Linux
2. **i18n** — Chinese + English, user-selectable, default Chinese
3. **CI/CD** — Expand check workflow to cover all platforms

---

## Feature 1: Cross-Platform Support

### Problem
5 locations in the Rust backend have macOS-only code: Chrome binary paths, `lsof` for port killing, `open` for URL launching, hardcoded `"darwin"` platform string, and default node name containing "(macOS)".

### Approach
Runtime OS detection (`std::env::consts::OS`) + `#[cfg(target_os)]` conditional compilation where needed.

### Changes

| File | Current | Fix |
|------|---------|-----|
| `browser.rs` `find_chrome_binary()` | macOS `/Applications/...` only | `#[cfg()]` per-OS candidate paths |
| `ssh_tunnel.rs` `kill_port_holder()` | `lsof` only | macOS/Linux: `lsof`, Windows: `netstat`+`taskkill` |
| `lib.rs` `open_url()` | `Command::new("open")` | Use `open` crate (cross-platform) |
| `ws_client.rs` ×3 | `"darwin"` hardcoded | `std::env::consts::OS` |
| `config.rs` | `"(macOS)"` default name | Dynamic OS name |

### Non-goals
- Platform-specific UI adjustments (title bar, window chrome)
- Platform-specific installer configuration (handled by Tauri defaults)

---

## Feature 2: i18n (Chinese + English)

### Problem
All UI strings are hardcoded Chinese in JSX. Backend error messages also contain Chinese.

### Approach
`react-i18next` with JSON translation files. Minimal setup: namespace per feature area.

### Design

**Structure:**
- `src/i18n/index.ts` — i18next init, default language: `"zh"`
- `src/i18n/zh.json` — Chinese translations (extract from current code)
- `src/i18n/en.json` — English translations
- `src/store/useThemeStore.ts` — (no change, language separate from theme)

**Language store:** Reuse the same pattern as theme — Zustand + localStorage key `openclaw-lang`.

**Frontend:** Replace all hardcoded strings with `t("key")` calls.

**Backend Rust:** Keep error messages in English. Frontend maps error codes/messages to localized display where needed. The 2 Chinese strings in `lib.rs` (tunnel reconnect messages) will be changed to English event codes, with frontend doing the translation.

**Toggle:** Language switcher in header next to theme toggle.

### Non-goals
- RTL support
- Pluralization rules (Chinese/English don't need complex plurals)
- Backend i18n (keep Rust strings in English)

---

## Feature 3: CI/CD Expansion

### Problem
`check.yml` only runs backend checks on Ubuntu. Cross-platform code changes won't be validated until release time.

### Approach
Expand `check.yml` cargo check/clippy matrix to include macOS and Windows runners.

### Changes

**check.yml:**
- Backend job: matrix `[ubuntu-latest, macos-latest, windows-latest]`
- Cargo clippy + cargo test on all 3 platforms
- Frontend job: stays ubuntu-only (platform-independent)

**release.yml:**
- Already builds for all platforms — verify it still works after cross-platform code changes
- No structural changes needed

### Non-goals
- Code signing (macOS notarization, Windows Authenticode)
- Nightly builds
- Integration tests in CI

---

## Execution Order

1. Cross-platform code changes (prerequisite for CI)
2. CI/CD expansion (validates cross-platform code)
3. i18n (independent feature)
