# pi-azure-compat

在 Pi 的 Responses 主请求出现可识别的 Azure resource 身份错误后，以只清历史 item ID 的方式续跑并保留密文；provider 名被脱敏时仍可依靠 item/resource 指纹识别。也可用 `/azure-compat clean` 主动清理。

- [当前行为](state/behavior.md)
- [设计及验证记录](changes/2026-10-26-initial-release.md)
- [通用重试先于身份恢复的调查](changes/2026-11-02-settlement-retry-interference.md)
- [提前准备身份恢复的修复记录](changes/2026-11-02-early-id-recovery.md)
- [手动历史 ID 清理命令](changes/2026-11-02-manual-id-cleanup.md)
- [脱敏 resource 错误的自动恢复](changes/2026-11-03-redacted-resource-recovery.md)
- [0.2.0 发布、本机更新与已知问题](changes/2026-11-12-0.2.0-release.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前发布版本：0.2.0，已推送远端 main 并从远端更新本机 Git 安装副本；运行中的 Pi 会话需 `/reload`。严格 Azure 句与脱敏强指纹都会准备一次性恢复，弱指纹提示手动 clean，status 显示最近一次错误分类。验证与本版本保留的问题见发布记录。

当前工作：两项 P2（resource 类型边界、跳过原因诊断）留待后续修复；长操作恢复额度与 required-reasoning 策略待决。入口为 `docs/.temp/active-plan.md`；调查证据见 `docs/.temp/hub-redacted-install-rollback.md` 与 `docs/.temp/long-operation-reasoning-failure.md`。
