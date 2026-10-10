# 公开契约互操作基准 / Public contract benchmark

`world-hub-interop` 是可选的外部业务验证工具。当前只实现公开的 `text.statistics@1.0.0` profile，Hub Core 不认识该业务，也不要求其他程序实现它。任意新合同应由其作者定义输入、结果、失败、状态和副作用，再提供自己的测试 profile；本工具不把 Schema 相同当作业务等价。

## 验证自己的提供者 / Verify your provider

先由部署方启动并授权自己的程序、桥和调用方。按[提供者契约](../modules/provider-contract.md)准备私有接线，建立业务主题订阅；可使用独立目录，但下面的测试只需要明确、可信的目标地址。npm 工具不会启动提供者、自动安装依赖、改变程序配置或授予本地执行权。

```powershell
npm install -g world-hub
world-hub-interop verify --config private-wiring.json --report new-report.json
```

`private-wiring.json` 示例（替换为自己部署的值，不要发布凭据）：

```json
{
  "endpoint": "ws://127.0.0.1:8790/bridge",
  "moduleId": "author.statistics",
  "moduleDirectory": "./my-module",
  "target": { "principal": "author.statistics", "session": "当前提供者 welcome.session" },
  "topic": "author/statistics",
  "timeoutMs": 5000,
  "caller": {
    "bridgeId": "verify.author", "credential": "consumer.allowed",
    "principal": "consumer.allowed", "token": "PRIVATE_ALLOWED_TOKEN"
  },
  "deniedCaller": {
    "bridgeId": "verify.denied", "credential": "consumer.denied",
    "token": "PRIVATE_DENIED_TOKEN"
  }
}
```

两调用方都需要 Hub 对该主题的发布／订阅权限；提供者自己的 `allowedCallers` 只认可第一位。这样验证的是提供者的业务授权拒绝，另由受控套件验证 Hub ACL 拒绝。`target.session` 可省略，此时同身份多个连接可能接收请求，部署方自行协调。`moduleDirectory` 只核对静态声明和文件摘要，不证明该目录就是在线执行的进程；部署验收应记录两者的代码摘要并另核对运行身份。所有路径按启动命令的工作目录解析。

完整通过要求提供模块声明和独立 `deniedCaller`。缺少材料或测试未运行会返回非零状态，报告保留 `not-supplied` / `incomplete-or-failed`。既有报告不覆盖。结果不含 token、原文或完整私有接线；仍按部署方自己的报告保密策略保存。

## 三层报告 / Three evidence layers

| 层 | 实际检查 | 不代表什么 |
| --- | --- | --- |
| `declaration` | 有界文件、模块格式、当前平台、所声明精确合同 | 在线程序确实执行这份代码、业务正确或任意依赖可用 |
| `protocol` | 真实 Hub 接纳序号、requestSeq、目标 principal／可选 session、回应关联 | 业务成功、事务提交或权限由广告自动授予 |
| `business` | 成功／失败闭合格式、invocationId、provider、UUID 和准确 Unicode／UTF-8 结果 | 其他合同、长期负载或外部副作用可撤销 |

12 个正常／失败案例包括空文本、emoji、组合字符、CRLF／空白保真、ASCII／emoji 16384 字节边界、超限字节、孤立代理项、额外字段、错误合同版本、非法 invocationId、256 码点 ID 边界及提供者权限拒绝。成功结果准确核对码点、LF 行数、原始 UTF-8 字节数及 SHA-256；每次执行 UUID 不复用。协议可以通过而业务失败，报告保留这种区别。

## 从公开仓库重跑受控基准 / Reproduce the controlled suite

```powershell
git clone https://github.com/oooBCKooo/world-hub.git
cd world-hub
python -m pip install -r sdk/python/requirements.txt
npm run test:interop
```

需要 Node ≥22.4 和 Python ≥3.10、`websockets==15.0.1`；CI 使用 Windows、Node 22、Python 3.13。本机具体版本写入证据。自选 Python 可通过 `HUB_PYTHON` 传入可执行文件路径，不使用 PATH 中另一个同名解释器。验证过程中真实 JS 和 Python 提供者、目录、来源、消费者和成果程序各自运行；一个不变的 CLI 消费者验证两种提供者，外部组装器只改 moduleId 配置即可替换，来源／消费者／成果源码摘要保持不变。每次证据写入新的 `.artifacts/interop/` 与验证套件证据目录。

第二组受控场景主动让外部提供者暂不回应，再通过普通 response 订阅抽取迟到结果；验证超时不是取消、旧精确 session 不交给新连接，以及 Hub ACL 拒绝与错误业务结果分别识别。它不强迫第三方模块加入测试控制接口，也不把超时后的结果未知写成已失败或可安全重发。两组测试都不 release 信息。

JavaScript 参考 artifact 沿用此前独立 AI 的文档隔离实验，原实现摘要不变。Python 是集成 AI 从公共协议和 Python SDK 分别实现的参考，但该作者读过 JavaScript fixture，**不声称第二位独立作者**。作者来源见各自 `authorship.json`；资料限制为实验指令，并非操作系统隔离。真实第三方独立作者与新用户验收仍是明确待办，自动测试不能替代它们。

英文命令帮助、字段和分层报告可直接使用。The benchmark verifies one optional application profile through public bridge traffic. It does not establish independent human authorship, general contract compatibility, or automatic cancellation after timeout. See [the public provider contract](../modules/provider-contract.md), [Python SDK](../../sdk/python/README.md), and [wire protocol](../specs/protocol.md).
