# Diagnostic Log Export — Design

## Goal

用户遇到问题时，点一个按钮即可导出诊断日志文件（JSON），发送给开发者进行远程排查。

## Architecture

在 ProfileDetail 页面右上角增加一个导出按钮。点击后：

1. 前端调用 Rust 命令 `export_diagnostics` 获取后端诊断数据（连接状态、健康摘要、App 版本、OS 信息）
2. 前端拼合后端数据 + Activity Log 事件 + 当前 Profile 配置（脱敏）→ JSON
3. 使用 Tauri `dialog.save` 弹出保存对话框，用户选择保存路径
4. 写入 `.json` 文件

## Exported Data

```json
{
  "exported_at": "2026-03-16T12:00:00Z",
  "app_version": "0.3.0",
  "os": "macOS 15.3",
  "arch": "aarch64",
  "profile": {
    "name": "root@192.168.16.72",
    "host": "192.168.16.72",
    "user": "root",
    "remotePort": 18789,
    "localPort": 18789,
    "token": "***"
  },
  "connection": {
    "tunnelState": "connected",
    "tunnelReconnectAttempts": 0,
    "tunnelLastError": null,
    "wsConnected": true
  },
  "health": {
    "status": "online",
    "latencyMs": 42,
    "consecutiveFailures": 0
  },
  "activity_log": [
    { "timestamp": "12:00:01", "level": "info", "message": "SSH tunnel connected..." },
    { "timestamp": "12:00:02", "level": "error", "message": "WebSocket disconnected: ..." }
  ]
}
```

## UI Entry Point

ProfileDetail 卡片标题栏右侧，增加一个小 `Bug` 图标按钮，hover 提示"导出诊断日志"。

## Tech

- **Rust**: 新 `export_diagnostics` 命令，返回 `DiagnosticInfo { app_version, os, arch, connection, health }`
- **Frontend**: Tauri `@tauri-apps/plugin-dialog` 的 `save()` + `@tauri-apps/plugin-fs` 的 `writeTextFile()`
- **脱敏**: gateway token 替换为 `"***"`

## Scope

- 不做自动上报
- 不改后端日志框架（保持 eprintln）
- 不做日志轮转/持久化
- Activity Log 条目上限维持 200 条
