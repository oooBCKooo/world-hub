# 本机模块管理

World Hub 已与界面分离，当前CLI只启动非界面Hub，不提供 `/manage` 页面。模块、配置、数据和生命周期能力仍通过本机管理API提供。

见[项目分离](../specs/ui-separation.md)、[管理API](../specs/management.md)、[模块资源](../specs/module-resources.md)。需要图形管理时独立启动World Hub UI并指定Hub地址。旧Launcher页面与启动方法不是当前入口。
