# 可选 Node 无界面容器执行

默认 `trusted-local` 仍运行用户明确审阅的本机程序，模块权限是声明。可选 `docker-node-headless/v1` 属于外部 Runtime 的执行适配器，Hub Core 不选择或实现沙箱。该有限 profile 只接受 Node 模块、`processes:"none"`、仅 `hub-loopback` 网络声明。Python、HTTP 界面程序和其他权限形态明确拒绝；没有自动回退到本机执行。

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
