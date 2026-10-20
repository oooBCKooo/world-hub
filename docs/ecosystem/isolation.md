> 历史资料：已退出当前产品。整合包、模板及每包独立 Hub 的使用路径已取消；本页保留原设计和证据，不代表当前支持，也不提供旧版兼容入口。当前使用请看[单 Hub Launcher](launcher.md)。

# 可选执行保护模式

三种可选 profile 都由外部 Runtime 实现，Hub Core 不选择保护模式、业务通道或程序形态。未选择 profile 时仍为经审阅的 `trusted-local`。

| Profile | 支持形态 | 实际边界 |
| --- | --- | --- |
| `docker-node-headless/v1` | Node 无界面 | 原有固定容器限制 |
| `docker-runtime/v1` | Node、Python，可选包入口 HTTP | 同样的容器限制；只有审阅过的入口允许有限 HTTP 通道 |
| `linux-existing-user/v1` | 已有 Linux 用户的 Node／Python／界面 | 用户身份分离，`identitySeparation:true`、`sandbox:false` |

## 原 Node 无界面 profile

默认 `trusted-local` 仍运行用户明确审阅的本机程序，模块权限是声明。可选 `docker-node-headless/v1` 属于外部 Runtime 的执行适配器，Hub Core 不选择或实现沙箱。该有限 profile 只接受 Node 模块、`processes:"none"`、仅 `hub-loopback` 网络声明。Python、HTTP 界面程序和其他权限形态明确拒绝；没有自动回退到本机执行。

发布者身份、内容摘要、本地执行授权和实际隔离状态是独立维度，见[渐进信任接口](trust.md)。权限声明通过或下载摘要相符不能变成“已隔离”或“已审计”；本 profile 也不会为作者签名背书。升级／恢复只处理记录范围内的软件和私人快照，不能撤销外部 API 或已发送消息，见[升级边界](upgrade.md)。

需要已配置且运行中的 **Linux amd64/arm64 Docker 引擎**、绝对 Docker 客户端路径、固定本机 daemon endpoint 和预先取得的 `repository@sha256:...` 镜像。工具不会安装 Docker、更新 WSL、拉取镜像或运行镜像安装钩子。宿主包锁的 Node 版本必须与容器 Node 完全一致；启动时核对实际版本与 UID。

| 范围 | 固定限制 |
| --- | --- |
| 文件 | 只读模块源码、配置和适配器；只有本组件数据目录可写；其他宿主目录不挂载 |
| 网络 | `network=none`，无端口映射；STDIO 代理只联系该实例 Hub，凭据与桥身份仍由 Hub ACL 校验 |
| 进程 | 非 root、移除全部 capabilities、no-new-privileges；seccomp 拒绝 fork/vfork/非线程 clone，允许受 PID 配额约束的 Node 线程 |
| 资源 | 显式 memory、memory-swap、CPU、PID 限制；只读容器根，64 MiB 临时内存盘 |
| 生命周期 | 启动前审计实际 Docker 配置；只能停止和删除当前创建并核对 owner label 的容器 |

组件的普通 SDK 在容器内部连接本地代理；代理转发原协议帧，保持正文不透明。宿主 broker 不接受容器指定的任意网络目的地。实例 Hub 和 Runtime 监督者在宿主运行，`sandbox:true` 只指该 profile 下的组件进程。此 profile 不证明内核无漏洞、代码安全、正文可信或业务结果正确。

策略文件示例（镜像摘要需要由部署者核对并预先取得）：

```json
{"dockerPath":"/usr/bin/docker","endpoint":"unix:///var/run/docker.sock","image":"node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9","limits":{"memoryMiB":256,"pids":64,"cpus":1,"user":1000}}
```

Linux bind 数据目录必须由指定 UID 可写，配置和源码需可读。工具不自动修改宿主文件归属；选择与宿主用户一致的非 root UID。Windows Docker Desktop 本机 endpoint 可以是 `npipe:////./pipe/dockerDesktopLinuxEngine`，但宿主 Docker Linux engine 不可用时会拒绝启动，不能推断 Windows 已验收。

```sh
world-hub-pack isolation-probe --docker /usr/bin/docker --endpoint unix:///var/run/docker.sock
world-hub-pack isolation-review /path/to/imported/package --isolation policy.json
world-hub-pack start --root /path/to/root --instance sample --trust <packageDigest> --isolation policy.json --isolation-trust <isolationDigest>
```

公开 API：`probeIsolation` 只查提供者、不启动容器；`reviewIsolationPackage(packageReview,policy)` 查已有摘要镜像、绑定包与限制；`startInstance` 增加 `isolation:policy` 和 `isolationTrust:review.digest`。底层适配器另导出 `planIsolation` 与 `ownIsolatedProcess`。审阅结果 `sandbox:false` 表示尚未执行，实际运行状态记录 profile、镜像、限制和容器身份。Launcher 在“环境与诊断”选择策略，在逐包授权时显示实际完整隔离审阅。

自动验收分开运行：常规 `test:ecosystem` 覆盖静态策略、摘要失效与不可用时拒绝；`isolation-docker.test.mjs` 必须在真实 Linux Docker 中运行，检验宿主文件／源码写入／外网／子进程拒绝、可写状态和真实 SDK 经 Hub 回传。缺少引擎不会跳过测试。真人新用户与独立作者验收另见[验收资料](../independent-author-acceptance.md)。

## Node／Python 与有限界面通道

`docker-runtime/v1` 按运行时分别指定 `images.node`、`images.python` 的实际 `repository@sha256`。对应镜像必须预先存在，实际 Node／Python 版本及 Python SDK 依赖须与包锁完全一致；Python 镜像使用 `/usr/local/bin/python3`。只读源码／配置、非 root、全部 capabilities 移除、seccomp 禁止新子进程、PID／内存／CPU 限制和 `network=none` 继续生效。Runtime 不安装依赖或拉取镜像。

```json
{"profile":"docker-runtime/v1","dockerPath":"/usr/bin/docker","endpoint":"unix:///var/run/docker.sock","images":{"node":"node@sha256:<实际摘要>","python":"自己的Python镜像@sha256:<实际摘要>"},"http":{"components":["desk"]},"limits":{"memoryMiB":256,"pids":64,"cpus":1,"user":1000}}
```

`http.components` 只允许包声明的入口组件；它必须声明 `loopback-listen`。容器不映射端口。宿主仅把请求经有界 STDIO 通道转交该入口的容器内环回 HTTP，不接受组件指定任意宿主／外网目的地。通道上限：1 MiB 请求／响应体、16 并发、10 秒请求期限；拒绝绝对代理地址、外站 Origin、CONNECT、WebSocket upgrade 和重定向，保留响应 CSP。普通 Hub 桥消息仍只转给该实例 Hub。需要流媒体、WebSocket 界面或普通外网的程序应采用自己的部署方式；这个有限 profile 不承诺支持它们。

## 已有 Linux 用户

策略示例：`{"profile":"linux-existing-user/v1","setprivPath":"/usr/bin/setpriv","user":{"uid":1001,"gid":1001}}`。监督者须已经具有 root 权限，UID 和主 GID 须已存在于本机账号文件。工具不创建账号、不调用 sudo、不更改目录权限或归属。部署者预先安排目标用户可读的源码／解释器，以及归该用户所有、可写的组件 state／tmp；条件不满足会拒绝启动。

执行前固定探针核对实际 UID、GID、清除附加组、no-new-privileges 和 capabilities 移除；实际解释器、依赖、目录与配置绑定审阅摘要。运行配置经固定辅助程序从 STDIN 写入该用户的 0600 临时文件，停止后清理。

用户分离不能阻止该账号普通权限允许的文件、网络或子进程访问。当前特权监督者持有自己创建的进程组，停止时回收组内进程，按当前内核身份核对，绝不按旧记录 PID 停别的程序。主动 `setsid` 脱离的后代不能完全约束；此模式不承诺完整后代隔离，不能替代容器沙箱。

## 实际验收

常规 `test:ecosystem` 覆盖静态策略和失败时拒绝；GitHub 的 `isolation-linux` 作业在真实 Linux Docker 中执行 `isolation-docker.test.mjs` 与 `isolation-expanded-docker.test.mjs`，包括原 Node profile、完整 Node→Python→Node 业务回传、有限 HTTP 和恶意文件／网络／子进程探测。`isolation-user.test.mjs` 由 CI 明确准备已有账号和目录后以特权监督者运行，验证身份、根目录私有文件拒绝、配置权限、普通网络和子进程可用、停止清理。缺少提供者的 Windows 本机没有被冒充为容器验收。
