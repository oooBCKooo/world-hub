# 开发

World Hub 只开发非界面功能。页面、样式、浏览器状态与用户交互在独立 [World Hub UI](specs/ui-separation.md) 项目开发，双方依靠 HTTP／WebSocket 契约联调。

```powershell
npm test
npm run test:resources
npm run test:workshop
npm run test:npm
npm run test:distribution
npm run check:repository
```

核心协议与 SDK 变更运行 conformance 和相应真实桥场景；模块 API 变更运行资源、版本、生命周期及来源测试。MCP 依赖只在 tools/mcp 独立安装；Python／PowerShell／DSH 为显式可选测试环境，不宣称未运行的验收。

新增非界面功能不可依赖页面文件、浏览器自动化或 UI 项目的内部源码。JSON API 保留本机权限边界，UI 不能通过代理绕过令牌。测试要同时覆盖无 UI 启动与双方独立关闭的行为。
