# 软界面计数器 / Soft UI Counter

此独立程序要求 `soft-ui.windows@1.0.0` 提供者。`deployment.json` 指定默认目标为 `example.soft-ui-desktop@0.3.0`，并将本模块的 `commands`、`events` 别名分别接到宿主的同名别名。在通信管理界面导入本模块 ZIP 时，若本机已登记唯一匹配宿主，导入审阅会自动填好目标和主题；多个匹配实例需要选择一个；缺少匹配宿主则显示需要的模块与版本，先从社区下载并导入宿主，再重新检测本模块。

确认默认接线、权限、窗口标题、视图名称及首次运行的初始计数后导入。导入不启动程序，也不修改宿主参数或权限。先启动宿主，再启动计数器。宿主原有的具体主题可以调整，计数器会在导入审阅时读取所选宿主当前的 `commands`、`events` 映射；仅名字相似的其他模块不会被当作指定宿主。

如果宿主已在运行，完成计数器导入后需自行停止并重新启动宿主，使其读取新增绑定的允许主体，再启动计数器。管理器不会为新增连接自动重启现有程序。

把本模块放进模块组发布时，以 `module-group.json` 内成员的完整 `configuration` 为准，直接预配组内的主题、桥权限与能力绑定。导入组不会再使用成员源码的默认目标去连接组外宿主。

按钮操作经 Hub 送回本程序；本程序持久保存计数与修订，并发送新界面描述。重复事件不会重复计数，重新启动会继续原有状态。初始计数仅对新实例生效。不同实例具有独立主体与状态，重复使用相同视图名称也不会覆盖另一个实例。

The default connection selects `example.soft-ui-desktop@0.3.0`, binds `soft-ui.windows@1.0.0`, and maps the counter's `commands` and `events` aliases to the provider's corresponding current topics. Import through the communication management interface. One exact installed match is filled into the review automatically; multiple instances require a choice; a missing match shows the module and version to download and import before checking again. Import leaves the new counter stopped and does not edit the provider or its running state. After importing both modules, start the desktop provider before the counter. An already running provider must be stopped and started again by the user to load the new permitted consumer; the manager does not restart it automatically.

A published module group supplies its own complete topic, bridge and capability configuration; that recipe takes precedence over this module's default connection and does not select an external provider. The counter owns durable business state and deduplicates user events. Initial count applies only to a new instance. Separate instances retain separate identities and state, even with the same view name.
