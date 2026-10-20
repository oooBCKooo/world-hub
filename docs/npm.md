# npm CLI 与 SDK

```powershell
npm install -g world-hub
world-hub --check
world-hub --port 8790
world-hub --config ./hub.json --data-dir ./private-hub-data
```

安装目录不保存运行数据。未指定配置时使用当前目录的 `world-hub-data/hub.json`，首次正式运行才创建；`--check` 是只读检查。自定配置保持原样，数据目录覆盖会生成独立有效配置。使用 Ctrl+C 等待 stopped 后退出。

Hub CLI 启动非界面服务，也通过公开管理 API 操作已经运行的 Hub。不接受 `--open`，不内置浏览器。`ready` 输出 `endpoint`、`statusUrl`、`managementApiUrl` 和存储位置。根路径为 JSON，`/manage` 返回 UI 已分离提示。

```powershell
world-hub operations --json
world-hub status --hub http://127.0.0.1:8790 --json
world-hub module list --hub http://127.0.0.1:8790 --json
```

完整命令、结构化输入、审阅后应用和退出码见 [CLI 管理](cli.md)。模块、资源、接线、启动计划、版本、来源和外部程序接入均使用同一公开 API。TUI 暂未提供。

SDK 导出 `world-hub/bridge`、`world-hub/blob`、`world-hub/lifecycle` 与 `world-hub/management`。`world-hub-skill` 安装文档，`world-hub-mcp` 提供独立 stdio 适配器，`world-hub-workshop` 启动可选社区 API 服务。MCP 通信使用桥身份；可选管理工具需要另外明确配置本机地址与精确操作名单。它们不需要 World Hub UI。

可选界面见 [World Hub UI](specs/ui-separation.md)，单独启动并设置 Hub 地址。旧 npm 发行版可能仍带界面；当前源码与构建以此分离边界为准。
