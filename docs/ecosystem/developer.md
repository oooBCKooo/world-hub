# 模块作者：从独立实现到可替换交付

[English](developer.en.md) · [使用者入口](launcher.md) · [本轮能力与边界](phase17.md)

模块是外部程序，不是 Hub 内核插件。使用自己的 mod 桥遵守通信协议，并与其他程序约定业务合同，就可以独立实现。下面的工具属于可选本机 Runtime 部署 profile；原有程序仍可自行管理进程、环境、状态和桥，不必采用其目录或生命周期形态。

## 生成并检查一个作者样板

```powershell
npm install -g world-hub
world-hub-pack init-module ./my-statistics --id author.statistics --runtime node
world-hub-pack validate-module ./my-statistics
world-hub-pack doctor-module ./my-statistics
node --test ./my-statistics/logic.test.mjs
```

目标目录必须不存在。生成包含 `module.json`、可运行程序、纯业务逻辑与自测、完整桥 SDK、MIT 许可和机器合同；不安装依赖、不运行生成程序、不创建实例。Python 用 `--runtime python`，选择已准备的解释器：

```powershell
world-hub-pack init-module ./my-python-statistics --id author.python --runtime python
world-hub-pack doctor-module ./my-python-statistics --python '<自己的 Python 路径>'
cd my-python-statistics
python -B -m unittest test_logic.py
```

Python 样板使用随附 `requirements.txt` 的固定 websockets 版本。doctor 只运行可信解释器的固定探针，检查该已知依赖；其他依赖和任意安装脚本不被探测或执行。解释器本身也必须可信。静态检查失败输出 `ok:false` 和 `issues`，每项包含 `path/stage/code/message/remedy`；CLI 返回非零退出码，结果仍在 stdout，命令错误在 stderr。

`validate-module` 共用 Runtime 的模块声明及安全路径检查，核对入口、文件集与当前声明平台。普通模块没有被要求携带某一种 SDK 布局、机器合同文件或测试。生成样板额外携带 `author-sample.json`，仅为这个样板检查随附资料；采用其他形态时可删除该可选标记。它不是新的 Hub 协议字段。

样板实现 `text.statistics@1.0.0` 的精确 Unicode、LF、UTF-8 字节与 SHA-256 业务结果。它采用可选 Runtime 的 `--runtime-config`，通过标准输入处理健康和停止，收到真实桥登记与订阅确认后才报告 ready。公开设置 `topicKey`（默认 `stats`）和 `callerId`（默认 `desk`）选择部署给出的主题别名和获准调用方；实际 URL、token、桥身份由 Runtime 的私人配置提供。样板不包含外部能力目录的广告、租约或动态发现适配；需要该 profile 时遵循[提供者契约](../modules/provider-contract.md)另行实现。自测仅验证内置算法，不证明第三方业务实现正确。

## 发布、发现、替换与重新审阅

```powershell
world-hub-pack publish ./my-statistics --destination ./statistics-publication --kind module --acknowledge-licenses true
world-hub-pack source ./statistics-publication/index.json
world-hub-pack fetch-source ./statistics-publication/index.json --index-digest '<上一步 digest>' --entry '<entryId>' --cache ./artifact-cache
world-hub-pack preview-replacement '<原包目录>' --component stats --module '<已获取模块目录>' --python '<Python 路径>'
```

publish 生成数据制品和开放索引；没有上传。阅读许可后才能明确同意再分发。可以将这些数据交给自己选择的静态 HTTPS 源或可选 Workshop。Launcher 的软件源页也支持发现、下载、持久启停与内容冲突提示，服务器从不执行上传代码。

预检展示实际候选的合同、桥槽、身份、平台、入口、许可和声明权限差异，以及全部影响组件。相同 Module ID 只有一个内容树，替换会影响所有引用；新 ID 只改变选定组件。它共用真正派生的检查规则，不落盘、不执行候选，并明确 `businessValidated:false`、状态兼容性 `unknown`。修改组合草稿后，派生仍会重新核对全部绑定、依赖和文件。

在 Launcher 创作工作台检查原包，选择组件并填写替代目录，检查预检差异后保存；生成新的派生目录与新锁。导入新实例，再审阅实际代码、环境、来源和权限并授权启动。也可沿用 [CLI 派生操作](authoring.md)；`--help` 列出命令与选项。更改代码或解释器会使旧审阅失效。

验证来源 A → 处理器 B → 界面 C 时，至少检查消费者得到的真实业务结果、授权失败、错误版本、Unicode 边界、超时结果未知、健康/通信区别、停止退出和重启轮次；不要把 Hub 接纳或 ACK 当作业务成功。原包和旧实例保留，仅替换代码不恢复应用数据；需要旧状态时使用兼容环境下的[私有备份恢复](maintenance.md)，或对已停止实例进行[经审阅的升级与完整持久数据回滚](upgrade.md)。数据兼容与迁移逻辑仍由程序作者声明。

## 验证范围

`npm run test:ecosystem` 包含生成、静态诊断、实际公开 CLI 分发、Node/Python 配置替换与真实桥业务结果。`npm run test:launcher` 覆盖来源配置、禁用绕过、缓存/收据、生命周期与界面事件；CI 保留已有合同互操作和文档隔离实现验收。现有独立作者记录明确为 AI 文档隔离演练，不是两个真人第三方作者的验收。

开放软件源支持 Module、Pack 和 [Template](templates.md) 三种制品。内置作者样板与可分享的参数化组合模板是不同对象；模板包含锁定基础包，只生成新 Pack，不运行模块。已停止实例的[升级与数据回滚](upgrade.md)要求每个组件提供明确的数据策略；可选 [Node 无界面容器 profile](isolation.md)只支持声明范围内的模块。它们不保证任意模块、语言、平台或依赖可以一键启动，真人外部验收仍保留待办。

`world-hub-pack --version` 返回版本；`completion powershell|bash|zsh|fish` 输出可保存并按对应 shell 加载的补全脚本。CLI 可完全通过参数非交互使用，原有无界面 Hub 和 Runtime 入口保持可用。
