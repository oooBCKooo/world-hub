# Hub 与 UI 项目分离

World Hub 与 World Hub UI 分别安装、启动、停止、测试和发行。前者提供非界面通信及运维能力，后者提供可替换的图形客户端。Hub 不导入 UI 源码，不读取 UI 页面，不因缺少 UI 文件而拒绝启动。

| World Hub | World Hub UI |
| --- | --- |
| HTTP JSON／WebSocket 服务 | 页面、样式、浏览器代码、语言与截图 |
| SDK、CLI、Skill 与 MCP | 独立 `world-hub-ui` CLI 与固定目标代理 |
| 资源、安装、权限、进程、接线和版本 API | 调用这些公开 API 的交互 |
| Workshop 账号、存储与制品 API | Workshop 社区静态网页 |
| 无界面运行、安装与分发测试 | UI 渲染、代理及与公开 CLI 的联调 |

## 机器接口

Hub 根路径返回服务描述 JSON，`/status` 与 `/log` 返回状态和日志，`/manage/api` 描述管理入口，`/manage/api/state` 返回当前快照。`/manage` 不再提供 HTML 或兼容重定向。就绪输出提供真实的 `endpoint`、`statusUrl`、`managementApiUrl`。

Hub CLI 拒绝 `--open`，不会寻找、安装或启动 UI。程序可直接按 SDK／线协议连接 Hub，不需要模块清单或管理工具。管理部署辅助能力与数据面仍是不同层，不能为图形客户端增加业务载荷分支。

## 独立客户端

World Hub UI 的本机服务只接受回环和自己的精确 Host／Origin。它连接明确指定的本机 Hub，代理固定 `/manage/api/**`、`/status`、`/log` 与声明的 WS 通信路径。代理保留写操作令牌及原始消息字节，不提供任意 URL 转发，不自动重发写操作，也不扩大桥的权限。

Hub 的 Host、Origin、CSRF 与桥授权检查保持有效；不能通过允许所有 CORS 或关闭认证完成分离。UI 关闭后 Hub 继续运行；Hub 暂停时 UI 页面可独立打开并明确报告上游不可用。

## 社区网页

Workshop 后端默认不提供网页。部署方可通过明确的绝对目录 `uiRoot` 挂载独立 UI 交付的静态资产，或由自己的同源网关提供网页。后端不复制、编译或捆绑该项目。账号 Cookie、API、静态来源及不可变制品继续遵循既有同源和摘要合同。

## 发行边界

Hub 源码检查、npm tarball 与 ZIP 不允许包含浏览器页面、CSS、界面脚本与截图。UI 包无 Hub 内部源码依赖，独立测试不要求两个仓库相邻。跨项目联调只通过公开 CLI／HTTP／WS，单独记录可选运行环境。

现有界面修改按工作树原始字节迁移，原件摘要保留在本机证据。历史图形演示与旧 Launcher 不作为当前 Hub 入口。此分离不自动发布 npm，也不改动用户正在运行的 Hub 或线上社区。
