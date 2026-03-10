<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="OpenClaw Connector Logo" />
</p>

<h1 align="center">OpenClaw Connector</h1>

<p align="center">
  <strong>安全地将远程 AI Agent 桥接到你的本地机器</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装">安装</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="docs/guide.zh-CN.md">使用指南</a> •
  <a href="#贡献">贡献</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/tauri-2-24C8D8?logo=tauri" alt="Tauri" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?logo=react" alt="React" />
  <img src="https://img.shields.io/badge/rust-stable-orange?logo=rust" alt="Rust" />
  <a href="https://github.com/liuzeming-yuxi/Openclaw-Connector/releases"><img src="https://img.shields.io/github/downloads/liuzeming-yuxi/Openclaw-Connector/total?color=%23027DEB" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
</p>

<p align="center">
  简体中文 | <a href="README.md">English</a>
</p>

---

![截图](docs/images/screenshot.png)

## 为什么需要 OpenClaw Connector？

[OpenClaw](https://github.com/openclaw/openclaw) Agent 运行在服务器上，但经常需要与你的**本地环境**交互：执行命令、控制浏览器、访问本地文件。

OpenClaw Connector 解决两个核心问题：

1. **桥接服务器与本地** — 通过安全隧道连接 OpenClaw Agent 和你的本地机器，让 Agent 能像坐在你旁边一样操作你的电脑。

2. **安全访问网关** — OpenClaw 网关不应该暴露在公网上。这个应用通过加密 SSH 隧道让你在本地安全访问远端网关——无需开放端口，无需公网地址。

## 功能特性

- **SSH 隧道** — 安全的反向隧道连接到 Linux 网关，支持自动重连
- **Agent 绑定** — 将 AI Agent 绑定到本地节点，执行远程任务
- **浏览器 CDP** — 通过 Chrome DevTools Protocol 将本地浏览器暴露给 Agent
- **会话管理** — 一键通知多个聊天会话中的 Agent
- **设备身份** — Ed25519 密钥对，用于安全的设备认证
- **紧急断开** — 一键断开所有连接的紧急开关

## 安装

从 [Releases](https://github.com/liuzeming-yuxi/Openclaw-Connector/releases) 页面下载适合你平台的最新版本。

| 平台 | 文件 |
|------|------|
| **macOS (Apple Silicon)** | `OpenClaw.Connector_x.x.x_aarch64.dmg` |
| **macOS (Intel)** | `OpenClaw.Connector_x.x.x_x64.dmg` |
| **Linux (Debian/Ubuntu)** | `OpenClaw.Connector_x.x.x_amd64.deb` |
| **Linux (AppImage)** | `OpenClaw.Connector_x.x.x_amd64.AppImage` |
| **Windows** | `OpenClaw.Connector_x.x.x_x64-setup.exe` |

> **macOS 提示：** 首次启动时，macOS 可能提示"无法验证开发者"。前往 **系统设置 → 隐私与安全性**，下拉找到并点击 **"仍要打开"**。
>
> **Linux AppImage：** 先运行 `chmod +x OpenClaw.Connector_*.AppImage` 赋予执行权限。

## 快速开始

### 前置要求

- 一台运行 [OpenClaw](https://github.com/openclaw/openclaw) 网关的远程 Linux 服务器
- 本地机器能通过 SSH 连接到该服务器

> **第一次使用？** 请查看[使用指南](docs/guide.zh-CN.md)，里面有详细的配置说明和参数解释。

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/liuzeming-yuxi/Openclaw-Connector.git
cd Openclaw-Connector

# 安装依赖（需要 Node.js 18+、pnpm、Rust 工具链）
pnpm install

# 开发模式运行
pnpm tauri dev

# 或者构建生产版本
pnpm tauri build
```

## 技术栈

| 层级 | 技术 |
|------|-----|
| 桌面框架 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | React 19 + TypeScript + Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| 后端 | Rust (Tokio 异步运行时) |
| 隧道 | SSH 反向端口转发 |
| 浏览器自动化 | Chrome DevTools Protocol (CDP) |

## 项目结构

```
├── src/                    # React 前端
│   ├── pages/              # 页面组件
│   ├── components/ui/      # 可复用 UI 组件
│   ├── store/              # Zustand 状态管理
│   └── types/              # TypeScript 类型定义
├── src-tauri/              # Rust 后端
│   └── src/
│       ├── lib.rs          # Tauri 命令处理
│       ├── ssh_tunnel.rs   # SSH 隧道管理
│       ├── browser.rs      # Chrome CDP 生命周期
│       ├── ws_client.rs    # WebSocket 客户端
│       ├── config.rs       # 配置持久化
│       ├── health.rs       # 网关健康监控
│       └── device_identity.rs  # Ed25519 设备密钥
├── docs/                   # 文档
└── package.json
```

## 开发指南

```bash
# 开发模式运行（前端 + 后端）
pnpm tauri dev

# 运行前端测试
pnpm test

# 运行 Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml

# 类型检查
pnpm build
```

## 路线图

- [ ] 更好的全平台支持（Windows & Linux）
- [ ] 多语言支持（i18n）
- [x] 主题切换（白天 / 黑夜模式）
- [x] OpenClaw 健康检查及自动修复
- [ ] 更多浏览器的自动化支持（Firefox、Edge 等）
- [ ] 完善的 CI/CD 构建流程
- [x] PR 级别的 CI 检查（lint、test、clippy）
- [ ] 架构 / 时序图
- [x] 更安全的端口管理（避免误杀无关进程）
- [x] Operator WebSocket 断连时优雅关闭
- [x] 统一配置源（前端 vs 后端配置同步）

## Star History

<p align="center">
  <a href="https://star-history.com/#liuzeming-yuxi/Openclaw-Connector&Date">
    <img src="https://api.star-history.com/svg?repos=liuzeming-yuxi/Openclaw-Connector&type=Date" alt="Star History Chart" />
  </a>
</p>

## 致谢

OpenClaw Connector 基于以下优秀的开源项目构建：

- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 运行时
- [Tauri](https://v2.tauri.app/) — 轻量级桌面框架
- [React](https://react.dev/) — UI 组件库
- [Zustand](https://github.com/pmndrs/zustand) — 轻量级状态管理
- [Tailwind CSS](https://tailwindcss.com/) — 实用优先的 CSS 框架
- [Lucide](https://lucide.dev/) — 精美图标库

## 贡献

请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 安全

请参阅 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 了解安全模型和漏洞报告方式。

## 许可证

[MIT](LICENSE)
