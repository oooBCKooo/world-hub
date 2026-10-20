# 软界面桌面宿主 / Soft UI Desktop

在 Launcher 中导入本模块 ZIP；使用新组合或全局 Hub 独立程序入口绑定需要界面的程序，审阅后启动。Launcher 为固定 Electron 44.7.1 准备独立环境，不需要终端安装。

此程序提供 `soft-ui.windows@1.0.0`。它只接受已绑定消费者的界面描述，为每个消费者及视图分别创建原生窗口，并把操作送回视图所属主体。业务程序自己保存、计算和更新业务状态。视图快照、窗口位置和 SDK 游标位于本实例状态目录，不进入源码 ZIP。

添加新的消费者后，重新审阅并重启本宿主。正在运行的程序不会自动信任新主体。当前正式桌面部署平台为 Windows x64；权限声明包括全局 Hub、回环 API 与所属子进程，它不提供 OS 沙箱。

Import this module ZIP in Launcher, bind its consumers in a new composition or through the Global Hub's independent-program flow, then review and start. Launcher prepares the pinned Electron environment. The module owns native windows and durable view snapshots; business state remains with each consumer. Restart after reviewing newly bound consumers. Current supported desktop deployment: Windows x64.
