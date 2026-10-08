# 验证范围与命令

所有命令从源码仓库根目录执行。每次运行保存自己的结果到 `.artifacts/evidence/`，报告给出环境、实际命令、退出码和范围；该目录被 Git 忽略。测试通过不表示任意第三方桥、任意语言或外部业务通过。

| 测试集合 | 命令 | 需要的环境 |
| --- | --- | --- |
| 默认 Node 通讯与管理回归、独立多程序场景 | `npm test` 或 `npm run verify` | Node 22；默认无需 DSH、Python、pwsh |
| JS／Python／PowerShell 互操作和三个候选桥 profile | `npm run test:cross-language` | Node、Python + websockets、PowerShell 7 |
| 真实已安装 DSH 的隔离测试模型集成 | `npm run test:dsh` | Node、显式 `PEROS_DSH_ROOT` |
| 一座候选桥 | `node tests/bridge-acceptance/run.mjs --bridge tests/bridge-acceptance/python.json` | manifest 所需环境 |
| Python 桥受控检查 | `python tests/fixtures/python/self_check.py` | Python + websockets、Node |
| PowerShell 桥受控检查 | `node tests/fixtures/powershell/smoke.mjs` | Node、PowerShell 7 |

默认 Node 集执行所有 `tests/conformance/*.test.mjs`、JSON-RPC 传输与上下文程序测试、定向／大对象场景、外部工作流、事件面板和三程序链路。它不把真实 DSH 测试静默跳过后计入通过。测试标题中的 P2、P4、P5、P7 等稳定场景编号仅用于定位既有用例，不构成仓库目录或产品模块分类。

## 可选语言环境

```powershell
python -m pip install -r sdk/python/requirements.txt
npm run test:cross-language
```

可通过 `HUB_PYTHON` 和 `HUB_PWSH` 选择自己的可执行文件；`PHASE7_PYTHON`、`PHASE7_POWERSHELL` 保留作为场景工具的兼容变量。路径只属于调用者环境，不写入仓库。PowerShell 使用随带的 .NET 编译 C# 辅助类，不需要 dotnet SDK。工作流仍由独立 JS 程序决定每轮访问哪些程序与如何合并结果。

跨语言场景覆盖实际独立进程、六个方向广播与定向请求／注入、原文、水位、ACK、释放权、多桥、附件以及受控重启。开放验收装置按 base／directed／blob 选择检查；未选择、失败前未到达和已通过分别记录。有限样本、等待时间与 manifest 控制协议只属于该装置，不规定所有程序采用 NDJSON。

## 可选真实 DSH

在自己的环境安装适用的 `@deepseek-ai/dsh`，将 `PEROS_DSH_ROOT` 指向含 `package.json` 和 `lib/bin.js` 的实际安装根目录，再运行：

```powershell
$env:PEROS_DSH_ROOT = '<你自己的 DSH 安装根目录>'
npm run test:dsh
```

缺少或不匹配的实际运行时明确失败。测试启动真正的 DSH 进程，在独立临时 home 和 workspace 中运行确定性模型适配器，限制网络，不读取用户模型凭据。它验证通讯与真实进程接口，不验证外部模型 API、真实工具业务或 ACP。真实使用时，模型、provider、工具许可和用户配置由外部 harness 选择。

## CI 与结果解释

CI 当前选择 Windows 和明确的 Node／Python／PowerShell 环境。只有实际工作流结果才能说明远端执行是否通过；本机 green 不等于 GitHub Actions 已执行。Linux、跨机器、断电耐久、至少 24 小时高负载、所有辅助技术与任意容量附件均需另行验收。

管理 DOM 模型、真实 WebSocket 自动测试和人工浏览器操作是不同证据。`published` 仅证明 Hub 接纳，`caught_up` 仅表示扫描／发送屏障，ACK 不表示业务完成也不授权清理。报告必须保留这些区别，不把静态文档存在、候选场景目录或跳过检查计为通过。
