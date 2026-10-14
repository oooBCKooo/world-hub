# 软界面计数器 / Soft UI Counter

此独立程序要求 `soft-ui.windows@1.0.0` 提供者。在 Launcher 导入本模块 ZIP，将要求绑定到桌面宿主，可调整窗口标题、视图名称及首次运行的初始计数，然后审阅并启动。

按钮操作经 Hub 送回本程序；本程序持久保存计数与修订，并发送新界面描述。重复事件不会重复计数，重新启动会继续原有状态。初始计数仅对新实例生效。不同实例具有独立主体与状态，重复使用相同视图名称也不会覆盖另一个实例。

Import this independent module, bind its `soft-ui.windows@1.0.0` requirement to a desktop provider, adjust the public settings, then review and start. The counter owns durable business state and deduplicates user events. Initial count applies only to a new instance. Separate instances retain separate identities and state, even with the same view name.
