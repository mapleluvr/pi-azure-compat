# pi-azure-compat

在 Pi 的 Responses 主请求出现精确 Azure resource 身份错误后，以只清历史 item ID 的方式续跑并保留密文；也可用 `/azure-compat clean` 主动清理。

- [当前行为](state/behavior.md)
- [设计及验证记录](changes/2026-10-26-initial-release.md)
- [通用重试先于身份恢复的调查](changes/2026-11-02-settlement-retry-interference.md)
- [提前准备身份恢复的修复记录](changes/2026-11-02-early-id-recovery.md)
- [手动历史 ID 清理命令](changes/2026-11-02-manual-id-cleanup.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前实现：拒绝 ID 记录提前到 turn_end，通用重试复用修复；支持 `/azure-compat clean` 主动清理。strict typecheck 与 60 项测试通过，包含实际 MC 的自动/排队/手动清理；完整 pi-retry 的普通/Fast 模式与两种加载顺序另有 4 场景验证。安装或更新后，运行中的会话需 `/reload`。
