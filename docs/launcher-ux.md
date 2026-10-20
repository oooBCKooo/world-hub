# Launcher 操作体验

当前入口为总览、模块库、已接入模块、模块组、通信、工作台、下载和环境。它们共同使用一个全局 Hub，操作细节见[Launcher](ecosystem/launcher.md)和[工作台](ecosystem/launcher-deployment.md)。

- 路径字段可以选择本机目录／文件、浏览、使用最近路径和有限范围候选发现。选中路径仍需检查实际内容，不直接授权执行。
- 多版本卡片保留可用选择。原选项失效时自动选择可用项并显示提示；不会下载、升级、启动或继承旧审阅。
- 工作台直接修改实例公开参数和接线，保存前展示修订与共享影响，不先生成整合包。
- 模块组引用实例，多个组共享成员时展示影响范围，不复制进程。
- 启动计划可以精确排序、选择部分成员和配置前置关系。恢复默认只改草稿，保存另经审阅。
- 进程、健康、自报就绪和真实桥连接分别显示；失败有明确原因，不把缺失证据当成功。
- 中英文界面与窄屏使用同一组产品对象和后端事实。

## English

Launcher has Overview, Module Library, Connected Modules, Module Groups, Communication, Workbench, Downloads and Environment. It uses one shared Hub. Paths support selection and bounded discovery. Missing choices fall back visibly without executing anything. Workbench saves instance configuration directly after reviewing revisions and shared impacts. Groups reference instances; startup plans select and order members. Process state and actual communication remain separate observations.
