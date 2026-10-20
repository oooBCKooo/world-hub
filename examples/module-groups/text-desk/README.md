# Cross-language text desk / 跨语言文本台

三个独立程序通过模块桥接入同一个本机 Hub：Node.js 文本来源提供读取与更新，Python 统计程序计算 Unicode 字符、行数、UTF-8 字节数与 SHA-256，Node.js 浏览器界面调用前两者并显示结果。

这是一份模块组配方，不携带 Hub、解释器、凭据或运行数据。导入不启动程序。成员仍可单独配置、启动、停止或加入其他组；组不创建独立运行世界。

## 在通信管理界面使用

1. 运行 `world-hub --open`，进入本机通信管理界面。
2. 从工坊取得 `demo.text-desk` 模块组，或导入作者提供的 `artifact.json`、完整模块组目录或 ZIP。
3. 核对三项成员、公开参数、主题权限和能力绑定后确认导入。界面会把它们登记为同一个 Hub 上的独立实例。
4. 选择已安装的 Node.js 与 Python。Python 环境需具备 `modules/stats/requirements.txt` 声明的 `websockets`；依赖准备与启动分别审阅。
5. 组计划先启动 source、stats，二者就绪后启动 desk。打开 desk 日志中 `module-ready.entryUrl` 指向的本机浏览器页面。
6. 输入文本并分析。界面先调用来源保存和读取，再调用统计程序，验证真实提供者、契约与结果回执后显示结果。

来源和分析记录分别保存在各实例的私人状态目录，下载制品不包含它们。停止共享实例会影响引用它的其他组。

## 从源码可复现构建

仓库内此目录保存配方。成员源码复用 `examples/ecosystem-pack/modules/source`、`stats`、`desk` 的独立模块目录；旧目录名只是源码位置，不会把旧 pack、lock、Hub 配置或模板带入新制品。

在仓库根运行：

```powershell
node scripts/release/build-community-modules.mjs --output .local/community-modules-text-desk
```

脚本核对配方的参数、通道与作者默认值，原字节复制三个成员到独立 stage，生成三份单模块和一份模块组制品，并写入 `artifacts/manifest.json`。输出目录中的 `stage` 与 `artifacts` 必须不存在，避免覆盖先前结果。相同源码输入生成相同制品字节和摘要；已发布的同版本制品不能被不同内容替换。

## English

This group connects three independent programs to the same local Hub: a Node.js text source, a Python statistics provider and a Node.js browser interface. The interface updates and reads the selected source, requests statistics, then verifies the provider identity, exact application contract and result receipts.

Import the group through the local communication management interface, review members and public configuration, and choose installed Node.js/Python interpreters. Python needs the dependency declared in `modules/stats/requirements.txt`. Importing does not start programs. The group plan starts source and stats before desk. Open the loopback `entryUrl` reported by desk's `module-ready` event.

The group contains member sources and a versioned public recipe. It contains no Hub, interpreter, credentials or runtime data. Members remain independent instances and may be managed individually. From the source repository, the build command above creates a fresh stage and four digest-verified artifacts without changing member source bytes or including the historical pack runtime.

MIT. Each member retains its own license; external runtimes and Python dependencies retain their respective licenses.
