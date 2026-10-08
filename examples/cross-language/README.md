# 跨语言独立程序验证

Node JS、Python、PowerShell 各自建立真实 WebSocket mod 连接同一隔离 Hub，不把其他语言消息转交 JS 代传。`scene-harness.mjs` 只启动测试进程、安排输入、断言与清理；业务在普通外部程序中。

从仓库根目录准备自己的 Python 和 PowerShell 7：

```powershell
python -m pip install -r sdk/python/requirements.txt
npm run test:cross-language
```

该集合运行下面 14 个集成场景，再执行三个参考候选桥 manifest。单独运行集成场景或三轮工作流：

```powershell
node examples/cross-language/run-cross-language.mjs
node examples/cross-language/run-cross-language.mjs --demo
```

| 编号 | 范围 |
| --- | --- |
| P7-01 | 三语言独立进程、六方向广播 |
| P7-02 | mod 动态登记与并发订阅回执关联 |
| P7-03 | JSON 原文、数字、转义及 UTF-8 保真 |
| P7-04 | 裸 wire 水位、非法 resume／不安全游标 |
| P7-05 | 六方向请求与可信回应 |
| P7-06 | 六方向注入，旁观实时与历史遮挡 |
| P7-07 | 权限拒绝、伪回应、提供者释放归属 |
| P7-08 | 分订阅 ACK、非破坏历史、提供者释放 |
| P7-09 | 稳定 principal 离线后抽取，旧 session 遮挡 |
| P7-10 | 同一稳定主体多 mod 扇出与精确 session |
| P7-11 | 5 MiB 附件逐块三语言循环、校验与越权拒绝 |
| P7-12 | 独立工作流三轮，每轮 Python 与 PowerShell 并发返回 |
| P7-13 | 三语言握手拒绝与非零退出 |
| P7-14 | 真磁盘 Hub 重启后三语言历史原文 |

输出写新的 `.artifacts/evidence/` 子目录。`--evidence <目录>` 指定证据父目录，每次仍分配新 run；PID、版本、序号、结果、源码 SHA-256 和局限分别记录，不覆盖以前报告。

语言启动路径可用 `PHASE7_PYTHON`／`PHASE7_POWERSHELL` 指定；完整测试集合也接受 `HUB_PYTHON`／`HUB_PWSH`。只在调用者环境使用自己的路径，不把本机路径写入源码。

Python 夹具在 `tests/fixtures/python/`，通用桥在 `sdk/python/`；PowerShell 夹具和回声业务在 `tests/fixtures/powershell/`，通用桥在 `sdk/powershell/`。测试 worker 的 NDJSON、回声步骤和 P7 名称不是 Hub 协议或程序形态要求。所有 ACK 和 release 都是显式程序操作。

这些本机样本不证明其他操作系统、跨机器、任意第三方桥、乱序／重复 ACK、上传中断恢复、错误 SHA-256、长期压力或断电耐久。业务去重、下一轮选择、终止与成果判断仍由外部程序决定。合同与可选桥 profile 见[跨语言规范](../../docs/specs/bridge-interoperability.md)及[开放验收装置](../../tests/bridge-acceptance/README.md)。
