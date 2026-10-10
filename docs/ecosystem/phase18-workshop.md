# Workshop → Launcher reproducible closure / 可复现生态闭环

This acceptance connects the existing Workshop, static-source registry, creator workbench and trusted-local Runtime. Hub Core remains a communication crossroads. The test actors are two automated accounts. They are not independent human developers; independent human acceptance remains pending.

本验收把现有 Workshop、软件源、创作工作台与 trusted-local Runtime 串起来，不另建社区，不往枢纽加入业务。作者 A 与用户 B 是两个自动测试账号；这不等于两个独立真人作者，真人独立验收仍保留待办。

## Run / 运行

Use a clean source checkout with Node.js 22.4.0 or later and a writable temporary directory. This scene uses a Node statistics fixture and needs no Python, Docker, public server account or production credentials. It installs no dependencies and contacts no production community.

在干净源码仓库中使用 Node.js 22.4.0 及以上版本，确保临时目录可写。本场景使用 Node 统计模块，不需要 Python、Docker、公网服务器账号或生产凭据，不安装依赖，不访问生产社区。

```sh
node --test --test-timeout=180000 tests/integration/workshop/phase18-closure.test.mjs
```

The same scene is included in `npm run test:workshop` and the Node CI job. It starts fresh loopback Workshop and Launcher servers, performs their real authenticated HTTP operations, executes actual mod-bridge communication and closes its owned processes. A unique report is retained under `.artifacts/workshop-phase18/runs/`; `latest.json` points to the latest execution. The report contains hashes, trust dimensions, real application output, receipts and negative-scenario diagnostics, without passwords, cookies, CSRF values or Launcher tokens. Temporary source, community data and instance data are removed after cleanup.

同一场景已由 `npm run test:workshop` 自动发现，并由现有 Node CI 执行。测试新建回环 Workshop 与 Launcher，走真实认证 HTTP 接口，运行真实 mod 桥通讯，结束后关闭所属进程。报告保存在 `.artifacts/workshop-phase18/runs/` 的独立目录，`latest.json` 指向最近一次执行。报告包含摘要、信任维度、应用结果、通讯回执和负例诊断，不包含密码、Cookie、CSRF 值或 Launcher 令牌。临时源码、社区数据与实例数据在退出后清理。

## Verified sequence / 验证顺序

| Step / 步骤 | Evidence / 验证内容 |
| --- | --- |
| A publishes / A 发布 | A 注册独立账号，在本机构建模块制品并上传 `1.0.0`。社区记录发布账号、许可证、平台、精确合同与 SHA-256，不执行源码。 |
| B discovers / B 发现 | B 的本地 Launcher 注册软件源，审阅索引，取得与 Workshop 相同摘要和文件的模块。下载前先验证缺失制品与损坏字节会失败，修复后显式重试。 |
| B combines / B 组合 | 在原包的统计组件上预览候选声明与差异，派生到新目录；消费方源码摘要保持不变。预览的 `businessValidated` 仍为 `false`。 |
| B runs / B 运行 | 导入新实例后，导入前的审阅不能启动它；对新实例重新审阅并明确接受才可运行。真实文本台经 source → Hub → stats → Hub → desk 返回统计结果与三个回执。 |
| B gives feedback / B 反馈 | B 对精确版本评论并提交绑定原 SHA-256 的完整提案；提案未进入软件源，也不改变原版本。 |
| A reviews / A 审阅 | A 下载提案到新的本地目录，检查精确摘要与模块声明，自行重新构建并发布 `1.0.1`。这里的静态验证不会被报告为业务验证。 |
| History and conflicts / 历史与冲突 | 原 `1.0.0` 仍按摘要下载。同版本其他字节被拒绝；向 `1.0.1` 提交却带着 `1.0.0` 摘要的提案被拒绝。 |
| Hidden and offline / 隐藏与离线 | 隐藏原版本后，托管索引和下载不再公开它；Launcher 记录 withdrawn，在线旧索引不能偷偷获取它。已取得源码与正在运行的实例仍可工作。社区停止且来源不可用后，以先前审阅的摘要取得缓存时重新校验；实例仍可运行，也可在重新审阅后离线重启。 |

An immutable old publication does not become a stale proposal baseline merely because a newer version exists. `BASELINE_CHANGED` means the submitted digest differs from the exact publication selected by the proposal request. A valid proposal against the original immutable version can remain valid.

出现新版本不会让旧的不可变版本自动失去提案资格。`BASELINE_CHANGED` 表示所提交摘要与这次请求选定的精确发布版本不一致；针对原版本且摘要正确的提案仍可能有效。

The fixed text input produces 58 Unicode code points, 3 LF-separated lines, 63 UTF-8 bytes and SHA-256 `7a28a4dfd6d0c448b1bed99fa5f76a0d566a8cc7b3d0a114c1df0a8a77747c1a`. This scene deliberately preserves the existing consumer source, including its legacy `python-statistics` receipt-step label. That label is application text; the tested provider manifest uses Node. Runtime language is determined by the reviewed manifest, not an application receipt label.

固定文本应得到 58 个 Unicode 码点、3 行、63 个 UTF-8 字节，以及 SHA-256 `7a28a4dfd6d0c448b1bed99fa5f76a0d566a8cc7b3d0a114c1df0a8a77747c1a`。本场景有意保留现有消费方源码，包括其历史 `python-statistics` 回执步骤名称；它只是应用文字，这次被测提供者清单使用 Node。运行语言以审阅过的清单为准，不由回执文字推断。

## Independent trust dimensions / 分开的信任维度

| Dimension / 维度 | This test proves / 本测试证明 |
| --- | --- |
| Publication account / 发布账号 | Workshop 通过其自己的账号与会话记录 A 为作品所有者；这不是可选发布者签名，也不是现实身份认证。 |
| Content integrity / 内容完整性 | 下载后的 source receipt 为 `integrityVerified: true`，代码与所选索引的精确摘要一致。`publisherIdentityVerified`、`codeSafetyVerified` 仍为 `false`。 |
| Execution authorization / 执行授权 | source receipt 的 `executionAuthorized` 为 `false`；只有新的实例审阅加明确接受，才执行当前代码。模块组合后产生新的包，必须单独审阅；单个模块的下载回执不认证整个派生包。 |
| Application behavior / 应用行为 | 仅真实执行、应用结果断言与 Hub 回执证明本场景中的统计业务通过；合同声明匹配本身不证明业务结果。 |
| Isolation / 隔离 | 本场景使用 `trusted-local`，source receipt 的 `sandbox` 为 `false`。哈希、社区账号或实例私有目录不构成 OS 沙箱。 |

## Diagnostic cases / 可诊断负例

| Scenario / 场景 | Expected result / 预期结果 |
| --- | --- |
| Missing artifact / 制品缺失 | Launcher 操作失败，保留 `ENOENT`、具体原因与中英文操作指导；不会运行下载内容。 |
| Wrong download hash / 下载摘要不符 | `Downloaded artifact hash mismatch`，内容变更类诊断；不会安装损坏缓存。 |
| Same version, changed bytes / 同版本不同字节 | Workshop `IMMUTABLE_VERSION`，要求发布新版本。 |
| Wrong exact proposal baseline / 精确提案基线错误 | Workshop `BASELINE_CHANGED`，要求核对请求选定版本的 SHA-256。 |
| Online index withdrawal / 在线索引撤回 | 旧来源审阅失败为 `Source index changed`，重新选择；不会以旧索引静默绕过已观察到的变化。 |
| Reusing an import review to start / 用导入审阅启动 | Launcher `REVIEW_REQUIRED`，要求审阅当前实例。 |
| Start without acceptance / 未接受启动 | Launcher `TRUST_REQUIRED`，下载或声明匹配不会代替用户执行授权。 |

Community visibility is not remote revocation of local software. Offline cache reuse retains the previously selected source and index digest, revalidates archive and extracted files, and grants no execution authorization. A changed online index is not treated as an outage. Removing source registration or hiding a hosted work does not erase existing instance code or restore application data, external side effects or messages.

社区隐藏不是对本地代码的远程撤销。离线缓存使用保留先前选择的来源与索引摘要，并重新验证制品及解包文件，不授予执行权。在线索引变化不会被当作断网而回退。移除来源或隐藏托管作品不会删除实例代码，也不会回滚应用数据、外部副作用或已发送消息。

## Transport and acceptance limits / 传输与验收边界

The source downloader deliberately requires HTTPS and rejects loopback addresses; local test mode must not weaken that policy. A small test transport adapter obtains the actual anonymous Workshop index and artifact HTTP responses and stores a local static mirror. Artifact bytes and SHA-256 remain exact; only artifact URL references become relative local paths. Launcher then uses its actual source registration, review, fetch, hash validation and cache APIs. This tests role and tool integration without a public domain or credentials. It does **not** verify public HTTPS/TLS transport or browser usability.

软件源下载器有意要求 HTTPS 并拒绝回环地址，本地测试不应削弱此策略。小型测试适配器通过真实 Workshop HTTP 下载匿名索引与制品，保存为本地静态镜像；制品字节与 SHA-256 不变，仅将索引制品 URL 改为相对文件路径。随后 Launcher 走实际的来源注册、审阅、取得、摘要校验与缓存接口。这样可以在不需要公网域名或凭据的条件下验证角色和工具闭环，但**不验证公网上 HTTPS／TLS 传输，也不等于浏览器易用性验收**。

The reusable helper exports `workshopCall`, `registerMember`, `launcherClient`, `prepareNodeScene`, `mirrorWorkshop` and `unpackForAuthorReview`. A separately authorized production acceptance can supply an HTTPS Workshop URL and in-memory credentials to the HTTP helper, and use that real HTTPS source directly instead of calling `mirrorWorkshop`. Do not commit account secrets or point the local automated scene at a production community. Cross-language independent-module acceptance and the real-human checklist remain separate deliverables.

可复用 helper 提供 `workshopCall`、`registerMember`、`launcherClient`、`prepareNodeScene`、`mirrorWorkshop` 与 `unpackForAuthorReview`。另行获授权的生产验收可以传入 HTTPS 社区地址及内存中的账号凭据，并使用真实 HTTPS 软件源取代 `mirrorWorkshop`。不要把秘密提交入仓库，也不要将此本地自动场景改为访问生产社区。跨语言模块互操作和真人操作清单仍分别验收。
