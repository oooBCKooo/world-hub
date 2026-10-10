# Optional hosted Workshop / 可选托管社区

Workshop is an independent artifact discovery and sharing service. It provides an invite-only account system, immutable module and pack publications, an open software-source index, plain-text comments, and proposals tied to an exact artifact digest. It never starts uploaded programs or controls local Hub/Launcher instances. Local tools continue to work without Workshop.

Workshop 是独立的作品发现与分享服务，提供邀请制账号、不可覆盖的模块／整合包版本、开放软件源索引、纯文本评论，以及绑定精确制品摘要的改进提案。它不启动上传程序，不控制本地 Hub 或 Launcher。社区不可用时，本地工具仍能独立工作。

## Use / 使用闭环

1. Open the Workshop page. Guests can search by name, ID, publisher, kind, or exact capability contract ID, inspect license/platform metadata, and download published JSON artifacts.
2. An administrator creates a one-time invitation; the developer registers with a username and password. The invitation is shared through a channel chosen by the administrator; the service does not automatically message anyone.
3. In the local Launcher creator workbench, publish a prepared module or pack into a new directory. Upload the resulting `artifact.json` (`world-hub.source-artifact/v1`), inspect its preview, and explicitly acknowledge redistribution rights and licenses.
4. Copy the Workshop `index.json` URL into the local Launcher software-source view. Inspect the index, select an entry, retrieve and verify it, then separately import/review/start it in the normal local flow. Downloading or publishing never starts an instance.
5. Post a plain-text comment or upload a complete improved artifact as a proposal against the current publication's SHA-256. A proposal preserves the base kind and ID, stays separate from the publication, and never applies itself. The publisher downloads and reviews it locally before deciding to publish another version.

1. 访客在社区浏览作品，按名称、ID、发布者、类型或精确能力契约 ID 筛选，读取许可证／平台信息并下载 JSON 制品。
2. 管理员生成一次性邀请，由其自行选择渠道提供给开发者；开发者以用户名和密码注册。服务不会自动向任何人发送邀请。
3. 在本地 Launcher 创作工作台将准备好的模块或整合包发布到新目录，选择其中的 `artifact.json` 上传。先核对预览，再明确确认再分发权与许可证。
4. 将社区 `index.json` 地址添加到本地 Launcher 软件源中，审阅索引并取得摘要校验后的作品。随后独立完成本地导入、代码／环境审阅与启动；下载和发布都不启动实例。
5. 评论是纯文本。提案是针对当前制品 SHA-256 的完整修改制品，保持基线作品的类型与 ID，独立保存、不自动合并。发布者在本地下载和审阅后，自行决定是否采用及发布新版本。

The browser interface supports Chinese and English and remembers only the selected language in local storage. Session tokens use an HttpOnly cookie; CSRF tokens remain in page memory. Passwords and invitations are not saved to browser storage. An optional local Launcher shortcut opens a user-entered loopback address in a separate window, without making local API requests or forwarding credentials.

界面支持中英文切换；浏览器持久存储仅保存语言选择。会话凭据保存在 HttpOnly Cookie 中，CSRF 令牌只在页面内存中使用。密码和邀请不写入浏览器存储。可选本地 Launcher 入口只在独立窗口打开用户填写的回环地址，不请求本机 API，不转发社区凭据。

## Run the service / 运行服务

The initial reference deployment uses Node.js 22, one server process, a private loopback listener, and an existing HTTPS reverse proxy on port 443. Workshop mounts at `/workshop`. Keep its private configuration and data outside the public code checkout. Do not expose the loopback port or any local Launcher management endpoint publicly.

初期参考部署使用 Node.js 22、单个服务进程、私有回环监听和已有的 HTTPS 443 反向代理，路径为 `/workshop`。私有配置与数据放在公开源码目录之外。公网入口只转发社区路由，不公开回环端口或本地 Launcher 管理接口。

Example private configuration (replace the domain and data path for your deployment):

```json
{
  "root": "/var/lib/world-hub-workshop",
  "baseURL": "https://community.example/workshop",
  "bind": "127.0.0.1",
  "port": 8970,
  "allowedHosts": ["community.example"],
  "diskQuota": 536870912,
  "secureCookie": true
}
```

Initialize the first administrator once with `tools/workshop/cli.mjs --config <private-config> --initialize-admin <username> --password-stdin`, piping the password through a secret-input mechanism. The alternative `WORLD_HUB_WORKSHOP_ADMIN_PASSWORD` is consumed by initialization and removed from its process environment. Do not embed a password in a shell command, repository file, or log. Initialization is refused after any account already exists. Start the service with `tools/workshop/cli.mjs --config <private-config>`. `--help` lists supported operations.

首次使用 `tools/workshop/cli.mjs --config <私有配置> --initialize-admin <用户名> --password-stdin` 初始化管理员，通过秘密输入方式将密码传入标准输入。另可通过 `WORLD_HUB_WORKSHOP_ADMIN_PASSWORD` 提供密码，初始化会消费并从其进程环境移除该变量。不要将密码写入命令文本、仓库文件或日志。已有账号后拒绝再次初始化。用 `tools/workshop/cli.mjs --config <私有配置>` 启动服务，`--help` 可查看支持的操作。

The proxy must preserve the configured `Host` and Workshop URL path. Browser mutations require the exact configured Origin; requests from other origins are refused. Production uses HTTPS and Secure cookies. Explicit insecure loopback mode exists only for isolated local tests. `X-Forwarded-For` is ignored for identity/rate decisions.

代理需保留已配置的 `Host` 与社区路径。浏览器写操作要求精确匹配配置中的 Origin，拒绝其他来源。生产环境使用 HTTPS 与 Secure Cookie；显式的不安全回环模式仅供隔离本地测试。服务不以 `X-Forwarded-For` 作为身份或限流依据。

## HTTP contract / HTTP 接口

All paths below are relative to `/workshop`. JSON errors have the form `{ "error": { "code": "...", "message": "..." } }`. Mutations use `Content-Type: application/json`, the exact Workshop Origin, and (except login/register) the `X-CSRF-Token` obtained from the session endpoint. Cookie authentication is independent of all local Launcher credentials.

以下路径均相对 `/workshop`。写操作使用 JSON 和精确 Origin；登录／注册之外还需提供会话接口返回的 `X-CSRF-Token`。社区 Cookie 身份与本地 Launcher 凭据彼此独立。

| Endpoint | Request / behavior |
| --- | --- |
| `GET /api/me` | `{ user: null }` for guests; authenticated user metadata and `csrfToken` for sessions |
| `POST /api/login` | `{ username, password }` → user metadata, CSRF token and HttpOnly cookie |
| `POST /api/register` | `{ username, password, invitation }` → a member session; one-time invitation consumed |
| `POST /api/logout` | `{}` → revoke the current session and clear its cookie |
| `GET /api/catalog` | Optional `search`, `kind=module\|pack`, `contract`, `offset`, `limit`; returns publications and total |
| `GET /api/publications/:entryId` | Publication, source entry, comments and proposal metadata |
| `POST /api/publications` | `{ artifact, redistributionAcknowledged: true, title? }`; exact same version/digest is idempotent; another digest cannot overwrite it |
| `GET /index.json` | Open `world-hub.source-index/v1`; visible publications with HTTPS artifact URLs and SHA-256 |
| `GET /artifacts/:sha256.json` | Stream immutable, publicly visible `world-hub.source-artifact/v1` JSON bytes |
| `POST /api/publications/:entryId/comments` | `{ text }`; authenticated, plain text |
| `POST /api/publications/:entryId/proposals` | `{ artifact, baseSha256, redistributionAcknowledged: true, title? }`; exact current base required |
| `GET /api/publications/:entryId/proposals/:proposalId` | Proposal metadata and artifact; no automatic application |
| `POST /api/invitations` | Admin `{}` → one-time invitation and expiration |
| `GET /api/users` | Admin account metadata only; no passwords or session secrets |
| `POST /api/users/:id/status` | Admin `{ disabled: boolean }`; disabled accounts cannot authenticate or mutate |
| `POST /api/publications/:entryId/visibility` | Admin `{ hidden: boolean }`; hidden entries leave public discovery/download paths |
| `GET /health` | Service health without credentials or private filesystem details |

The Workshop artifact upload is limited to **8 MiB for the whole JSON request**, which is intentionally smaller than the general static artifact format's maximum. A file preview below 8 MiB can still exceed the limit after JSON request encoding; the server explicitly refuses it. Base64 source files, manifests, safe paths, exact hashes, duplicate paths and package locks are independently validated. Upload validation runs in a separate staging area, creates no module process, and does not probe a module interpreter.

社区上传限制是**整个 JSON 请求不超过 8 MiB**，初期部署有意小于通用静态制品格式上限。文件预览低于 8 MiB 仍可能因请求编码超过上限，服务端会明确拒绝。服务独立验证 Base64 文件、清单、安全路径、精确摘要、重复路径与包锁；验证只使用独立暂存区，不创建模块进程或探测模块解释器。

## Bounds, trust and moderation / 配额、信任与管理

The initial service deliberately uses finite capacity: a default 512 MiB artifact budget, 16 MiB metadata limit, at most 128 accounts, 256 publications per publisher, 100 comments and 32 proposals per publication, and one upload validation at a time. Bounded request deadlines, download concurrency and rate limits reject excess work explicitly. Account password derivation is serialized with a bounded queue. Administrators can issue invitations, disable accounts and hide works; there are no public administrator-bootstrap or execution endpoints.

初期服务使用有限资源：默认 512 MiB 制品预算、16 MiB 元数据上限、最多 128 个账号、每个发布者最多 256 件作品、每件作品最多 100 条评论和 32 个提案，同时只验证一个上传。请求期限、并发下载与限流有明确界限，超限直接拒绝。密码派生串行执行且队列有界。管理员可发邀请、停账号和隐藏作品；不存在公网管理员初始化或代码执行接口。

A digest proves content identity relative to an index, not author identity or code safety. License fields are publisher declarations. Hosted moderation affects hosted visibility, not already downloaded copies. The trusted-local Runtime does not provide an OS sandbox; independently review code and permissions before running it. Workshop intentionally does not load a local management token, embed the privileged Launcher UI, evaluate uploaded source, or decide application business behavior.

摘要证明相对索引的内容身份，不证明作者身份或代码安全。许可证是发布者声明。社区管理只影响托管展示，无法撤回已经下载的副本。本地 Runtime 不提供 OS 沙箱；执行前需独立审阅代码与权限。Workshop 不读取本地管理令牌、不嵌入特权 Launcher 界面、不执行上传源码、不决定程序业务行为。

## Moving to a larger server / 迁移到更大服务器

Keep metadata and immutable artifact files together. For a consistent export, gracefully stop the running service with `tools/workshop/cli.mjs --config <private-config> --stop`, confirm that it released its owned data lock, then use `tools/workshop/cli.mjs --config <private-config> --export <new-private-directory>`. The private stop request names the current generation's nonce; it never kills a recorded PID. Stop the service supervisor or disable automatic restart for the maintenance window as well. A retained lock after a crash requires investigation before removal. The export preserves accounts, publications, comments, proposals and exact artifact bytes, while excluding the process owner lock. Metadata includes password hashes and session/invitation hashes: this is a private backup containing credentials, not a publishable source bundle. Do not copy an active data directory as a consistent backup.

迁移时元数据与不可变制品一同保存。先用 `tools/workshop/cli.mjs --config <私有配置> --stop` 优雅停机并确认其释放所属数据锁，再运行 `tools/workshop/cli.mjs --config <私有配置> --export <新的私有目录>` 得到一致性导出。私有停机请求指定当前代次的 nonce，不会杀死记录的 PID。维护期间同时停止进程监管器或禁用自动重启；崩溃留下的锁需先调查再处理。导出保留账号、作品、评论、提案与精确制品字节，排除进程所有者锁。元数据包含密码摘要及会话／邀请摘要：它是包含凭据的私有备份，不是可发布源码包。不要把运行中数据目录的普通复制称为一致性备份。

Place the exported contents in a fresh private root on the new server, restore directory permissions, configure the new HTTPS origin/Host allowlist, and start one owner. Existing artifact digests remain unchanged; generated index URLs follow the configured new origin. Developers can update their optional software-source URL or retain the old domain through a reviewed reverse-proxy migration. Cached verified artifacts and local instances continue to work independently. Existing sessions/invitations retain their finite expiration; a new origin requires signing in again because credentials are not forwarded. Test health, catalog, artifact hashes, login, comments and proposal retrieval before switching traffic.

在新服务器的空私有目录放入导出内容，恢复目录权限，配置新的 HTTPS Origin／Host 白名单，只启动一个服务所有者。制品摘要保持不变，索引 URL 根据新配置生成。开发者可更新可选软件源地址，也可通过审阅后的代理迁移保留域名；已验证缓存与本地实例独立可用。已有会话／邀请保留其有限有效期；更换 Origin 后需重新登录，凭据不会转发。切流量前验证健康接口、目录、制品摘要、登录、评论与提案读取。

This is an initial hosted loop, not a claim of large-scale availability, replicated storage, social-network moderation, real-time collaborative editing, publisher signatures, or an execution sandbox. Those can be supplied by independent community services and transport profiles without turning Hub Core into a business platform.

当前实现是初期托管闭环，不代表大规模可用性、复制存储、完整社交平台治理、实时协作编辑、发布者签名或执行沙箱。后续可由独立社区服务与传输方案扩展这些能力，不将 Hub Core 变成业务平台。
