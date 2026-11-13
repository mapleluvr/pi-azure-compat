# pi-azure-compat

在 Pi 的 Responses 主请求出现可识别的 Azure resource 身份错误后，以只清历史 item ID 的方式续跑并保留密文；provider 名被脱敏时仍可依靠 item/resource 指纹识别。也可用 `/azure-compat clean` 主动清理。

- [当前行为](state/behavior.md)
- [设计及验证记录](changes/2026-10-26-initial-release.md)
- [通用重试先于身份恢复的调查](changes/2026-11-02-settlement-retry-interference.md)
- [提前准备身份恢复的修复记录](changes/2026-11-02-early-id-recovery.md)
- [手动历史 ID 清理命令](changes/2026-11-02-manual-id-cleanup.md)
- [脱敏 resource 错误的自动恢复](changes/2026-11-03-redacted-resource-recovery.md)
- [0.2.0 发布、本机更新与已知问题](changes/2026-11-12-0.2.0-release.md)
- [按成功响应切分连续失败链的恢复额度](changes/2026-11-13-failure-chain-recovery.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前发布版本：0.2.0，已推送远端 main 并从远端更新本机 Git 安装副本；运行中的 Pi 会话需 `/reload`。严格 Azure 句与脱敏强指纹都会准备一次性恢复，弱指纹提示手动 clean，status 显示最近一次错误分类。验证与本版本保留的问题见发布记录。

开发版本：0.2.1，已实现“连续失败链一次修复、成功模型响应刷新额度”。失败先行与完整验证见对应变更记录；Pi 1.4.0/1.5.2 的 91 测试及完整 pi-retry 48 场景通过。本轮未发布、未更新安装副本；开发行为需要从开发入口加载。

当前实现工作已完成。后续为两项 P2（resource 类型边界、跳过原因诊断）及独立 required-reasoning/MC 超预算历史配对策略；本地待办与证据入口是 `docs/.temp/active-plan.md`。
