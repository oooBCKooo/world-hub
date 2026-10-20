# 仓库边界

World Hub 与 [World Hub UI](specs/ui-separation.md) 是两个独立项目，不使用跨仓库源码导入或共享启动进程。

| World Hub 目录 | 职责 |
| --- | --- |
| src/hub | 通信、权限、路由、留存、大对象、HTTP 与 WS 入口 |
| src/management | 非界面管理与模块 API |
| sdk | JavaScript、Python、PowerShell 枢纽桥 |
| bin、scripts | 无界面 CLI、验证与发行工具 |
| tools/launcher | 模块、资源、接线、权限及进程管理的非界面实现 |
| tools/workshop | 可选社区 API、存储与制品校验 |
| tools/mcp、skills | 独立智能体接入 |
| examples、tests | 无界面示例与自动化验收 |
| docs | 当前通信、API、资源和开发契约 |

界面项目持有通信画布、工作台、社区网页、浏览器适配器、语言资源、样式、截图与界面测试。Hub 源码、npm 制品和 ZIP 均不携带 HTML、CSS、前端资源或界面截图。

发行使用明确 allowlist。运行配置、身份凭据、业务数据、依赖缓存和本机证据不进入发行包。旧界面启动命令和旧页面地址不作兼容跳转。
