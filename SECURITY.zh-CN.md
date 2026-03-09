# 安全说明

[English](SECURITY.md) | 简体中文

OpenClaw Connector 将远程 AI Agent 与你的本地机器桥接起来。这意味着 Agent **可以在你的电脑上执行命令并控制浏览器**。使用前请务必了解安全模型。

## 这个应用能做什么

### 本地命令执行

连接后，OpenClaw Agent 可以通过 `system.run` 在你的机器上执行**任意 Shell 命令**。这是设计如此——Agent 就是通过这种方式与你的本地环境交互的。

- 命令以**你的用户权限**运行（不是 root，除非你本身就是 root 登录）
- 没有内置的命令白名单或沙箱——你的用户能执行什么，Agent 就能执行什么
- 命令的输出（stdout/stderr）会被发送回 Agent

### 浏览器自动化 (CDP)

启用浏览器 CDP 后，Agent 可以：

- 打开和导航网页
- 点击、输入、与页面元素交互
- 截图
- 读取 CDP 浏览器实例中的页面内容和 Cookie

这只影响**专用的 CDP Chrome 实例**——不会影响你日常使用的浏览器。

## 安全设计

### SSH 隧道（加密传输）

你的 Mac 和服务器之间的所有通信都通过**加密 SSH 隧道**传输，没有明文数据。

- OpenClaw 网关**永远不暴露在公网上**
- 只有你的机器通过 SSH 隧道才能访问网关
- 隧道使用你现有的 SSH 密钥进行认证

### 设备身份 (Ed25519)

每个 Connector 实例首次启动时会生成唯一的 **Ed25519 密钥对**，用于：

- 加密设备身份标识
- 防止设备身份被冒充

### 紧急断开

一键紧急断开会：

- **立即终止 SSH 隧道**
- **终止所有 Chrome CDP 进程**
- **断开与网关的 WebSocket 连接**
- 断开后，Agent 无法再访问你的机器

## 安全建议

### SSH 密钥最佳实践

- 为 Connector 使用**专用的 SSH 密钥**，不要用你的个人密钥
- 考虑在服务器端限制密钥权限（`ForceCommand`、`AllowTcpForwarding`）
- 使用 Ed25519 密钥，比 RSA 更安全

### Gateway Token

- Gateway Token 存储在本地 `~/Library/Application Support/ai.openclaw.connector/connector-config.json`
- 像对待密码一样对待它——不要分享或提交到版本控制
- 定期在服务器端轮换 Token

### 网络注意事项

- 只连接你信任的服务器
- 注意 Agent 可以访问你本地机器能访问的任何网络资源
- 如果你在公司网络中，连接前请了解相关影响

## 报告漏洞

如果你发现安全漏洞，请负责任地报告：

- **不要**在 GitHub 上创建公开 Issue
- 直接联系维护者或使用 [GitHub 的私密漏洞报告功能](https://github.com/liuzeming-yuxi/Openclaw-Connector/security/advisories/new)

我们会在 48 小时内确认收到并着手修复。
