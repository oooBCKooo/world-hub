# 可分享的参数化组合模板

Template 是第三种分发对象，与 Module、Pack 分开。它包含一个完整、锁定的组合基础包，以及作者明确开放的业务参数。用户填入参数后生成一个新目录中的 Pack，再经过普通的环境检查、导入和执行审阅。Template 自身没有安装、启动或运行状态；更新模板不会修改已生成的 Pack 或运行实例。

这些能力属于可选创作工具和软件源。Hub Core 仍只负责程序通过 mod 桥进行通信。

| 对象 | 包含什么 | 使用方法 |
| --- | --- | --- |
| Module | 独立程序及 `module.json` | 作为组合中的模块候选 |
| Pack | 已选定的程序、组合声明及 `pack.lock` | 检查环境、导入、明确审阅后运行 |
| Template | 锁定的基础 Pack、`template.json` 参数声明 | 静态预览并生成新 Pack，随后按 Pack 流程处理 |

完整目录如下。`base` 是固定名称，不能用参数指定其他目录。Module 的源路径继续以基础包的锁为准。

```text
my-template/
  template.json
  README.md                 # 可选的模板使用说明
  base/
    pack.json
    pack.lock
    modules/...
```

[Template Schema](template.schema.json)描述独立声明，[文本工作台声明示例](template.example.json)可以用于仓库中的跨语言整合包。声明文件自身不是完整 Template；分享时必须同时包含锁定基础包的全部文件。

参数具有唯一 `name`、显示用 `title`、`type`、`default`、`constraints` 和一个或多个 `targets`。支持字符串、有限数字、安全整数和布尔值；字符串长度默认最多 4096，参数最多 64 项，每项最多 32 个目标。`constraints` 可以声明同类型的 `enum`，字符串可声明 `minLength` / `maxLength`，数字可声明 `minimum` / `maximum`。默认值也必须满足所有约束。

目标只有两类：

- `{"kind":"setting","component":"source","path":["text"]}`：覆盖现有组件 `settings` 内已有的标量业务值；嵌套对象路径最多 8 层，数组和对象整体替换不开放。
- `{"kind":"topic","key":"source"}`：覆盖某个已有 topic 的完整具体值。必须继续满足普通 Pack 的主题规则，不能包含通配符或造成主题重名。

没有表达式、字符串插值、模板脚本或安装钩子。参数值被当成 JSON 数据直接赋值；`${HOME}`、`$(...)` 等字符不会被解释或执行。参数不能修改 Module 文件、运行时入口、解释器、命令、目录、环境、凭据、组件身份、合同、拓扑或桥 ACL；命令、路径、凭据相关的设置键也拒绝暴露。工具不会证明业务程序对某个数据字段的解释是安全的，仍须审阅模块源码；此机制不提供 OS 沙箱。

独立作者可以通过公开 Runtime API 制作和使用 Template：

```js
import { readFile } from 'node:fs/promises';
import { createTemplate, inspectTemplate, previewTemplate, instantiateTemplate,
  publishArtifact, readSourceIndex, fetchSourceArtifact } from 'world-hub/runtime';

const template = JSON.parse(await readFile('template-declaration.json', 'utf8'));
await createTemplate('existing-locked-pack', {
  template,
  destination: 'new-shareable-template',
  redistributionAcknowledged: true
});

const inspected = await inspectTemplate('new-shareable-template');
const values = { 'initial-text': '多个独立程序，自由组合 🌍' };
const identity = { id: 'my.text-workbench', version: '1.0.0', title: 'My text workbench' };
const preview = await previewTemplate(inspected.directory, {
  values, identity, expectedRevision: inspected.revision
});
await instantiateTemplate(inspected.directory, {
  destination: 'new-generated-pack', values, identity,
  expectedRevision: preview.templateRevision,
  expectedPreviewDigest: preview.previewDigest,
  redistributionAcknowledged: true
});
```

`inspectTemplate`、`previewTemplate`、`createTemplate` 和 `instantiateTemplate` 只检查、复制和生成数据，不执行模块，也不探测解释器。生成过程保留原来锁定的 Hub 版本、平台、运行时版本、依赖和 Module 文件摘要，根据最终 `pack.json` 的身份和配置重新生成锁的 Pack 摘要。它不偷偷更新基础包环境；需要新平台或新锁定版本时，先显式制作和检查新的基础包，再制作新版本 Template。

每次预览返回 `templateRevision`、`parameterDigest`、`previewDigest` 和将要生成的 `pack` / `lock`。`previewDigest` 绑定完整 Template 文件、有效参数以及目标 Pack 身份；源文件、参数或身份变化后必须重新预览。生成接口接收这些预览摘要并在创建目录前拒绝旧结果。目标必须是尚不存在的新目录；任何失败产生的 `incompleteDestination` 都需要检查，不能当成完整 Pack 导入。生成的来源记录保存在 `authoring.json`，不包含通信或执行凭据。

可以使用同一开放软件源协议分发 Template：

```js
const publication = await publishArtifact('new-shareable-template', {
  kind: 'template', destination: 'new-static-source',
  redistributionAcknowledged: true
});
const source = await readSourceIndex(publication.indexPath);
const entry = source.index.entries.find(e => e.kind === 'template');
const fetched = await fetchSourceArtifact(publication.indexPath,
  source.digest, entry.entryId, { cacheRoot: 'private-source-cache' });
// 从 fetched.directory 检查、预览和生成 Pack；获取不授予执行许可。
```

来源 entry 的 `kind` 为 `template`，平台是基础 Pack 的锁定平台，`provides` / `requires` 为空；参数和基础包的真实合同在制品内检查。不可变版本、文件和制品 SHA-256、HTTPS 下载策略、缓存及离线复用与其他两类对象相同。静态 `index.json` 和 `artifact.json` 可以由第三方自行托管；可选 Workshop 后端同样支持 Template 发布、发现、不可变版本与协作提案。软件源撤回或禁用不会删除已生成的 Pack。

验收覆盖静态执行边界、参数类型/范围/未知项、路径与命令目标、原型键、旧预览拒绝、锁与源码保留、制品篡改、本地发布获取和离线复用、Workshop 持久分发，以及真实 Node → Python → Node 文本工作台。真实业务结果来自生成包中的独立程序，不由 Template 工具或枢纽计算。
