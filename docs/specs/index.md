# 当前通讯规范

线协议为 `wire: "0.1"`，附加能力通过 `welcome.features` 协商。软件版本由根目录 [package.json](../../package.json) 管理；规范按职责组织，不要求固定文件数量。

| 规范 | 约束范围 |
| --- | --- |
| [定位与边界](boundaries.md) | 十字路口职责、程序与桥 N:M、开放通道、载荷不透明、提供者留存 |
| [通讯契约](protocol.md) | 握手、身份、动态登记、发布／抽取、ACK、水位、释放及错误 |
| [可靠性与访问边界](reliability-access.md) | 有界投递、存储、恢复、权限、观察与限额 |
| [请求、注入与大体积通讯](directed-and-bulk.md) | principal/session 寻址、可信回应、附件分块与所有权 |
| [跨语言桥合同](bridge-interoperability.md) | UTF-8、JSON 原文、整数、回执关联和功能 profile |
| [通讯管理](management.md) | 本机视图、主体通断、实例断开、注记、访问控制 |
| [用户通讯工作台](manual-workbench.md) | 自己的浏览器枢纽桥、手动通讯和附件操作、结果解释 |
| [接入操作体验](operations.md) | 草稿、快照顺序、有限等待、筛选、历史状态与回调隔离 |

这些合同不规定外部程序的语言、进程、页面、业务模型或枢纽桥部署方式。示例约定和测试控制协议也不升级为 Hub 业务接口。验证入口及未执行项的解释见[验证说明](../verification.md)。

Launcher 的当前部署对象为独立模块实例与模块组，一个工作空间使用一个全局 Hub。工具层说明见[Launcher](../ecosystem/launcher.md)、[模块声明](../ecosystem/modules.md)与[直接装配](../ecosystem/launcher-deployment.md)；这些职责不进入 Hub 通信内核。

原整合包、模板、Atomic／Mesh 和整包改装规格已退出当前产品导航，历史文件保留供审计，不再作为当前部署要求。当前通信合同与 SDK 不依赖这些对象。
