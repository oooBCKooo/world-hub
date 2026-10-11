# Launcher：路径选择、创作草稿与任务结果

[English](#english) · [Launcher 使用指南](ecosystem/launcher.md)

Launcher 管理本机整合包、实例和用户操作。Hub Core 仍只负责通信；页面里的目录发现、草稿和任务记录属于 Launcher，不规定外部程序的业务或界面形态。

## 选择本机目录和文件

路径字段提供“选择…”按钮，也保留手动输入。选择器浏览的是 **Launcher 所在电脑的真实文件系统**，通过已认证的本机管理服务读取目录；它不是浏览器上传文件的按钮，也不会把选中的目录上传到社区。

| 目的 | 操作 |
| --- | --- |
| 导入包、创作来源、候选模块、模板、提案 | 浏览目录，选择目录或已知候选 |
| 软件源索引、私有备份、评论交换文件、解释器 | 浏览并选择相应文件 |
| 派生、导出、发布等新目录 | 先选择父目录，再填写一个新的目录名称 |
| 新备份或交换文件 | 先选择保存位置，再填写一个新的文件名称 |

选择器提供可用磁盘、用户目录、桌面／文档／下载等已存在位置，以及 Launcher、示例和来源缓存入口。候选来自已有实例保留的软件包、示例、已获取缓存、本机软件源、最近选择的路径和当前进程已发现的对象。最近路径按用途保存到 Launcher 私有 root，最多保留 32 条；丢失的路径不会被当作可用来源。

选中或输入路径后，页面显示初步识别：名称、版本、声明类型和缺锁等提示。这里只观察文件与有限声明，**不是完整校验**。包、模块、模板与提案仍须通过相应检查；来源身份、内容摘要、运行环境、执行授权和业务结果分别判断。选择解释器文件本身不执行它，随后明确触发的环境检测会运行固定探针。

新的输出路径必须尚不存在，且父目录可用。不要把一个现有目录当成要求新建的输出目录；选择父目录，再提供新名称即可。手动输入 HTTPS 软件源地址继续可用，本机选择器用于本机文件。

## 在所选目录中发现候选

点击“识别当前目录”才启动有限发现。Launcher 不在后台递归扫描整台电脑，也不对磁盘根目录进行递归发现。建议先选一个项目或整合包集合目录。

一次发现最多深入 4 层、观察 2,000 个目录项、读取 256 个目录，返回最多 128 个候选；处理时间预算约 2 秒。声明读取上限为 64 KiB。扫描跳过符号链接、依赖目录和已知运行数据目录，可请求取消。达到边界、跳过部分位置或取消时会显示部分结果，不能据此声称该目录没有其他对象。时间预算在文件操作之间检查，不是慢磁盘上的严格墙钟截止时间。

发现只读取文件并识别声明，不执行解释器、模块、安装脚本或业务程序，也不导入、启动或修改来源。结果保留在当前 Launcher 进程的候选和任务结果中；最近使用路径另行持久保存。选中候选只是填写路径，后续仍需检查与审阅。

## 创作主流程与可恢复草稿

创作工作台以“来源 → 组合与配置 → 生成新包”为主流程。模板、发布、协作和评论放在独立的可展开区块中。选择组件可以突出相关提供者、消费者和合同绑定；这里展示的是静态模块声明与草稿接线，实时信息流另在通信工作台观察。

来源检查通过后，公开配置、绑定、替换选择与 Creator 表单修改会自动保存到 Launcher 私有 root；“立即保存草稿”提供明确保存入口。页面显示“待保存”“正在保存”“已保存”或保存失败。应看到保存成功再关闭页面；浏览器退出提示不保证尚未完成的写入一定成功。

刷新页面或重新打开同一 root 时，可在“继续已保存的草稿”中重新检查并恢复。恢复会重新读取来源基线、检查候选模块和当前环境，不沿用之前的预检或执行授权。来源已变化时拒绝直接套用旧草稿，并保留旧内容供查看。草稿最多保留 32 个来源，总文件上限 2 MiB。

**已保存草稿不等于已生成包，也不等于可以运行。** 生成要求新目录、内容检查与许可确认；生成后再导入新的实例，并明确审阅授权执行。放弃草稿只移除该草稿修改，已生成包和实例保留。草稿是私有本机文件，不自动上传，也不等于加密保险库；公开 settings 中不要写秘密。

## 任务与持续结果

顶部“任务与结果”显示本次 Launcher 进程最近最多 128 项任务，包括获取、导出、备份、生成与目录发现。页面刷新（F5）后仍可重新打开任务中心，查看后台进度、错误和输出路径；可用结果提供复制路径、导入审阅、打开创作或查看实例等下一步。

任务记录 **不跨 Launcher 后台重启保存**。它们不是长期日志或跨机器任务系统；需要长期保留的结果，应保存实际输出文件和所需记录。结果可能含私有路径或数据，应按用途分享。

关闭页面不等于取消后台任务。可取消的任务显示取消入口；“已请求取消”不代表所有文件已撤销，最终结果会报告取消、部分结果或清理问题。停止等短一致性操作需要等待其真实结果。无法连接后台时先恢复连接，再查看当前状态，不凭旧进程 ID 推断或终止程序。

## 导航、语言与日常操作

桌面导航按使用、创作和系统分组，整合包是日常管理入口。小屏通过带名称的导航菜单访问所有页面，语言选择保留完整文字；中文／英文、浅色／暗色提供相同功能。实例详情标签在小屏完整显示，减少寻找隐藏标签的操作。

页面内导航与浏览器前进／返回配合，进入新页面时将键盘焦点放到可辨认的位置；局部编辑和状态更新保留正在输入的表单。刷新状态不会替用户确认授权。枢纽管理用于运行入口与拓扑，通信工作台用于选择 Hub 并进入消息与请求调试；业务结果仍由各程序验证。

---

## English

[中文](#launcher路径选择创作草稿与任务结果) · [Launcher guide](ecosystem/launcher.en.md)

Launcher manages local packs, instances and user operations. Hub Core remains a communication crossroads. Path discovery, drafts and task records belong to Launcher and do not prescribe an external program’s business logic or interface.

### Choose local folders and files

Path fields offer **Browse…** and retain manual entry. The picker reads the actual filesystem on the computer running Launcher through its authenticated local service. It is not a browser file upload, and selecting a folder does not upload it to a community service.

| Purpose | Action |
| --- | --- |
| Import a pack; choose a Creator source, replacement module, template or proposal | Browse folders or select a known candidate |
| Source index, private backup, comment exchange or interpreter | Browse and select a file |
| New derived, exported or published directory | Choose a parent folder and enter a new directory name |
| New backup or exchange file | Choose a parent folder and enter a new filename |

Available locations include drives, the user directory, existing Desktop/Documents/Downloads folders, Launcher, examples and the source cache. Known candidates come from retained instance packages, examples, fetched artifacts, local sources, recent paths and objects discovered in this process. Up to 32 recent paths are stored by purpose in the private Launcher root. Missing paths are not treated as available sources.

Selecting or entering a path shows initial identification: name, version, declaration kind and warnings such as a missing lock. **Identification is not full validation.** Packs, modules, templates and proposals still require their respective checks. Publisher identity, content integrity, environment, execution authorization and business results are separate questions. Selecting an interpreter file does not execute it; explicitly requested environment detection runs fixed probes.

New output paths must not exist, and their parent folder must be available. Select the parent and enter a new name rather than choosing an existing output directory. HTTPS source URLs can still be entered manually; the local picker selects local files.

### Discover candidates in a selected folder

Discovery starts only when you click **Discover in this folder**. Launcher does not recursively scan the computer in the background or recursively discover from a filesystem root. Choose a project or collection folder first.

Each discovery reaches at most four levels below the selected folder, observes 2,000 entries, reads 256 directories and returns 128 candidates, with an approximate two-second processing budget. Declaration reads are limited to 64 KiB. Symbolic links, dependency directories and known runtime-data directories are skipped. You can request cancellation. Limits, skipped locations and cancellation produce partial results; an empty result does not establish that no other objects exist. Time is checked between filesystem operations, so the budget is not a strict wall-clock deadline on slow storage.

Discovery reads files and identifies declarations. It does not execute interpreters, modules, install scripts or business programs, and does not import, start or modify sources. Candidates and task results remain available in the current Launcher process; recent paths are stored separately. Selecting a candidate fills a path and still requires inspection and review.

### Creator workflow and recoverable drafts

Creator follows **Source → Compose & configure → Create a new pack**. Templates, publication, collaboration and comments have separate expandable sections. Selecting a component highlights related providers, consumers and contract bindings. This is a static view of declarations and draft wiring; actual information flow is observed in the communication workbench.

After inspecting a source, public settings, bindings, replacement selections and Creator form changes are automatically saved under the private Launcher root. **Save draft now** provides an explicit save action. The page reports pending, saving, saved or failed status. Wait for a successful save before closing; a browser exit warning cannot guarantee that an unfinished write completes.

After refreshing or reopening the same root, use **Continue a saved draft → Recheck and restore**. Restoration rereads the source baseline and rechecks candidates and the current environment. It does not restore old preflight evidence or execution authorization. If the source changed, Launcher refuses to apply the old draft directly and retains it for inspection. Up to 32 source drafts are retained, within a two-MiB registry limit.

**A saved draft is neither a generated pack nor permission to execute.** Generation requires a new output directory, content checks and license confirmation. Import the result as a new instance, then explicitly review and authorize execution. Discarding a draft retains generated packs and instances. Drafts are private local files, not automatic uploads or encrypted secret storage; do not put secrets in public settings.

### Tasks and persistent results

**Tasks & results** in the top bar shows up to the latest 128 tasks in this Launcher process, including fetches, exports, backups, authoring and path discovery. After a page refresh (F5), reopen it to inspect progress, errors and output paths. Applicable results offer next actions such as copying a path, importing for review, opening Creator or viewing an instance.

**Task history does not survive restarting the Launcher backend.** It is not a long-term journal or a distributed task service. Retain actual output files and any records needed for longer-term use. Results can include private paths or data; share them selectively.

Closing the page does not cancel a background task. Cancellable tasks offer a cancellation action. “Cancellation requested” does not mean every file has been rolled back; the final result reports cancellation, partial results or cleanup problems. Short consistency operations such as stopping must finish and report their actual outcome. Reconnect before checking current state; an old process ID is not evidence or authority to terminate a program.

### Navigation, language and daily use

Desktop navigation groups use, creation and system pages, with packs as the daily management entry. Small screens use a menu with page names and a readable language selector. Chinese/English and light/dark themes provide the same functions. Instance detail tabs remain visible on small screens.

In-app navigation works with browser back/forward, and keyboard focus moves to an identifiable position on a new page. Local editing and status updates retain form input. Refreshing observations does not confirm execution authorization. Hub management focuses on running entry points and topology; the communication workbench selects a Hub for message and request debugging. Applications remain responsible for verifying business results.
