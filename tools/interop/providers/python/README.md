# 独立 Python text.statistics 提供者

`provider.py` 是一位新的 AI 作者只依据公开材料编写的 `text.statistics@1.0.0` 实现，使用现有公开 `sdk/python/hub_bridge.py`。本实验是指令约束的资料隔离，不是操作系统强制隔离；作者不是人类，成功自检或接入都不等于真人开发者验收。材料路径、读取时 SHA-256、实施 SHA-256 和限制见 `authorship.json`。

在仓库根目录安装公开 SDK 的依赖后启动：

```powershell
python -m pip install -r sdk/python/requirements.txt
python -B tools/interop/providers/python/provider.py --config private-wiring.json
```

配置为 JSON 对象；`sdkDirectory` 和 `contractPath` 的相对路径按配置文件所在目录解析。下面示例假定配置与本 README 在同一目录，凭据值由部署方私下提供：

```json
{
  "endpoint": "ws://127.0.0.1:8790/bridge",
  "bridgeId": "independent.python",
  "credential": "independent.python",
  "principal": "independent.python",
  "token": "PRIVATE_TOKEN",
  "moduleId": "independent-python-statistics",
  "moduleVersion": "1.0.0",
  "businessTopic": "independent/python/statistics",
  "allowedCallers": ["consumer.allowed"],
  "directory": {
    "principal": "demo.capability-directory.directory",
    "registerTopic": "demo/capability-directory/catalog/register"
  },
  "leaseMs": 1800,
  "renewEveryMs": 600,
  "sdkDirectory": "../../../../sdk/python",
  "contractPath": "../../../../docs/modules/text-statistics.contract.json"
}
```

省略 `credential` 时默认使用 `principal`。单桥部署若不采用 credential，可以明确传入 `"credential":null`，并将 `principal` 配置为桥身份。`allowedCallers` 可为空；这会拒绝所有业务调用。实现版本 `moduleVersion` 不改变固定的业务契约版本。Hub 双向主题 ACL、目录 principal→moduleId allowlist 和主题前缀由部署方分别配置，广告不授予业务权限。

握手后核对认证、principal、session 与 directed-v1；显式登记两个主题的双向声明，建立业务 request 和目录 response 订阅后登记完整清单。登记回应必须匹配可信目录 principal、可信 requestSeq，并完整核对 epoch、module、capabilities、provider principal/session、时间戳、精确租期及有效状态。首次登记确认后，标准输出包含：

```json
{"event":"ready","type":"ready","principal":"independent.python","session":"本次 welcome.session","moduleId":"independent-python-statistics"}
```

其他观察也为逐行 JSON；不输出 token、完整配置、原文或原始诊断帧。在标准输入写一行 `stop` 可优雅停止，SIGINT/SIGTERM 同样请求停止。接收每次最多等 50ms；请求接纳／目录往返期限 1500ms，订阅／登记控制期限 3000ms，公开 SDK 连接／发送／关闭超时 2 秒。续租任务不会并发堆积；目录短暂未响应或拒绝会记录事件，并在下一周期重新广告。通讯连接中断或业务回应接纳不确定时退出非零；部署方重新启动将核对新的 session 并重新登记。实现没有持久化游标或跨重启 exactly-once 承诺。

权限仅取可信 delivery.fromPrincipal，按授权、精确契约、严格输入的顺序判断。成功和失败均为闭合业务 envelope。保留原文的空白、CR/LF 和 Unicode 表示；只按 LF 分行，严格 UTF-8 上限 16384 字节，拒绝孤立代理项，每次成功生成新的 UUID。SDK 的 `Frame.frame` 是诊断值，因此另从 `Frame.raw` 解析业务 JSON 类型，巨大数字或溢出指数不能被误认为文本。回应只发送原请求 `requestSeq`，返回身份与主题由 Hub 推导；收到 Hub `published` 接纳后才 ACK 原请求。ACK、停止、超时和续租不 release 任何记录，也不将本地超时伪报为业务失败或取消。

作者本地检查命令：

```powershell
python -B tools/interop/providers/python/provider.py --self-check --contract-path docs/modules/text-statistics.contract.json
```

语法检查通过；本地 35 项检查通过，包括空文本、emoji、组合字符、CRLF、LF 行数边界、ASCII/emoji UTF-8 字节边界、256 码点 invocationId、无效输入、调用权限、嵌套额外字段、JSON 数字类型、完整清单和目录回应完整性。检查器只实现本公开契约使用的 JSON Schema 关键字；不宣称是通用 JSON Schema 验证器。真实进程、公开 CLI 和不变消费者验收由主代理单独执行，作者未读取其测试或回顾。

材料缺口记录：初始指定的 `docs/modules/README.md`、`docs/capabilities.md`、`docs/bridge-spec.md` 不存在。`provider-contract.md` 明确说明 Python SDK 只交付 send/receive，因此主代理另行授权读取它指向的 `docs/specs/protocol.md`、`docs/specs/directed-and-bulk.md`、`docs/specs/bridge-interoperability.md`，线帧均据此实现；没有访问参考提供者或测试。所读规范说明 welcome.features 的协商语义，但没有列出该字段的完整序列化 Schema；实现接受包含 `directed-v1` 的列表，或该键为 true 的对象。此字段形状边界已记录，不将广告或自检当作通用互操作证明。

Public acceptance: run `npm run test:interop` from the repository root. The same unchanged CLI and application consumer test this Python provider and the JavaScript provider with separate declaration, protocol and business reports, including numeric type preservation and lease renewal. This is an AI docs-only experiment; independent human acceptance remains pending. The integration coordinator adapted only this README for portable paths and added acceptance metadata; provider.py retains the exact author-frozen bytes.
