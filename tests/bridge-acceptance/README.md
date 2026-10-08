# 候选 mod 桥验收装置

通过 manifest 选择候选可执行文件和 argv。候选桥必须自行打开 WebSocket；Node 控制器安排隔离 Hub、参考程序和断言，不替候选发送 Hub 消息。控制绑定采用 NDJSON，只是测试接口，不规定真实程序的语言、进程或 mod 形态。

```powershell
node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/javascript.json
node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/python.json
node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/powershell.json
node tests/bridge-acceptance/control-check.mjs
```

三个 manifest 依次选择参考 JS、Python、PowerShell 独立 worker；准备所需环境见[验证](../../docs/verification.md)。自己的桥可提供自己的 manifest 和适配程序，不需复制参考 worker 的业务代码。

## Manifest

```json
{
  "name": "my-candidate",
  "command": "python",
  "args": ["{root}/my-adapter.py", "--url", "{url}", "--bridge", "{bridge}", "--credential", "{credential}", "--token", "{token}"],
  "cwd": "{root}",
  "sources": ["{root}/my-adapter.py"],
  "profiles": ["base", "directed", "blob"]
}
```

`command` 是可执行文件，不经过 shell；`args` 是字符串数组。占位符 `{root}`、`{url}`、`{bridge}`、`{credential}`、`{token}` 由装置替换，身份与 token 每次隔离生成。`cwd` 默认仓库根；`sources` 可选，声明文件仅进行哈希记录，不意味完成源码审计。候选文件须实际存在。

`profiles` 必须是无重复的数组并包含 `base`，可额外选择 `directed`／`blob`。未选择的检查记 `notExecuted`；选中但失败前未到达的检查记 `selectedButNotReached`。没有真实 ready、提前退出 0、畸形输出和不合法 profile 都必须失败，`control-check.mjs` 检查这些报告规则及以前结果不被覆盖。

## 控制与观察

成功握手后，候选输出真实 ready，PID 必须属于装置启动的进程，version 和 language 不得为空。每份接收帧先输出完整原文及诊断视图；拒绝握手先输出真实 denied，再报告错误并以非零退出。

```json
{"event":"frame","frame":{"type":"welcome"},"raw":"完整 Hub 帧原文"}
{"event":"ready","language":"my-language","version":"runtime-version","pid":123,"welcome":{"type":"welcome"}}
{"id":"command-id","ok":true}
```

示例省略 welcome 的完整字段；真实输出必须含真实 welcome。stdin 每行一个命令，stdout 仅 NDJSON，程序诊断可写 stderr：

```json
{"id":"s1","action":"send","frame":{"type":"subscribe","token":"s1","filters":["my/topic"],"from":0}}
{"id":"p1","action":"send","raw":"{\"type\":\"publish\",\"topic\":\"my/topic\",\"body\":{\"n\":9007199254740993}}"}
{"id":"close","action":"close"}
```

`send` 的 `ok:true` 只证明候选本地发送完成，不是 Hub 接纳。接收要在 stdin 空闲时继续输出，不能因等待下一命令阻塞收帧。`close` 有限正常关闭、响应命令并退出 0；无法继续通讯的错误不能假报成功。

| Profile | 实际检查 |
| --- | --- |
| base | 7 组：认证握手／原始拒绝、动态主题双向发布、正文原文、并发订阅回执／屏障、水位与非法游标、分订阅 ACK／提供者释放、有限关闭 |
| directed | 请求／可信回应、注入、关联及旁观遮挡 |
| blob | 双向 1 MiB + 37 B 分块附件、SHA-256、引用权限与释放权 |

装置以 token 关联并发订阅，但 token 在线协议仍是可选字段。验收自己的功能 profile 和资源边界，不要求所有桥具有高层 API、统一等待秒数或自动恢复策略。

## 结果

报告保存新的 `.artifacts/evidence/bridge-acceptance/` 运行目录，可通过 `--evidence <父目录>` 改位置，每次仍新建子目录。报告记录候选 manifest、所选 profile、实际检查、独立进程、运行时、Hub 退出、源码哈希和清理状态。

通过只说明该候选和已选范围。没有覆盖重连、持久游标、任意崩溃、上传中断、乱序 ACK、长时间压力、所有第三方桥或外部业务成功。附件块由外部控制程序产生和核对，不因此交付所有语言的文件 SDK；原文断言使用 raw，不把可能损失精度的诊断值当作原文。
