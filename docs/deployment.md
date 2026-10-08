# 部署与容量

世界枢纽提供通讯核心、本机管理界面、可选桥与构建工具。wire 为 0.1，附加能力通过 directed-v1／blob-v1 协商。mod 可声明通道、发布／抽取、请求／回应、注入和分块附件；世界、上下文、模型、工作流和成果判断由外部程序负责。独立程序示例展示这些通讯能力的接入与组合方式。

## 现行入口与部署范围

通过 npm 安装可使用 `world-hub` CLI，安装、初始化和 JavaScript SDK 入口见[npm 包](npm.md)。下列 `npm start`、`npm run check` 等命令是克隆源码仓库后的入口。

从仓库根目录执行 `npm run check` 做只读配置与环境检查，`npm start` 使用部署启动器，`npm run hub` 直接启动原服务。浏览器访问启动输出的 `/manage`，Ctrl+C 停止自己启动的服务。自定义配置可用 `node scripts/launcher.mjs --config <path>`；只调试服务用 `node src/hub/hub-server.mjs --config <path>`。源码和分发包使用相同 `src/`、`sdk/`、`config/` 路径，开发与演示命令见[开发](development.md)。

配置加载在打开存储前拒绝非法日志容量、ACL 容器、条目、权限数组和过滤器；原服务与启动器检查共用验证。工作台提供主体草稿、筛选和明确的过期／历史连接状态，方法见[操作体验](specs/operations.md)，不改变提供者的留存许可。

Windows x64 便携分发包使用 `start.cmd` 与 `scripts/launcher.mjs`，带固定核验的 Node 22.23.2 和完整许可，不附 npm、Python、PowerShell 或 DSH 安装。`config/hub.json` 相对数据路径指向 `data/log`、`data/blobs` 和 `data/management.json`；首次运行才创建数据。启动器在服务打开存储前持有数据目录锁，正常关闭只释放自己的锁；直接启动原服务不受该锁保护。检查、构建与迁移见[分发](releases.md)。

当前本机验证与 CI 目标均为 Windows，实际运行时由各次报告记录。Linux、跨机器和任意第三方桥未因此验收；不能把 Windows socket、尾行修复、段轮转或特定语言互操作结果推广到其他部署。

本机管理和调试将回环访问者视为同一信任域，可以查看全部保留正文，不隔离同机不同账号／应用。无 token 接入仅允许已配置的可信回环身份，标记 `authenticated:false`，不能证明来源防伪。需要通信身份验证时配置 token 和主题 ACL。跨机器部署应另设可信 TLS 终结／隧道、网络访问控制；多租户还需要独立管理信任域，普通程序使用带主题权限的桥，不能把裸露的本机调试端点当租户 API。这些是部署前提，不是已交付的跨机方案。

## 看容量与恢复

启动 `ready.storage`、`GET /status` 的 `storage` 与管理界面“系统留存与容量边界”使用同一日志／附件摘要。日志提供最旧段未释放主体的 `principal`、`firstSeq`、`lastSeq`、`count`；它只说明该段的保护归属，不评价提供者的数据价值。旧记录无可恢复身份时显示身份未知。`unusedSegmentSlots` 是尚未使用的段位；`activeSegmentTargetRemainingBytes` 是活动段距离轮转目标的字节，**不是精确剩余可写容量**：记录大小不定，超过目标的一条记录可以独占段。

日志默认 8MiB 目标／段 × 8 段；这不是严格 64MiB 总字节上限。最旧段含未释放消息且没有新段位时，任何提供者的新发布都可能返回 `LOG_CAPACITY`。已有消息读取、ACK、提供者 release 和连接管理仍可用。恢复同一稳定主体及其凭据，由提供者按自己的策略释放；整个最旧段可清理后，后续追加才可轮转。也可修改容量配置后重启。暂停、断连、移除凭据、读取或 ACK 都不会释放；管理不提供强制删除或代发释放。通过普通消息通知提供者也受当前日志容量约束，不能保证满容量时可发送。

附件预约含未完成上传。`reservedBytesExact`、`remainingBytes`、`releasedBytes`、`reclaimableBytes` 是精确十进制字节字符串；`remainingObjectSlots` 是空闲对象位，零字节对象也占位。可回收量只含提供者已 `blob_release` 且无短期追加 pin 的对象，仍然占用预约，下一次 `blob_begin` 才按容量需要回收。预约池满不等于必须重启；只有调高配置上限目前需要重启。短期 pin 只保护一次附件消息追加，不等到消费者处理完。

消息与对象寿命独立。`release` 消息不会释放对象；`blob_release` 不立即删除对象，但会拒绝新消息引用。已获得保留消息授权的读者在对象真正回收前仍可 `blob_read`；回收后可能仍读到消息的附件描述符，却得到 `BLOB_NOT_FOUND`。读者应实际读取并处理 `BLOB_NOT_FOUND`／`BLOB_DENIED`；`blob_status` 是提供者专用操作，不能作为其他读者的状态探测入口。

实时窗口或补课队列溢出会发送 `overflow`，通常另写 gap。gap 与主日志共享容量，落盘可能失败；已接纳主消息仍成功且受保护。`counters.gapLogFailures` 与 `lastGapLogFailure` 保存本次进程失败数、最近缺口及原因，重启归零；近期 trace 也有界。没有独立的永久诊断通道，不承诺容量满时所有 gap 都能持久保存。读取到旧消息也不证明该次实时投递没有缺口。

## 扩容与补课

普通消息的整个保留窗口驻留内存，包含解析视图、原文、索引及运行时开销；附件正文独立落盘，逐块读写，不常驻全部附件。对象操作串行、不承诺公平调度。

部署内存预算应包括**空 Hub 基线工作集 + 随保留窗口增长的驻留部分 + 连接及进行中操作的余量**。基线包含运行时开销，随机器、版本和负载变化，不能承诺固定常数。离散 WorkingSet 快照不等于峰值，冷启增量与日志字节的倍率只描述增长部分，不能充当总内存成本。

扩容前须用目标载荷、条数、并发与目标机器实测，不能按磁盘字节统一推算内存比例。可选恢复工具 `scripts/test-recovery.mjs` 保存当前运行的测量，结果留在本机 `.artifacts/evidence/`。

`limits.catchUpBatchSize` 默认 256，`maxCatchUpMessages` 默认 5000；实际单批还受订阅剩余窗口约束，5000 不是整次历史抽取总数。`maxPendingDeliveries` 默认 512，`catchUpIdleMs` 默认 30000；这些上限在 welcome 与 `/status` 可观测。`subscribe(filters, from)` 已能按主题过滤历史，过滤外消息不占投递窗口，但仍产生扫描 CPU 开销。没有主题索引或提供者时间窗入口。更大批次不保证慢消费者更快，应结合 ACK 进度和实际场景调整。

消息追加不逐帧 fsync，断电可能丢最后若干条；释放元数据的同步／原子替换不等于每条消息具有断电耐久性。没有 QPS 限流、每提供者容量隔离、在线扩容、高可用复制或独立持久 gap 日志；若部署需要限流，由接入桥／前置代理实施并另行验证，不能称枢纽已有资源隔离。

JS／Python／PowerShell 的特定本机场景见[跨语言合同](specs/bridge-interoperability.md)与[验证方法](verification.md)，不能推导所有语言均通过。Linux 平台回归、跨机器互操作、至少 24 小时含离线恢复的长跑，以及大规模管理界面与辅助技术审计仍需独立执行；它们不使 Hub 承担程序业务。
