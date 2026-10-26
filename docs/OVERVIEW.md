# pi-azure-compat

在 Pi 的 Responses 主请求出现精确 Azure resource 身份错误后，以只清历史 item ID 的方式续跑并保留密文。

- [当前行为](state/behavior.md)
- [设计及验证记录](changes/2026-10-26-initial-release.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前状态：初始实现与安装包装已完成，本地 strict typecheck 和 32 项测试通过。暂无进行中的功能开发；跨平台 CI 结果见 GitHub Actions，未覆盖的运行范围见行为与变更记录。
