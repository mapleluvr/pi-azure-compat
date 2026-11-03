# pi-azure-compat

在 Pi 的 Responses 主请求出现可识别的 Azure resource 身份错误后，以只清历史 item ID 的方式续跑并保留密文；provider 名被脱敏时仍可依靠 item/resource 指纹识别。也可用 `/azure-compat clean` 主动清理。

- [当前行为](state/behavior.md)
- [设计及验证记录](changes/2026-10-26-initial-release.md)
- [通用重试先于身份恢复的调查](changes/2026-11-02-settlement-retry-interference.md)
- [提前准备身份恢复的修复记录](changes/2026-11-02-early-id-recovery.md)
- [手动历史 ID 清理命令](changes/2026-11-02-manual-id-cleanup.md)
- [脱敏 resource 错误的自动恢复](changes/2026-11-03-redacted-resource-recovery.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前实现（0.2.0）：严格 Azure 句与脱敏强指纹都会准备一次性恢复；只有资源身份子句、缺少 same-resource 说明时提示手动 clean；status 显示最近一次错误分类与未恢复原因。strict typecheck 与 71 项测试通过，包含实际 MC 的 8 个场景；完整 pi-retry 的普通/Fast 模式 × 两种加载顺序 × 三种错误文案共 12 个场景通过。安装或更新后，运行中的会话需 `/reload`。
