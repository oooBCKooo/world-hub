# CLI 管理 / CLI management

`world-hub` 可启动服务，也可通过公开的本机 HTTP API 管理已经运行的服务。命令不需要界面；TUI 延后至 Hub 实际使用确认稳定后再考虑。使用源码检出的新增命令时，将示例的 `world-hub` 替换为 `node bin/world-hub.mjs`。安装包的命令以其实际版本和 `operations` 输出为准。

The CLI starts a headless server or manages a running server through its public local HTTP API. No UI is required. A TUI is deferred until real Hub use confirms stability. For a source checkout, replace `world-hub` below with `node bin/world-hub.mjs`. Installed releases expose their own versioned catalog.

## 启动与发现 / Start and discover

```sh
world-hub --version
world-hub --check --config ./hub.json
world-hub start --config ./hub.json --data-dir ./private-hub-data
# In another terminal:
world-hub operations --json
world-hub module --help
world-hub module start --help
world-hub status --hub http://127.0.0.1:8790 --json
world-hub module list --hub http://127.0.0.1:8790 --json
```

无参数启动方式仍可使用。`start` 前台运行，Ctrl+C 正常停机。管理地址使用 `ready.statusUrl` 所属的 HTTP origin，不含 `/bridge` 或 `/manage/api` 路径；默认 `http://127.0.0.1:8790`，也可设置 `WORLD_HUB_URL`。`--hub` 优先于环境变量。客户端仅连接明确的 HTTP 回环地址，不跟随重定向。

Starting with no arguments remains supported. `start` runs in the foreground; Ctrl+C shuts it down normally. Management takes the HTTP origin from the ready record, without a path. `--hub` overrides `WORLD_HUB_URL` and the default shown above. Only explicit HTTP loopback origins are accepted; redirects are rejected.

`operations` 不需要运行中的 Hub，返回稳定操作名、命令词、参数模式、读写分类和审阅要求。帮助只描述参数，不执行操作。

`operations` works offline and returns stable operation names, command words, input schemas, read/write classification and review requirements. Help does not execute an operation.

| 命令范围 / Command family | 用途 / Purpose |
| --- | --- |
| `status`, `state`, `log`, `message get` | 状态、管理快照与留存信息 / Status, management snapshot and retained information |
| `module`, `execution`, `startup`, `group` | 实例、常驻／按需策略、启动计划、本机引用组 / Instances, execution policies, startup plans and local reference groups |
| `bridge control`, `annotation save`, `wiring defaults` | 桥通断、注释、默认接线 / Bridge controls, annotations and default wiring |
| `resource body`, `resource configuration`, `resource data`, `resource cleanup` | 本体、配置、数据与保留法清理 / Bodies, configurations, data and retention-based cleanup |
| `version module`, `version group`, `uninstall module`, `uninstall group` | 版本、回退、恢复与卸载审阅 / Versions, rollback, recovery and uninstall reviews |
| `source`, `workshop`, `artifact`, `creator` | 软件源、下载、导入与制品制作 / Sources, downloads, imports and artifact creation |
| `external`, `path`, `environment` | 外部程序接入、目录与环境检查 / External admission, paths and environment inspection |

本机引用组用于组织现有实例，不是重新引入可分发模块组制品或每组一个 Hub。共享同一套操作目录的 SDK 导出为 `world-hub/management`。

Local reference groups organize existing instances; they are not distributed module-group artifacts or separate Hubs. The shared management SDK is exported as `world-hub/management`.

## 输入、审阅与应用 / Input, review and apply

```sh
world-hub module inspect --directory /absolute/module-directory --hub http://127.0.0.1:8790 --json
world-hub manage programs.inspect --input ./inspect.json --hub http://127.0.0.1:8790 --json
world-hub module review example.instance --hub http://127.0.0.1:8790 --json
world-hub module start example.instance --review-id ACTUAL_RETURNED_REVIEW_ID --accept --hub http://127.0.0.1:8790 --json
```

`inspect.json` 为 `{"directory":"/absolute/module-directory"}`。`--input FILE` 或 `--input -` 读取不超过 1 MiB 的 JSON 对象，适合参数、权限、接线、映射和计划；文件名相对当前 CLI 工作目录，JSON 内路径属于 Hub 所在机器。`manage <operation.name>` 提供与命名子命令相同的精确操作入口。标量可用 `--directory`、`--path`、`--program-id`、`--expected-revision` 等；数组选项接受逗号分隔值，复杂对象使用 JSON。冲突输入会在发送前拒绝。

`--input FILE` or `--input -` reads a JSON object up to 1 MiB. It is suitable for settings, permissions, wiring, mappings and startup plans. The input filename is relative to the CLI working directory; paths inside the object belong to the Hub machine. Scalar flags are conveniences; use JSON for structured values. Conflicting fields are rejected before sending.

先查看实际 preview/review 返回的变更，再使用对应 `reviewId` 与 `--accept`（JSON 中为 `accepted: true`）。客户端不会自动生成审阅、自动接受或忽略版本冲突；修改文件、参数或重启 Hub 后应重新检查审阅是否有效。需要额外数据／发布确认的操作仍需对应 `dataAcknowledged`、`dataCompatibilityAcknowledged` 或 `redistributionAcknowledged` 等显式字段。导入和应用配置不等于授权启动；应用数据要求受影响实例已停止。

Inspect the actual preview/review, then supply its `reviewId` and explicit acceptance. The client does not create or accept reviews automatically or suppress revision conflicts. Additional data or redistribution acknowledgements remain operation-specific. Importing and applying configuration do not grant execution authority. Data restoration requires affected instances to be stopped.

## 输出、凭据与失败 / Output, credentials and failures

结果写入 stdout；错误写入 stderr。`--json` 输出紧凑 JSON，默认使用缩进 JSON。`--raw` 仅用于 `message get` 和 `log`，直接输出服务器的原始 JSON 文本，避免重新序列化大整数或转义后的应用内容。普通 JSON 结果也保留 `rawJSON` 供需要原文的调用者使用。

Results use stdout and errors use stderr. `--json` produces compact JSON; the default is indented JSON. For retained messages and logs, `--raw` emits the original response JSON text without reserializing application numbers or escapes. Parsed results also carry `rawJSON` for callers that need it.

普通管理输出不包含 CSRF 令牌或新签发凭据。外部接入应用必须指定 `--secrets-file NEW_FILE`，在发送操作前创建新的私有文件；不覆盖已有文件。保持该文件在发布制品与日志之外，并只交给对应程序。MCP 管理工具不能请求该私有输出选项。通信负载仍是应用自己的不透明数据，不因字段名类似凭据而改写。

Normal management output omits CSRF tokens and newly issued credentials. `external apply` requires `--secrets-file NEW_FILE`; a new private file is opened before the mutation, without overwriting an existing file. Keep it out of artifacts and logs. Management MCP cannot request private credential output. Communication bodies remain opaque application data.

`--timeout MS` 为 1 至 3600000，默认 30000。写入超时或断线可能发生在服务端已经应用之后；错误中的 `outcome: "unknown"`、`retrySafe: false` 要求先查询实际状态或事务恢复信息，不能直接重试。审阅返回的编号、修订与恢复诊断应保留。客户端不会自动重发写入。

The timeout defaults to 30000 ms and accepts 1–3600000 ms. A failed connection can follow an applied write. When an error reports unknown outcome and unsafe retry, inspect current state or transaction recovery information before another write. Writes are never automatically retried.

检查源码和预览执行方案可能调用解释器自检，制品预览可能导入缓存；这些操作按写操作授权，不能根据命令包含“检查/预览”就授予 MCP 只读权限。`creator scaffold` 创建源码、探测解释器并登记模块，保持模块停止。`group dissolve` 仅解散引用组，成员保留；整组卸载使用 `uninstall group preview/apply`。

Source inspection and execution previews can run interpreter probes, and artifact previews can import cache content. Their catalog entries require write permission. `creator scaffold` creates source, probes the runtime and registers a stopped module. `group dissolve` removes only the reference group; use `uninstall group preview/apply` to review removal of selected member registrations.

退出码 / Exit codes: `0` 成功 / success；`1` API 或网络失败 / API or network failure；`2` 参数或输入错误 / usage or input error；`130` 中断 / interrupted。

参见 / See [管理 API](specs/management.md)、[模块资源](specs/module-resources.md)、[Skill 与 MCP](ecosystem/agents.md)、[English agent guide](ecosystem/agents.en.md)。
