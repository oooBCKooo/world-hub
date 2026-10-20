# 开放模块资源来源 / Open module resource sources

软件源分发三种独立版本的资源：模块本体（`module`）、模块配置（`configuration`）和模块数据（`data`）。本体提供程序源码；配置只引用精确本体和逻辑实例，不打包源码；数据携带指定实例的业务文件。全局／局部是配置和数据的 `scope`，不增加第四种制品。下载、导入和应用配置均不自动启动程序。本机 Hub 和已取得资源不依赖来源在线。

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

`kind` 为 `module`、`configuration` 或 `data`。相同类型和 ID 的不同精确版本属于同一作品；三种类型可以使用相同 ID 和版本而各自独立。配置版本与数据版本不取代所引用模块本体的版本。

一个索引可以同时包含同一作品的多个精确版本，每个版本使用独立的 `entryId` 和原制品摘要。消费者按选中的条目取得对应字节，不把旧版请求重定向到最新版。补充较旧发布不会替换更高版本；来源排序也不构成升级指令。发布者应保留仍公开的历史版本，仅通过明确的下架操作移除有问题的条目，不能在同一版本号下偷偷修补制品。

本地 `source.path` 相对索引目录解析；远程条目使用 `source.url`，只允许明确支持的 HTTPS 来源。远程索引不能引用本机文件。`module-group`／`pack`／`template` 不属于当前公开发布、下载和导入品类，不自动转换。历史记录可留在私有存储，但不进入公开目录。

## 制品封装

`world-hub.source-artifact/v1` 具有 `format,kind,id,version,files,provenance`。`files` 的每一项包含安全相对路径、原始文件 SHA-256 与 Base64 内容。索引的摘要覆盖整个 `artifact.json` 原始字节，清单摘要覆盖每个源码文件。

单模块 `kind` 为 `module`，必须包含经过验证的 `module.json`、声明入口及实际文件，身份和版本与索引一致。

模块配置 `kind` 为 `configuration`，只包含 `configuration.json` 一个文件，格式为 `world-hub.configuration/v1`。配置声明独立的 `id,version,title,license,platforms,provides,requires`，以及：

- `scope`：`global` 或 `local`。全局配置作用于全局逻辑范围，局部配置只作用于其明确映射的范围；两者使用同一个本机 Hub。
- `modules`：1 至 128 个逻辑实例，每项为 `{id,module:{id,version,digest},configuration}`。本体 `digest` 固定模块源文件清单的 SHA-256：对 `collectSourceFiles` 得到的有序 `{path,sha256}` 数组作 JSON 编码后计算摘要。它与整个本体 `artifact.json` 的摘要不同。
- `configuration`：`topics,bridges,settings,bindings`，可选 `executionDefaults`。绑定为 `{providerId,contract:{id,version}}`，提供者必须是另一已声明逻辑实例。
- `startupPlan`：`members:[{programId,enabled,after}]`、`onFailure` 和满足依赖的 `startupOrder`。
- 可选 `data`：`[{instanceId,id,version,sha256}]` 固定数据资源与目标逻辑实例，不把业务文件放进配置。

```json
{
  "format": "world-hub.configuration/v1",
  "id": "author.counter-desk",
  "version": "1.0.0",
  "title": "Counter desk",
  "license": "MIT",
  "platforms": ["win32-x64"],
  "provides": [],
  "requires": [],
  "scope": "local",
  "modules": [{
    "id": "counter",
    "module": {"id":"author.counter","version":"2.0.0","digest":"<64 lowercase hexadecimal source-list digest characters>"},
    "configuration": {
      "topics": {"events":"example/counter/events"},
      "bridges": {"main":{"publish":["events"],"subscribe":[]}},
      "settings": {},
      "bindings": [],
      "executionDefaults": {"mode":"on-demand","idleTimeoutMs":60000}
    }
  }],
  "startupPlan": {
    "members": [{"programId":"counter","enabled":true,"after":[]}],
    "onFailure": "continue-independent",
    "startupOrder": ["counter"]
  }
}
```

本体不在配置内，公开验证只检查声明结构、逻辑引用和文件完整性。本机应用审阅才按精确本体校验桥槽、参数约束、能力提供／需要关系及当前共享实例冲突；缺少本体时显示依赖，不猜测、自动下载或执行。

模块数据 `kind` 为 `data`，包含 `data.json` 和声明的 `data/<逻辑实例 ID>/` 业务子树。清单格式为 `world-hub.module-data/v1`，含相同公开元数据、`scope`、`purpose` 和 `instances`；每个实例为 `{id,module:{id,version,digest},path,dataFormat:{id,version}}`。`path` 必须等于 `data/<id>`。数据格式由模块业务自行定义，管理器不解析、执行或迁移业务文件。

`purpose: "dataset"` 是可公开发布的现成数据集；`purpose: "backup"` 是私有备份，只能在本机导入导出，社区预览、发布和提案接口均拒绝它。备份也不能携带管理器凭据、身份、私钥、运行配置或管理缓存。不能仅凭相同 ID、版本号或数据格式声明推断业务兼容。

外层制品 JSON 最多 96 MiB，单个解码文件最多 8 MiB，解码总计最多 64 MiB；配置和数据最多 4096 个文件，模块封装最多 8192 项。根配置清单／数据清单各最多 1 MiB。路径逃逸、链接、大小写冲突与文件目录碰撞会被拒绝。管理层只捕获实例业务状态子树，管理凭据位于该范围之外；业务文件名与原始字节保持不变。完整性校验不是代码或业务安全认证。详细契约见[模块资源规范](../specs/module-resources.md)。

## 来源策略与不可用状态

来源可以命名、启停、调整顺序、固定索引摘要和明确选择网络策略。优先级只排序，不静默升级或解决内容冲突。禁用来源不删除本地模块，也不终止运行实例。

默认下载器只接受公开 IPv4，HTTPS 默认端口，不携带用户认证、不跟随重定向，校验 DNS 结果并固定本次连接。明确选择的可信私网 IPv4 策略只用于已确认的网络环境，不自动启用，也不包含任意回环地址访问。下载有超时和大小边界。

刷新失败会显示实际错误与上一次索引观察时间。缓存不是最新在线证据：只能获取后台已验证的制品缓存，不沿用旧执行授权。索引或制品改变后重新审阅。

## 来源证据

后台生成绑定索引摘要、制品摘要和实际路径的来源回执，浏览器不能伪造。该回执记录内容完整性，不证明作者身份、代码安全或 OS 隔离。发布者公共证据见[信任说明](trust.md)。

[Workshop](workshop.md) 提供同样的索引入口；公开发现和下载不要求登录，发布与协作按独立社区的账号政策处理。本机通信界面与社区独立部署，社区不调用本机管理接口。

Workshop 的图标、封面和预览图属于社区展示元数据，独立于本节的索引和源码制品格式。更新图片不会改变制品摘要、源码锁或软件源条目，也不会让消费者选定的版本自动升级。模块导入和 Hub 通信无需依赖这些图片。

Current public sources distribute independently versioned `module`, `configuration`, and `data` artifacts. Configuration documents pin module source-list digests without embedding source. Data documents declare compatible module pins, a business data format, and per-instance business subtrees. `global` / `local` describe scope. Only `dataset` data may be published; private `backup` data remains local. Artifact JSON is bounded at 96 MiB, each decoded file at 8 MiB, and all decoded files at 64 MiB. Acquisition never starts a program. See the [resource specification](../specs/module-resources.md).
