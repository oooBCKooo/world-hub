# 构建与分发

```powershell
npm run test:distribution
npm run test:npm
npm run build -- --output .artifacts/packages/world-hub-source
```

构建器按明确源码清单生成带摘要的独立 ZIP 和 manifest，包含无界面 Hub、CLI、SDK、模块工具、Skill／MCP 与可选社区后端。源包不捆绑第三方运行时；便携参考运行时单独审阅其许可证与摘要。

World Hub 不生成 ui.cmd，不携带管理页面、社区网页、Soft UI 模块、可视化演示包或截图。World Hub UI 有自己的 package、测试、构建与发行周期；不需要与 Hub 同时发布。

npm 实装验收包括陌生工作目录、隔离本地与全局安装、真实桥往返、管理 API 安全、正常停机及发行文件边界。版本声明、协议协商与制品摘要保持独立，不自动转换旧 UI 入口。
