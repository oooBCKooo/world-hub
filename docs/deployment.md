# 无界面部署

使用 Node.js 22.4.0 或更高版本；便携参考运行时为 22.23.2。

```powershell
world-hub --config ./hub.json --data-dir ./hub-data
```

配置提供 transport host/port/path、桥身份与主题权限、消息保留及 blob 配额。默认回环监听，拒绝未登记的桥。对外开放通信端口时仍须配置身份与权限；管理 API、状态与日志只允许本机回环，勿将其直接转发到公网。

`ready.endpoint` 是真实 WS 端点；`ready.statusUrl` 与 `ready.managementApiUrl` 是本机机器接口，不是网页。使用进程管理器保持前台进程，停机须发送正常退出信号并等待数据刷新、运行锁释放。不要按历史 PID 强杀或自动删除运行锁。

配置、日志、blob 与管理状态使用自己的私有数据目录，版本控制不携带运行数据。容量与留存按[运行规格](specs/operations.md)设置。

World Hub UI 是独立客户端。它在自己的本机端口提供页面，明确指定 Hub 目标并代理 API／WS，不能以放开 CORS 或关闭鉴权替代正确接入。Hub 独立于其安装、启动与关闭。

Workshop 作为独立 API 服务部署，固定 HTTPS 外部 Origin，经精确网关路由进入回环后端。默认不提供页面；可选的绝对目录 `uiRoot` 仅挂载独立 World Hub UI 交付的四份静态资产。升级后端与网页分别核对版本和摘要，保留账号与不可变制品。见[社区](ecosystem/workshop.md)。
