# 可选能力目录与配置式模块替换

World Hub 提供程序间通讯。程序还可以通过这些通讯，自行实现能力公布、发现、合同校验和组合。第十四期提供一个最小的外部生态示例；能力目录不是 Hub 的内置服务，也不是接入 Hub 的前置要求。

## 实际链路

`npm run demo:capabilities-explorer` 启动 Hub，以及目录、原文来源、组装器、统计实现 A、统计实现 B、成果保存者和浏览器界面。各程序有自己的 PID、mod、身份和状态目录。

1. 在界面选择“发现可用能力”，查看两套实现公布的合同、Schema、语义、主题、副作用和授权需求。
2. “运行当前组合”：组装器查目录，读取原文，定向调用 A，最后提交给成果保存者。
3. “仅改配置换成 B”，再次运行。A 用 Buffer/Hash 实现，B 用 TextEncoder、码点循环和 WebCrypto 实现；统计结果相同，处理器地址与执行记录改变。其余程序无需改源码。
4. 尝试“不兼容版本”后运行，应在调用处理器前返回 `CONTRACT_MISMATCH`；恢复版本后可继续。
5. 选择 B，撤销它的业务授权后运行，应得到 `PERMISSION_DENIED` 业务回应；Hub 接纳了请求与回应，但没有完成业务。
6. 恢复授权，再模拟慢处理。组装器返回 `uncertain` 和已接纳请求的序号；请求没有取消，也没有自动重试。恢复响应速度后可发起新任务。
7. 暂停 B 的能力续约，等待 1800 毫秒后查询。目录显示 `lease-expired`，组装器不发起处理调用；租约失效不是进程死亡证明。

两实现和[公开契约](https://github.com/oooBCKooo/world-hub/blob/main/examples/capability-directory/contract.json)随源码与第四套演示整合包提供。npm Hub 运行包包含文档和 SDK，示例程序从源码仓库或演示包获取。

## 极小能力清单 v1

这是本例的应用层约定，沿用现有 `request` / `respond`，不新增 Hub 帧或固定业务通道：

```json
{
  "manifestVersion": 1,
  "module": { "id": "metrics-a", "version": "1.0.0" },
  "capabilities": [{
    "id": "text.statistics",
    "contract": { "id": "text.statistics", "version": "1.0.0" },
    "inputSchema": { "type": "object", "description": "See the full public contract" },
    "outputSchema": { "type": "object", "description": "See the full public contract" },
    "semantics": "utf8-exact-unicode-v1",
    "topic": "demo/capability-directory/text/statistics",
    "effects": "read-only",
    "permissions": ["text.read"]
  }],
  "leaseMs": 1800
}
```

上面的 Schema 是说明性缩写，实际注册携带公开契约的完整输入与输出 Schema。目录检查清单格式，不执行一般 JSON Schema 验证器；处理器和组装器实现本例合同的有界校验。版本采用精确匹配，不推断 semver 兼容范围。合同还规定 Unicode 码点、LF 行分段、原文 UTF-8 字节与 SHA-256；JSON 形状相同不足以证明语义兼容。

目录有自己的提供者 allowlist。它从定向消息的 `fromPrincipal` / `senderSession` 确定广告地址，并核对主体所获准登记的模块 ID；正文不能声明地址。调用方信任的是配置里的目录 principal。演示部署为这些主体配置 token；delivery 本身没有“对端已认证”的独立布尔字段，认证前提来自部署的通讯身份配置。

目录以自己接到消息的时间计算租约，处理器每 600 毫秒续约。目录重启生成新 epoch，使保存的旧租约失效，等待新的注册消息。组装器调用广告中的精确 session；提供者重启后的新 session 需要重新登记。租约查询与真实调用之间仍有竞态，组装器设置有限等待。

`effects` / `permissions` 是提供者声明，不能获得业务执行权。Hub ACL 决定可否通讯，处理器的 `allowPrincipals` 决定是否接受统计业务。发现成功、Schema 相同、管理注记和通讯 ACK 均不替代这些判断。

## 通讯与业务状态

| 可观察结果 | 含义与负责者 |
| --- | --- |
| `published` 与请求序号 | Hub 接纳了原始通讯信息，不证明对端执行 |
| delivery / ACK | 桥接收或确认消费，不释放提供者记录，也不证明业务完成 |
| `status: completed` | 外部处理器报告完成；组装器校验回应，成果保存者另行确认持久提交 |
| `status: failed` | 外部程序解释的版本、授权、输入或处理失败；查看各步真实请求与回应 |
| `status: uncertain` | 已接纳的处理请求在本地等待内没有回应；可能后来完成，没有取消或自动重试 |

成果保存者使用 `invocationId` 去重，相同内容返回已保存记录，不同内容返回 `IDEMPOTENCY_CONFLICT`。该策略属于外部程序，验证范围是重复调用和正常停机后的恢复；它不与 Hub 形成事务，也不承诺断电耐久或 exactly-once。统计处理本身是只读计算，重复调用可能再次执行；目录与诊断计数的持久文件不是业务事务系统。

## 验收与继续扩展

`npm run test:capabilities` 执行真实独立进程场景，验证配置替换、版本和租约拒绝、业务授权、超时后迟到回应、可信登记、程序重启与隔离 SDK 接入。隔离测试只复制 B 的入口、公开契约和 SDK，没有 Hub 内部实现或共享业务程序。这证明本例的独立实现可以接入，不声称已有不同第三方开发者共同验收所有模块。

本期采纳了架构建议中的最小能力清单、外部目录、严格替换示例和通讯／业务状态区分。MCP 适配器、语义转换、通用治理、插件安装与 AI 自动编排可由后续独立程序探索；它们不进入通讯内核。新增业务合同与能力主题由 mod / 程序约定。

继续阅读：[用途演示与整合包](purpose-demos.md)、[JS SDK](../../sdk/javascript/README.md)、[请求与留存](../specs/directed-and-bulk.md)、[枢纽边界](../specs/boundaries.md)。
