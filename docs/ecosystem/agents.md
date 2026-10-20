# 给智能体使用的 Skill 与 MCP

**Skill 提供使用方法，CLI 提供可脚本化的部署管理，MCP 为智能体提供通信与显式授权的管理工具。** 通信通过独立枢纽桥，管理通过公开的本机 HTTP API；两者权限分开。模块仍是程序及其枢纽桥，智能体客户端也只是普通通信参与者。Hub Core 不加载 Skill、不解释提示词，也不执行 MCP 业务工具。

这些入口都不要求安装图形界面。可选的 [World Hub UI](https://github.com/oooBCKooo/world-hub-ui) 是同一公开 API 的独立客户端。

## 直接使用 CLI

先查看已安装版本及其操作目录，再使用当前 Hub 启动记录中的 HTTP 地址：

```powershell
world-hub --version
world-hub operations --json
world-hub status --hub http://127.0.0.1:8790 --json
world-hub module list --hub http://127.0.0.1:8790 --json
world-hub resource list --hub http://127.0.0.1:8790 --json
```

目录包含实际子命令、稳定 `operation.name`、输入 Schema 和审阅要求。CLI 覆盖模块启停、桥通断、启动计划、模块本体／配置／数据、版本切换与回退、保留法清理、来源和外部接入等管理操作；复杂参数通过 `--input <JSON文件>` 或 `--input -` 传入。也可用 `world-hub manage <operation.name> --input <JSON文件> --hub <HTTP地址> --json` 精确调用。管理路径属于 Hub 所在机器。

预览和应用分开：先检查返回的审阅，再用其 `reviewId` 和明确接受应用。CLI 不自动接受、重建审阅或重试写操作。超时后的结果可能未知，应保留收据并查询实际状态和恢复日志。普通输出省略管理密钥；外部接入确需交付新凭据时使用 `--secrets-file <新的私有文件>`。详情见 [CLI 文档](../cli.md)。

## 安装官方 Skill

安装包含这些入口的 World Hub 发行版后，选择目标客户端支持的技能目录，传入完整的新目录：

```powershell
world-hub-skill --check
world-hub-skill --install ./my-agent/.agents/skills/world-hub
```

`--path` 只显示包内原始目录。`--install` 复制 `SKILL.md` 与按需阅读的参考文件；已有目标不会覆盖。客户端的技能发现路径由客户端决定，`.agents/skills` 只是示例，复制后可能需要刷新客户端。Skill 不包含凭据，不启动 Hub，也不因为被读取就授予运行、安装或发布权限。

Skill 按需引用安装与诊断、CLI／管理、SDK 通信、模块资源和 MCP 接入说明。它可单独复制到客户端，无需让客户端读取完整项目源码。源文件见 [Skill](../../skills/world-hub/SKILL.md)。

## 准备 MCP 服务

```powershell
world-hub-mcp --prepare
```

此命令只在独立 `tools/mcp` 子包内按锁文件安装生产依赖，禁止依赖生命周期脚本。Hub 根包仍无运行依赖；单独使用 Hub、SDK 或 Skill 无需安装 MCP 依赖。源码用户可运行 `node bin/world-hub-mcp.mjs --prepare`，开发验收则执行 `npm ci --prefix tools/mcp --ignore-scripts` 安装测试客户端。

MCP 额外需要可用的 npm 和可写安装目录；便携 Hub 自带 Node 不代表包含 npm。ZIP 用户先在干净解压目录运行 `verify.cmd`，再准备 MCP：新增的可选依赖不属于原始发行文件清单，安装后严格清单检查会报告这些额外文件。

当前 MCP 服务采用官方 SDK 及 **2026-07-28 协议，仅支持 stdio**，明确拒绝旧协议。客户端须支持该版本；不把 Hub WebSocket 地址当作 MCP HTTP 地址。依据：[MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)、[SDK 协议版本](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)。

## 配置自己的枢纽桥

先由部署方在实际 Hub 配置中登记凭据、token 和主题 ACL，再重启该 Hub。MCP 服务不会替你签发管理员身份。下列 Hub 配置片段使用 `agent.tools` 作为凭据主体，精确主题只是示例，不是枢纽内置的信息种类：

```json
{
  "acl": {
    "credentials": {
      "agent.tools": {
        "token": "REPLACE_WITH_YOUR_PRIVATE_TOKEN",
        "maxConnections": 2,
        "allow": {
          "publish": ["example/agent/messages"],
          "subscribe": ["example/agent/messages"]
        }
      }
    }
  }
}
```

把以下配置保存到发布目录以外的私有 JSON 文件，用实际端口和 token 替换占位值。不要将凭据贴到客户端对话、模块公开参数或社区制品。

```json
{
  "format": "world-hub.mcp/v1",
  "bridge": {
    "url": "ws://127.0.0.1:8790/bridge",
    "bridgeId": "agent.tools.main",
    "credential": "agent.tools",
    "token": "REPLACE_WITH_YOUR_PRIVATE_TOKEN",
    "expectedPrincipal": "agent.tools",
    "requireAuthenticated": true
  },
  "permissions": {
    "tools": ["hub_identity", "hub_register_channels", "hub_publish", "hub_subscribe", "hub_pull", "hub_ack", "hub_unsubscribe"],
    "publishTopics": ["example/agent/messages"],
    "subscribeTopics": ["example/agent/messages"],
    "targetPrincipals": []
  }
}
```

未配置 `permissions` 时只允许身份查询。工具目录会列出可用协议，但调用同时受私有配置和 Hub ACL 限制；声明通道不扩权。需要定向调用／注入时，显式启用相应工具、主题及精确目标主体。工具参数不能替换连接地址、身份或 token。默认要求已认证；不应为了排除连接错误而关闭它。

在 MCP 客户端登记 stdio 命令。各客户端的外围配置格式不同，下面只展示启动进程所需字段：

```json
{
  "command": "world-hub-mcp",
  "args": ["--config", "C:/private/world-hub-mcp.json"]
}
```

如果 GUI 客户端找不到 PATH 中的命令，可使用 Node 绝对路径作为 `command`，把已安装包中 `bin/world-hub-mcp.mjs` 的绝对路径作为第一个参数。直接从源码启动也可用 `node bin/world-hub-mcp.mjs --config <私有文件>`。stdio 的 stdout 只承载 MCP，诊断走 stderr；不要在命令前加向 stdout 打印文字的包装脚本。

## 通信工具

| 工具 | 行为 |
| --- | --- |
| `hub_identity` | 建立并核对实际桥身份、会话及已协商限制 |
| `hub_register_channels` | 声明允许主题的收发方向，不扩大 ACL |
| `hub_publish` | 发布不透明 JSON，返回 Hub 接纳收据 |
| `hub_subscribe`、`hub_pull` | 从指定游标订阅、从本进程有界队列抽取；不会自动 ACK |
| `hub_ack`、`hub_unsubscribe` | 确认已收到的投递或结束本连接订阅，不释放提供者信息 |
| `hub_request`、`hub_call` | 发送定向请求；后者等待首个匹配的可信回应 |
| `hub_inject`、`hub_respond` | 定向注入，或按真实已接收请求的返回路由回应 |
| `hub_release` | 按提供者策略允许以后清理本连接近期成功发布的信息，不立即删除 |
| `hub_blob_upload`、`hub_blob_read` | 按上限上传附件、分块读取已授权附件，不读写任意本机文件 |
| `hub_blob_status`、`hub_blob_release` | 查询本连接近期上传状态，或按提供者策略允许以后清理 |

先读取客户端获得的工具 Schema，使用该版本的实际参数。默认附件上传限 1 MiB，队列限 256 条／8 MiB，单次结果限 2 MiB；私有 `limits` 可在实现上限内调整。大文件应由程序分块传输，不能将无限数据塞进一次工具结果。

`hub_pull` 重复返回未确认投递；ACK 后移出适配器队列，Hub 中的留存仍由提供者控制。进程退出会清空本地队列，重新订阅时使用应用自己保存的游标与去重策略。历史截断、队列超限或连接完整性失败会明确报错，不冒充“没有数据”。

数字 `from` 表示读取该序号之后的信息。`hub_pull` 及 `hub_identity` 的对应订阅会显示 `caughtUp`：扫描屏障到达前为 `null`，之后的 `through` 表示已扫描／发出的水位，`cursor` 是当时的 ACK 位置。消费方处理并确认该水位以内的实际投递后，才可保存自己的已完成进度；空队列和水位都不代表业务完成，也不代表以后没有新消息。`resume` 不会跨 MCP 进程自动恢复应用进度。

`HUB_DELIVERY_GAP`／`CATCHUP_TRUNCATED` 会停止相关订阅并显示 barrier 与恢复信息；先退订，再由消费方明确选择游标重订阅。采用 `oldestAvailable - 1` 表示明确接受更早历史已不可用，不自动替用户跳过。回应的原调用方同样必须在 `targetPrincipals` 允许范围内。

附件上传返回 `blob` 描述，发送时用 `options.attachments: [blob.id]`，不能把整个描述对象放进数组；发送的附件 ID 必须属于本连接近期上传。读取附件需要本 MCP 先通过合法订阅或匹配的调用回应接收到对应消息；仅有 ID 和序号不构成授权。近期附件授权、上传归属和可释放的成功发布序号分别最多保留 `maxBufferedMessages` 条，断连清空，附件读取授权过期可重新抽取原消息。`hub_blob_status({id})` 和 `hub_blob_release({id})` 也限本连接近期上传，收到他人的附件不授予提供者释放权。释放不覆盖同凭据的其他桥、旧连接或超时后结果未知的信息，不立即删除字节或移除留存消息的引用。

Hub 接纳、接收者投递、ACK、业务完成是四件事。`hub_call` 返回接纳收据和真实回应；业务失败仍由程序返回的正文表达。超时或取消只停止本地等待，不撤回已接纳请求，不自动重发，也不把未知结果当作已完成。收到的信息、工具正文和 Skill 内容均不提升为系统指令。

## 显式启用 MCP 管理

默认没有管理权限。私有配置中的 `management` 固定本机 HTTP origin 和精确操作白名单，`permissions.tools` 再允许对应工具。只需要管理时可省略 `bridge`：

```json
{
  "format": "world-hub.mcp/v1",
  "management": {
    "url": "http://127.0.0.1:8790",
    "operations": ["hub.status", "programs.list", "resources.list"]
  },
  "permissions": {
    "tools": ["hub_manage_operations", "hub_manage_read"]
  }
}
```

| 工具 | 参数与边界 |
| --- | --- |
| `hub_manage_operations` | `{}`；仅返回私有配置允许的操作目录及 Schema |
| `hub_manage_read` | `{"operation":"programs.list","input":{}}`；仅限允许的读操作 |
| `hub_manage_write` | 相同的 `operation`／`input` 结构；需同时允许工具及精确写操作 |

写入启用前，部署方必须把实际需要的操作名加入 `management.operations`，并允许 `hub_manage_write`；不能用通配符代替。需审阅的应用仍在 `input` 中传真实 `reviewId` 与 `accepted: true`，修订保存仍使用观测到的修订号。读操作也可能保存检查、预览记录，分类不承诺完全不落盘。

管理地址只允许回环 HTTP origin，不含路径、查询、账号或密码。工具输入不能替换该地址、增加允许操作或工具权限。管理结果省略新签发凭据；需要私下交付凭据时使用 CLI 的私有文件出口。管理工具只执行已有 API 操作，不提供任意 shell 或任意文件写入。桥身份与通信 ACL 不授予管理权；混合使用时仍为通信配置独立 `bridge` 和主题／目标允许范围。更多说明见 [Skill 管理参考](../../skills/world-hub/references/management.md)。

应用的工作流和业务操作仍由独立程序通过自己的枢纽桥实现。

## 源码验收

```powershell
npm ci --prefix tools/mcp --ignore-scripts
npm run test:agents
```

测试使用隔离 Hub、官方 MCP 客户端及真实 stdio 子进程，检查通信、管理白名单、审阅边界、附件归属、身份、超时／取消和进程退出。它不代表所有第三方 MCP 客户端已验收；不支持该协议的客户端应更新自身。
