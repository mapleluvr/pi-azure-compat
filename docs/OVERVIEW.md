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
- [0.2.1 发布、本机更新与验证](changes/2026-11-13-0.2.1-release.md)
- 本地临时材料：`docs/.temp/`（不纳入 Git）。

当前发布版本：0.2.1。已推送远端 main 并从远端更新本机 Git 安装副本；运行中的 Pi 会话需 `/reload`。每条连续失败链一次自动修复，正常完成的主模型响应（包括工具调用）刷新额度，已知拒绝 ID 继续清理。严格/脱敏强指纹、弱指纹提示与 status 分类保持。

Pi 1.4.0/1.5.2 各 91 测试、完整 pi-retry 48 场景通过；实际安装入口另通过当前 SDK/MC 的 91 测试、完整 pi-retry 24 场景及原始报错重放。功能提交 CI 已成功，验证边界和保留的诊断见 0.2.1 发布记录。

当前实现工作已完成。后续为两项 P2（resource 类型边界、跳过原因诊断）及独立 required-reasoning/MC 超预算历史配对策略；本地待办与证据入口是 `docs/.temp/active-plan.md`。
