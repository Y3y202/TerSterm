# TerSterm

TerSterm 是一个基于 Tauri 2、Rust、Vue 3 和 Ant Design Vue 的 SSH 管理工具。当前版本已经包含连接管理、xterm 终端工作区和最多四分屏布局。

## 开发

```bash
pnpm install
pnpm tauri:dev
```

浏览器预览：

```bash
pnpm dev
```

## 校验

```bash
pnpm build
cd src-tauri
cargo check
```

## 后端说明

SSH 会话由 Rust 后端通过 `portable-pty` 启动系统 OpenSSH 客户端，终端输入、输出和窗口 resize 通过 Tauri command/event 在前后端之间同步。
