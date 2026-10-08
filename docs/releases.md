# 构建、分发与迁移

分发包只带明确清单中的现行 Hub、管理界面、通用 SDK、当前文档与小型隔离演示。默认只启动通讯枢纽；完整示例业务、DSH、模型、测试装置和工作流程序不作为必装业务。

## 从源码构建

轻量源码分发无需下载运行时：

```powershell
npm run build -- --output dist/world-hub-source
node scripts/release/verify-package.mjs --root dist/world-hub-source
```

`build` 未给输出时使用 `dist/` 下由当前版本生成的目录；已有目标明确失败，不覆盖现有分发或部署。源码包用本机 Node 22.4.0 或以上运行，构建不意味着其他操作系统已验收。

Windows x64 便携包带固定 Node 22.23.2。先在自己的缓存目录准备官方运行文件与许可，再打包：

```powershell
New-Item -ItemType Directory -Force .artifacts/runtime
node scripts/release/prepare-runtime.mjs --download --output .artifacts/runtime/node-win-x64
npm run build -- --runtime .artifacts/runtime/node-win-x64 --output dist/world-hub-win-x64
node scripts/release/verify-package.mjs --root dist/world-hub-win-x64
```

缓存目录必须是新目录。也可在 Windows x64 使用 `--node <自己已安装的官方 node.exe>` 代替 `--download`；只有 SHA-256 匹配固定版本的官方 HTTPS 清单后才执行候选程序和复制运行文件。便携包保留完整 Node LICENSE、下载来源、校验表和 provenance，不上传运行时二进制到源码 Git。

构建输出目录、ZIP、`.sha256` 与 `.build.json` 都是生成文件，不提交源码仓库。manifest 记录软件版本、wire、原始文件的角色、大小和 SHA-256。源码按显式允许清单复制；文档若链接未携带的源码测试／示例，会在分发副本中标为未携带，不修改源码文档。

## 启动与检查

完整解压后运行 `start.cmd`，它优先使用包内运行时，以包根 `config/hub.json` 启动并打开管理地址。终端保持运行，Ctrl+C 停止。源码包无自带运行时，使用 PATH 中 Node；Hub 没有 npm 运行依赖。Python、PowerShell 桥的环境由接入程序安排，不是启动 Hub 的前提。

直接使用 `node scripts/launcher.mjs` 不打开浏览器，加 `--open` 显式打开。配置路径与运行文件根据包位置解析，不依赖启动者工作目录；配置中的相对数据路径按配置目录解析。`--port`、`--config` 等部署选项见启动器 `--help`。

`check.cmd` 或 `node scripts/launcher.mjs --check` 只读检查环境、配置、必需文件和数据占用，不启动、不创建数据目录。`verify.cmd` 或验证脚本校验全部原始文件；用户明确选择 `--allow-config-change` 才放过 `config/hub.json` 内容变化，仍检查源码与运行时。新增 `data/**` 不参与原始程序校验，新增程序文件则仍视为清单外；自己的程序放在包外。

清单用于发现损坏，不是发布者数字签名；与清单一起被修改的文件没有真实性保证。验收必须用实际 ZIP 解压的文件，不能以构建源目录代替解压结果。

## 配置、数据与生命周期

参考配置默认监听回环、拒绝未登记身份，预置 `ui.manual` 本机无 token 工作台身份。它不提供来源防伪或多租户隔离。正式接线由部署方设置自己的 token、主体与主题 ACL，保存配置后重启；不自动读取或合并第三方 ACL。动态主题和 `body.kind` 由 mod／程序决定。

默认持久数据分为 `data/log`、`data/blobs`、`data/management.json`，首次运行才创建。日志包含通讯记录及提供者释放元数据，附件包含字节和分块进度，管理状态含暂停与 N:M 注记。业务状态、上下文、harness home 与消费程序游标由外部程序保存。

启动器在服务打开存储前检查环境和端口，并持有数据目录排他锁；正常退出只释放自己的随机 nonce 锁。异常遗留锁明确拒绝，用户确认无进程使用该数据后再手动移走报错中的锁文件，不删除日志或对象，也不根据可复用 PID 自动杀进程。直接运行原服务不受包级锁保护；锁不是分布式锁或抵御恶意同机写入的机制。

同一程序可以连接多座 Hub，各部署用独立数据目录；Node SDK 文件游标还要按逻辑 Hub 部署和桥实例独立保存，整表写入不提供多实例合并或锁。凭据共享同时共享稳定主体、主题权限、配额和提供者释放归属，是否共享由程序按信任关系选择。详见[接入](onboarding.md)。

升级前先停止旧实例，解压新包到新目录，保留旧包回退，再复制自己的配置和完整持久数据。外部自定义路径由用户迁移，不以新默认配置覆盖自己的接线。启动、停止、搬迁、读取和 ACK 都不是 release。没有对全部历史版本、降级、断电耐久、跨机器或长期高负载的自动保证。

## 分发验收

`scripts/release/` 提供可重跑的包级工具，输入实际解压目录和新的包外证据目录。例如：

```powershell
node scripts/release/package-acceptance.mjs --bundle '<实际解压包的绝对目录>' --evidence '<新的包外证据绝对目录>'
node scripts/release/document-onboarding-check.mjs --bundle '<实际解压包的绝对目录>' --evidence '<另一个新的包外证据绝对目录>'
```

逐项核对 HTTP 资源、真实 WS 动态主题和原文、N:M 桥、手动 ACK、附件、重启／搬迁保留、暂停与注记、重复启动和损坏配置拒绝。测试副本和证据在本机保存；实际通过项以报告为准，不以压缩成功或清单通过代替程序接入、其他平台或业务结果。源码 Node、DSH 和跨语言范围见[验证](verification.md)。
