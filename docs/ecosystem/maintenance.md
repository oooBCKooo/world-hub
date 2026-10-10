# 私有实例备份与维护

实例维护是可选 Runtime 的本地部署功能。Hub 继续传递信息；程序决定自己的数据格式、提交、恢复及消息释放策略。

| 操作 | 保存内容 | 适合用途 |
| --- | --- | --- |
| 导出整合包 | `pack.json`、锁文件、锁定模块源码 | 分享组合、在满足锁定要求的环境中创建空实例 |
| 备份实例 | 整合包源码、程序持久目录、Hub 持久信息及管理设置 | 私人备份、兼容环境中的恢复 |
| 保留数据卸载 | 移除活动 `package` 路径，将软件置于私有 `detached-package` 恢复区，保留程序与 Hub 数据 | 停用软件并保留恢复能力 |
| 恢复已卸载软件 | 重新检查隔离区源码与所选环境，恢复活动软件路径 | 再次审阅并明确启动 |

保留数据卸载保留了私有软件恢复副本，因此不会声称已经腾空软件占用的磁盘空间。维护接口不提供删除全部业务数据的隐式操作。

## 备份之前

先停止实例，等待 Runtime 确认每个所属进程已经退出。失败状态、过时状态、找不到监督者、清理未确认、进程文件中的旧 PID 都不代表已经停止。维护操作通过同一个 `owner.lock` 排他，拒绝仍有所有者或其他维护操作的实例；不会按持久 PID 杀进程。尚未运行的导入实例也可备份；如果停止状态文件缺失但仍有控制记录或非空运行历史，则保持停止未确认，不猜测为从未运行。

备份是一份停止后的文件快照。它不能代替程序自己的数据库检查、提交或数据迁移；需要应用快照协议的程序应先执行自己的导出或准备动作，再停止。没有运行中的数据库快照或跨平台数据转换承诺。

备份包含：

- 原有锁定整合包及全部锁定模块文件；
- 已声明组件在 `programs/<component>/` 中的持久文件及空目录；
- `hub/log`、`hub/blobs` 和 `hub/management.json`。

备份排除 `runs`、`control.json`、`status.json`、`owner.lock`、旧实例身份元数据，以及每个组件根部的 `tmp` 目录。未知组件目录或实例根部自建文件不属于这个参考部署布局，不会被猜测为可迁移数据。程序需要的持久数据应保存在收到的 `stateDir` 中，并避开根部 `tmp`。

**备份未加密，可能含个人信息和程序自行保存的秘密。** 排除 Runtime 生成的配置不保证能找到并删除程序自行复制的凭据、业务数据库中的密码或其他秘密。备份结果因此标记 `private:true`、`excludesGeneratedRuntimeFiles:true` 和 `mayIncludeApplicationSecrets:true`；它不等于可公开分享的整合包。

文件与目录的 `0600`／`0700` 请求在支持该模型的平台生效；Windows 使用者仍需通过自己的目录 ACL 保护保存位置。同账户程序不是被 OS 沙箱隔离的对象。

## 恢复到新实例

先检查备份，再将检查得到的完整文件 SHA-256 绑定到恢复操作。恢复只接受新的实例 ID 和尚不存在的目录，不覆盖原实例。所选解释器与依赖仍需满足锁定要求；源码与所选环境形成新的审阅对象。

恢复拒绝不同的操作系统、架构或 Hub 精确版本。兼容性检查不表示任意业务数据都能迁移。程序的数据格式、旧成果中的身份地址、升级与降级语义仍由程序作者定义；Runtime 不解释或重写业务内容。需要升级格式时应由对应程序提供明确迁移方案，不能通过自动重锁或源码回退猜测数据兼容性。

恢复写入新的 `instance.json`。旧控制凭据、进程状态和运行配置不复制；下一次明确启动时生成新的运行 ID、控制 token、桥 token 和实例 Hub 身份。持久 Hub 记录保留为历史通信事实；停止、备份或恢复均不会替提供者释放信息。

恢复与软件重新关联都不执行模块。之后仍需审阅当前代码、环境、权限和连接关系，明确授权启动。

## JavaScript API

以下接口通过 `world-hub/runtime` 暴露，可由独立 Launcher 调用。路径应由受信任的本地管理层选择；不要让远端描述内容直接触发本机维护。

```js
import {
  backupInstance, inspectBackup, restoreInstance, storageInstance,
  detachInstance, reattachInstance,
} from 'world-hub/runtime';

const local = {
  root: '/absolute/private/runtime-root',
  instanceId: 'my-desk',
  nodePath: process.execPath,
  pythonPath: '/absolute/python',
};

// 调用者已经停止并确认所属进程全部退出。
const saved = await backupInstance({
  ...local, destination: '/absolute/private/my-desk.whbackup',
});
const checked = await inspectBackup(saved.destination);
if (!checked.compatible) throw new Error(checked.incompatibilities.join('; '));

const restored = await restoreInstance({
  ...local,
  instanceId: 'my-desk-restored',
  backup: saved.destination,
  expectedSha256: checked.sha256,
});
console.log(restored.plan); // 显示审阅内容；尚未运行。
console.log(await storageInstance(local));
```

| API | 主要参数与结果 |
| --- | --- |
| `backupInstance({root,instanceId,destination,nodePath?,pythonPath?,signal?})` | 新的私有单文件备份；返回 `destination`、完整 `sha256`、持久文件数及字节数、创建时间、pack 身份和私有标记 |
| `inspectBackup(file,{signal?})` | 只读验证完整文件及每项内容摘要；返回 `backup` 元数据、完整 `sha256`、`compatible`、`incompatibilities`；不会执行模块 |
| `restoreInstance({root,instanceId,backup,expectedSha256?,nodePath?,pythonPath?,signal?})` | 返回 `instanceId`、`stateDir`、`digest`、`plan`、`restoredFrom`、`startsModules:false`；建议始终提供所审阅的 `expectedSha256` |
| `storageInstance({root,instanceId,signal?})` | 返回 `groups` 中 package／programs／hub／runs／control／other 的文件数和字节数，总量、观察时间、`detached` 及 `consistency` |
| `detachInstance({root,instanceId,signal?})` | 停止确认与排他锁后移动活动软件；返回 `detached:true`、`preservesData:true`、`softwareRetainedInQuarantine:true` |
| `reattachInstance({root,instanceId,trust?,nodePath?,pythonPath?,signal?})` | 检查 `detached-package` 后恢复软件；可绑定所审阅的 `trust` 摘要；返回当前 `digest`、`plan`、`startsModules:false` |

存储扫描是有界观察，不是目录锁定快照。运行中或无法确认的实例返回 `consistency:"live-or-unknown"`；并发文件消失会标记 `unstable:true`。`consistency:"stopped"` 说明扫描完成时观察到停止且没有所有权锁，不保证之后不会启动。备份使用独立排他操作。

操作错误通过 Promise 拒绝返回，常见代码包括 `INSTANCE_LOCKED`、`INSTANCE_NOT_STOPPED`、`BACKUP_PATH`、`BACKUP_LIMIT`、`BACKUP_HASH`、`BACKUP_INVALID`、`BACKUP_INCOMPATIBLE`、`BACKUP_CHANGED` 和 `MAINTENANCE_ABORTED`。调用者应展示可执行的修复步骤，而不是把失败状态显示为成功。

## 单文件格式

参考格式不使用通用 ZIP 解压器。文件顺序为：

1. ASCII 魔数 `WORLD-HUB-INSTANCE-BACKUP/1` 加一个 LF；
2. 四字节 unsigned big-endian 的 JSON header 字节数；
3. UTF-8 JSON header；
4. 按 header `files` 的顺序拼接原始文件内容，无额外结束数据。

Header 的封闭字段为：`format`、`private`、`excludesGeneratedRuntimeFiles`、`mayIncludeApplicationSecrets`、`createdAt`、`sourceInstanceId`、`platform`、`hubVersion`、`pack`、`consistency`、`directories`、`files`。`format` 为 `world-hub.instance-backup/v1`；`consistency` 为 `confirmed-stopped` 或 `never-started`。`files` 每项仅含 slash 相对路径 `path`、字节数 `bytes` 和小写 SHA-256 `sha256`。`directories` 只描述需保留的程序与 Hub 持久空目录；源码父目录从锁定文件自然建立。

实现限制 JSON header 为 4 MiB、文件数 8192、每文件 256 MiB、文件内容合计 512 MiB、目录遍历项 32768。拒绝绝对路径、`..`、Windows 保留名、路径大小写冲突、文件／目录重叠、链接、特殊文件、未知或重复字段、未锁定源码、未声明组件的数据、内容摘要不符、缺失及额外载荷。不会执行备份附带的脚本。

恢复先完成只读检查，提取时再次验证实际输入摘要与文件摘要，写入新的普通目录。失败或取消只清理本次新建并逐项验证过的目录。现有备份文件和现有实例都不能被覆盖。

继续阅读：[Runtime 生命周期与边界](runtime.md)、[整合包声明](pack-spec.md)、[统一本地管理入口](launcher.md)。
