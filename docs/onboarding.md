# 第一次接入

1. 启动 `world-hub --port 8790`，读取 ready 行的 endpoint。
2. 在自己的配置中给外部程序分配独立桥身份与权限；配置模板不是执行授权。
3. 使用 [JavaScript](../sdk/javascript/README.md)、[Python](../sdk/python/README.md)、[PowerShell](../sdk/powershell/README.md) 或自行实现[线协议](specs/protocol.md)。
4. 连接并登记程序需要的通道，再发布、抽取、请求或注入信息；由程序解释业务结果。
5. 使用 `/status`、`/log` 和 `/manage/api/state` 读取机器状态；需要操作时带当前管理令牌。见[管理 API](specs/management.md)。

不要把网页或管理工具作为程序接入的前置依赖。可选的 [World Hub UI](specs/ui-separation.md) 单独安装并连接正在运行的 Hub。

开发者可从[模块契约](ecosystem/modules.md)、[提供者契约](modules/provider-contract.md)和[互操作验收](ecosystem/interop.md)继续探索。真人第三方独立开发和新手验收仍为单独待办，自动化测试不代替真人证据。
