# 跨语言文本台整合包

这个本地样例由三个真实独立程序组成：JavaScript 文本来源、Python 统计提供者、JavaScript 浏览器文本台。每个程序携带自己的 mod 桥源文件，经普通 Hub 完成双向通讯。Runtime 只负责清单校验和程序运行；文本、统计规则、调用顺序和成果都由这三个程序处理。

| 程序 | 入口 | 责任 | 自己保存的状态 |
| --- | --- | --- | --- |
| `demo.source` | `modules/source/program.mjs` | 提供与修改选定原文，信封身份授权 | `source.json` |
| `demo.stats` | `modules/stats/program.py` | 实现 `text.statistics@1.0.0` 精确 UTF-8 统计 | 无业务状态 |
| `demo.desk` | `modules/desk/program.mjs` | 浏览器界面、读取来源、调用统计、保存成果 | `results.json`，最近 20 份成果 |

各目录的 `module.json` 是外部程序部署声明，`bridge-kit.mjs` / `blob-client.mjs` 或 `hub_bridge.py` 是该模块携带的桥，`LICENSE` 保留项目 MIT 许可。Python 的 `websockets` 库需由部署环境另行提供，使用自己的许可。模块不会从仓库外的固定路径导入桥或业务源码。

## 检查、导入与启动

在源码仓库使用 `node bin/world-hub-pack.mjs`，或者在携带该外部工具的分发中使用它提供的 CLI。`pack.json` 描述组合意图，`pack.lock` 锁定模块文件哈希、Hub、平台、解释器和 Python 包版本。先查看锁中的环境要求；不匹配的环境需要显式重新生成锁并重新审阅，不能在导入或启动时静默刷新。

作者需要明确选择另外的预安装解释器或修改模块文件时，使用以下命令重新生成锁，然后重新查看完整审阅结果；不要把重锁当成忽略不明变更的步骤：

```powershell
node bin/world-hub-pack.mjs lock examples/ecosystem-pack --node '<自己选择的node可执行文件>' --python '<自己选择的python可执行文件>'
```

```powershell
node bin/world-hub-pack.mjs plan examples/ecosystem-pack
node bin/world-hub-pack.mjs import examples/ecosystem-pack --root data/pack-runtime --instance text-one
```

查看输出的依赖、文件哈希和声明权限。然后把该次审阅输出的真实 `digest` 用于启动；下面的占位符需替换为完整摘要：

```powershell
node bin/world-hub-pack.mjs start --root data/pack-runtime --instance text-one --trust REVIEW_DIGEST
```

启动器保持前台运行；就绪输出给出实际的浏览器 `entryUrl`。打开它可以选择中文或 English。粘贴中文、emoji 和换行，点击“保存来源并分析”：文本台通过桥请求来源程序保存、再次抽取原文，然后经 Hub 调用真实 Python 程序，验证回应的实际 principal、请求序号和应用合同后保存成果。“分析已保存来源”只抽取来源程序当前保存的文本。

成果区域显示码点、行数、UTF-8 字节数、SHA-256 与真实通讯回执。原文不 trim、不 Unicode 规范化，也不转换换行。上限是 16384 UTF-8 字节；空文本为 0 码点、1 行和 0 字节。

另一终端可以查看或停止实例：

```powershell
node bin/world-hub-pack.mjs status --root data/pack-runtime --instance text-one
node bin/world-hub-pack.mjs logs --root data/pack-runtime --instance text-one
node bin/world-hub-pack.mjs stop --root data/pack-runtime --instance text-one
```

正常停止后，用同一启动命令重启该实例。来源原文和文本台成果仍保留；界面恢复最近一份已保存成果。创建 `text-two` 需要独立导入；两个实例分别使用自己的 Hub、端口、私有凭据和程序状态，默认互不共享。

导出只包含锁定的公开包，目标须为新路径；不包含运行数据、私有配置和凭据。在另一个干净 Runtime 根目录导入导出包，成果开始为空：

```powershell
node bin/world-hub-pack.mjs export --root data/pack-runtime --instance text-one --destination dist/exported-text-desk
node bin/world-hub-pack.mjs plan dist/exported-text-desk
node bin/world-hub-pack.mjs import dist/exported-text-desk --root data/pack-rebuilt --instance rebuilt
```

## 样例的通讯与程序接口

`pack.json` 的 `topics` 提供任意具体主题字符串。当前程序约定读取 `topics.source` 和 `topics.stats`；这些键是这个组合自己的接线约定。主题值没有写入 Hub 内核。模块从自己的 `bridges` 配置读取 endpoint、credential、principal、token、bridgeId 与主题权限，并自行登记通道和建立订阅。`peers.source/stats/desk.principal` 是这个样例的可信通讯地址；正文里的身份字段不能取代真实 `fromPrincipal`。

文本来源合同 `text.read@1.0.0` 的输入是 `{contract:{id:'text.read',version:'1.0.0'},invocationId,command:'read'}`；设置原文则使用 `command:'set'` 并增加 `text`。invocationId 为 1 至 256 个 Unicode 码点；text 必须为良构 Unicode 且不超过 16384 UTF-8 字节。成功返回 `{ok:true,kind:'ecosystem.text-result',contract,invocationId,provider,text,revision}`。失败返回同一合同、调用标识与提供者，加上 `{ok:false,error:{code,retryable:false}}`。来源程序只授权部署配置中的 desk principal。

统计提供者实现公开 [text.statistics 合同](../../docs/modules/text-statistics.contract.json)。它先验证真实调用方，再验证合同版本与完整输入；成功输出和错误形式遵循该合同。替换成实现相同合同的另一份模块时，文本台业务代码保持不变；清单、对应绑定和锁需要审阅并更新。运行清单声明不等同于能力目录广告，也不自动授予业务权限。

文本台的本机 HTTP 接口：

- `GET /state`：`{ok:true,instanceId,busy,version:1,results:[...]}`。
- `POST /analyze`：JSON `{text:'原文'}` 先保存并读取来源；JSON `{}` 读取已保存来源。成功为 `{ok:true,result:{id,completedAt,text,sourceRevision,output,provider,executionId,receipts}}`。
- 每个 receipt 包含 `step`、`requestSeq`、`responseSeq`、`fromPrincipal` 和 `senderSession`，不返回 token。
- 本机 HTTP 拒绝外域浏览器 Origin；同时分析时返回 `ANALYSIS_BUSY`。本地超时返回 `status:'uncertain'`，不会把它当作 Python 一定未执行，也不会自动重试。

三个程序都接受 `--runtime-config <私有JSON文件>`，通过 stdout 输出 `module-ready`；stdin `{"command":"health","id":"..."}` 得到同 id 的 `module-health`；stdin `{"command":"stop"}`、EOF 或正常终止信号关闭本程序所属连接和服务。该生命周期接口独立于 mod 通讯，普通 Hub 程序无需实现它。程序 ready、自报健康、进程存活、Hub 通讯连接和单次业务完成分别观察。

## 验证范围

本包展示本机独立程序组合、跨语言真实通讯、状态保留和包重建。权限字段是声明和启动审阅输入，不是操作系统沙箱。这里不提供在线商店、远程下载、自动安装脚本、任意进程派生、更新迁移或无限容量保证。读取、ACK、停止和重启都不会释放 Hub 中已接纳的记录；由消息提供者决定释放策略。
