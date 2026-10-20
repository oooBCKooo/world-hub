# 本机受管模块的按需调用

Hub 仍只传送普通请求和回应。自动启动与空闲停止由本机管理服务的独立生命周期桥实现；业务目标、主题、数据和完成含义由应用自己定义。普通 `bridge.call()` 不会自动唤醒模块。

提供方可由作者在 `deployment.json` 中建议默认按需运行，用户也可在本机运行策略中选择。用户明确允许哪些已登记本机模块触发它；调用方须重启，以取得私有运行配置中的 `lifecycle` 描述和相应控制主题权限。作者默认值不授予启动权限，导入后模块仍停止且允许调用者为空。已有实例升级或回退时保留当前本机策略。

作者默认值示例（加入 `deployment.json`；模块组可在成员 `configuration` 中声明同一字段以覆盖它）：

```json
"executionDefaults": { "mode": "on-demand", "idleTimeoutMs": 60000 }
```

`mode` 必填，取 `resident` 或 `on-demand`；`idleTimeoutMs` 可省略，默认 60000，取 1000 至 86400000 的整数毫秒。新实例优先使用组成员默认值，再用模块默认值，均未声明时使用常驻／60 秒。不得在作者默认值中声明 `allowedCallers`。导出模块组只携带模式与空闲时间，不携带本机调用授权。

```js
import { callManaged } from 'world-hub/lifecycle';

const result = await callManaged(
  bridge, runtime.lifecycle, providerProgramId, runtime.topics.requests,
  { text: '应用自行定义的数据' },
  { activationTimeoutMs: 120000, timeoutMs: 30000,
    onLifecycleError: error => console.error(error.code, error.message) }
);
console.log(result.response.body);
```

`bridge` 是调用方自己的已连接 `Bridge`。`providerProgramId` 是本机实例 ID，不是模块产品 ID；由应用配置或明确的能力绑定获得。自动启动确认受管子进程、就绪和桥连接后，SDK 才向提供方 principal 发送原始业务请求；不启动其其他依赖、不重发业务请求。返回原 `{request,response}`，业务结果仍由应用解释。

高并发程序须为生命周期控制调用预留 Bridge 的待回应容量，例如构造时设置 `maxPendingCalls: 128`。业务调用与续租都使用该桥的普通调用槽，达到上限会明确拒绝；不要把业务并发占满后将续租失败视为任务完成。

SDK 持有独立租约并定期续期，真实业务回应到达后才报告完成。业务调用超时、断线、异常或租约失联会留下“不确定的任务”，**不会假定任务结束并自动停进程**。明确完成后可以释放；没有结果时由用户手工停止／重启该受管实例解除。控制释放失败通过 `onLifecycleError` 报告，已确认的业务结果仍返回；不要因此重试原业务。

生命周期控制消息采用其提供者自己声明的短期留存策略：调用方收到控制回应后自愿 `release` 自己的控制请求，管理桥在控制回应获 Hub 接纳后自愿 `release` 自己的回应，以允许容量回收。控制结果不承诺离线重读；它不是业务成果。释放失败保留消息并报告诊断，不改变业务结果。普通业务请求与回应不会被此 SDK 自动 `release`。续期失败会停止自动续期并报告诊断，避免断线后不断积累无法确认的控制请求；已在执行的业务仍不会重发，也不会因续期失败被假定完成。

长流和多步骤任务可以自己明确完成边界：

```js
import { acquireManagedLease, withManagedModule } from 'world-hub/lifecycle';
const lease = await acquireManagedLease(bridge, runtime.lifecycle, providerProgramId);
try {
  await applicationStreamUntilActuallyFinished(lease.target);
  await lease.release({ completed: true });
} catch (error) {
  await lease.release({ completed: false }); // 保守保留进程
  throw error;
}

// 仅当回调 resolve 就确实意味着整个任务完成时使用此简写。
await withManagedModule(bridge, runtime.lifecycle, providerProgramId,
  async ({ target }) => await applicationTask(target));
```

租约对象包含 `leaseId`、`target`、`programId`、`leaseTtlMs`、`renewAfterMs`、`renew()`、`release({completed})`、`stopRenewing()` 和 `lastError`。默认自动续期；停止续期不等于业务完成。SDK 不将租约放入业务消息。管理状态只显示计数，不公开租约 ID 或任何凭据。

控制契约为 `world-hub.lifecycle/v1`，描述形如 `{protocol,principal,topic}`。调用者通过普通定向请求发送 `{action:'acquire',programId}`，得到 `{ok:true,leaseId,leaseTtlMs:30000,renewAfterMs:10000,programId,target:{principal}}`；`renew` 使用 `{action:'renew',leaseId}`；`release` 使用 `{action:'release',leaseId,completed:true|false}`。拒绝为 `{ok:false,error:{code,message}}`。权限以 Hub 验证的 `fromPrincipal` 映射本机实例，每次操作重新检查当前触发策略和版本恢复状态，不相信消息自报的调用者。

独立的并发调用各持一份租约。所有租约明确完成后，完整空闲计时才开始；只会停止生命周期服务自己启动、同一 runId 与同一持有句柄的进程。用户手工启动会固定该运行，不自动停止；无法确认所有权时不会接管或按保存的 PID 杀进程。租约总数 128、单调用者 32、单目标 32，待启动和不确定项均计入。
