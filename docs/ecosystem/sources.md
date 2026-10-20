# 开放模块与模块组来源 / Open module and group sources

软件源只分发数据，不运行程序，也不参与 Hub 路由。通信管理界面的工坊读取索引、核对单模块或模块组并取得制品。单模块可以登记为独立实例；模块组把成员登记为同一 Hub 上的独立实例，再用组引用它们。获取或导入不会自动启动程序，执行前仍需审阅。本地模块不依赖任何软件源在线。

## 索引

`world-hub.source-index/v1` 是有界 UTF-8 JSON，最多 4 MiB、4096 条。字段闭合；未知字段、重复路径、危险路径和不一致摘要会被拒绝。

```json
{
  "format": "world-hub.source-index/v1",
  "id": "author.modules",
  "title": "Independent modules",
  "entries": [{
    "entryId": "module.author.statistics.1.0.0",
    "kind": "module",
    "id": "author.statistics",
    "version": "1.0.0",
    "title": "Text statistics",
    "license": "MIT",
    "platforms": ["win32-x64"],
    "provides": [{"id":"text.statistics","version":"1.0.0"}],
    "requires": [],
    "source": {"path":"artifact.json"},
    "sha256": "<64 lowercase hexadecimal characters>"
  }]
}
```

示例中的摘要需替换为实际 artifact.json 原始字节 SHA-256。语义版本是精确值，身份和版本相同但摘要不同属于冲突，不静默覆盖。能力元数据只用于候选发现，不证明业务兼容。

`kind` 为 `module` 或 `module-group`，对应单模块或模块组。相同类型和 ID 的不同精确版本属于同一作品。组版本描述配方发布，不取代成员模块自己的版本。

一个索引可以同时包含同一作品的多个精确版本，每个版本使用独立的 `entryId` 和原制品摘要。消费者按选中的条目取得对应字节，不把旧版请求重定向到最新版。补充较旧发布不会替换更高版本；来源排序也不构成升级指令。发布者应保留仍公开的历史版本，仅通过明确的下架操作移除有问题的条目，不能在同一版本号下偷偷修补制品。

本地 `source.path` 相对索引目录解析；远程条目使用 `source.url`，只允许明确支持的 HTTPS 来源。远程索引不能引用本机文件。`pack`／`template` 制品不属于当前格式，不做转换或兼容运行。

## 制品封装

`world-hub.source-artifact/v1` 具有 `format,kind,id,version,files,provenance`。`files` 的每一项包含安全相对路径、原始文件 SHA-256 与 Base64 内容。索引的摘要覆盖整个 `artifact.json` 原始字节，清单摘要覆盖每个源码文件。

单模块 `kind` 为 `module`，必须包含经过验证的 `module.json`、声明入口及实际文件，身份和版本与索引一致。

模块组 `kind` 为 `module-group`，必须包含根目录 `module-group.json` 和所有成员的模块目录。组清单使用 `world-hub.module-group/v1`，结构见 [module-group.schema.json](module-group.schema.json)，字段为：

- `format,id,version,title,license,platforms,provides,requires`：组身份、精确语义版本与公开发现元数据。
- `modules`：成员数组；每项为 `id,path,moduleId,version,configuration`。`id` 是配方内成员标识，`path` 是成员源码的安全相对目录，`moduleId` 与 `version` 必须匹配该目录的 `module.json`。
- `configuration`：仅有 `topics,bridges,settings,bindings`，均为可分享的公开配置。每个 binding 为 `{providerId,contract:{id,version}}`，`providerId` 指向配方内的成员标识。
- `startupPlan`：`members` 为 `{programId,enabled,after}` 数组，引用配方内成员；`onFailure` 为 `continue-independent` 或 `stop-plan`，`startupOrder` 按顺序列出每个成员标识一次，并满足 `after` 依赖。未启用的成员不会随组启动，之后仍可单独启动。

单成员模块组的清单示例（`modules/counter/` 内另附相符的模块清单与源码）：

```json
{
  "format": "world-hub.module-group/v1",
  "id": "author.counter-desk",
  "version": "1.0.0",
  "title": "Counter desk",
  "license": "MIT",
  "platforms": ["win32-x64"],
  "provides": [],
  "requires": [],
  "modules": [{
    "id": "counter",
    "path": "modules/counter",
    "moduleId": "author.counter",
    "version": "1.0.0",
    "configuration": {
      "topics": {"events": "example/counter/events"},
      "bridges": {"main": {"publish": ["events"], "subscribe": []}},
      "settings": {},
      "bindings": []
    }
  }],
  "startupPlan": {
    "members": [{"programId": "counter", "enabled": true, "after": []}],
    "onFailure": "continue-independent",
    "startupOrder": ["counter"]
  }
}
```

此示例中的成员 ID、版本、平台和桥槽必须由实际模块支持；公开设置还需满足成员 `deployment.json` 的类型与范围。组成员最多 128 个，成员 ID 与源码目录不能重复，源码目录不能互相嵌套。字段闭合，不接受额外的 Hub、运行环境或凭据字段。

模块组的源码全部包含在同一制品清单内，不能用未锁定的远程路径代替成员。外层摘要与逐文件摘要同时锁定配方、配置及成员源码。组不包含 Hub、凭据、私钥、状态目录或运行数据。导入时配方成员映射成本机实例，组不要求独立 Hub，也不授予执行权。

文件数、单文件和总字节数均有上限；链接、路径逃逸、大小写冲突、生成缓存和私人材料被拒绝。验证内容完整性不验证业务正确，也不代替执行审阅。格式属于外部分发层，不是 Hub 握手或业务消息格式。

## 来源策略与不可用状态

来源可以命名、启停、调整顺序、固定索引摘要和明确选择网络策略。优先级只排序，不静默升级或解决内容冲突。禁用来源不删除本地模块，也不终止运行实例。

默认下载器只接受公开 IPv4，HTTPS 默认端口，不携带用户认证、不跟随重定向，校验 DNS 结果并固定本次连接。明确选择的可信私网 IPv4 策略只用于已确认的网络环境，不自动启用，也不包含任意回环地址访问。下载有超时和大小边界。

刷新失败会显示实际错误与上一次索引观察时间。缓存不是最新在线证据：只能获取后台已验证的制品缓存，不沿用旧执行授权。索引或制品改变后重新审阅。

## 来源证据

后台生成绑定索引摘要、制品摘要和实际路径的来源回执，浏览器不能伪造。该回执记录内容完整性，不证明作者身份、代码安全或 OS 隔离。发布者公共证据见[信任说明](trust.md)。

[Workshop](workshop.md) 提供同样的索引入口；公开发现和下载不要求登录，发布与协作按独立社区的账号政策处理。本机通信界面与社区独立部署，社区不调用本机管理接口。

Workshop 的图标、封面和预览图属于社区展示元数据，独立于本节的索引和源码制品格式。更新图片不会改变制品摘要、源码锁或软件源条目，也不会让消费者选定的版本自动升级。模块导入和 Hub 通信无需依赖这些图片。
