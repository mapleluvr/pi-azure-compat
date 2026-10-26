# 初始版本：由资源错误实验形成 ID-only 恢复

用户要求将研究方案整理为独立插件 pi-azure-compat，并建立 public GitHub 仓库。

## 采用依据

此前受控线上研究中，保留历史 ID 的两次请求出现精确 Azure resource 400；随后仅清理 ID 的两次请求和一次额外控制请求均 response.completed。10 段密文共 33,268 字节的哈希保持一致；后两次成功请求各报告 cached_tokens=7,128。样本为缩减历史，回复很短，不构成跨 Azure 资源通用解密或 CoT 语义恢复证明。

Pi 1.4.0 的真实 SDK/loopback 实验验证了 agent_before_settle + custom state + context_edit + continue 能启动新请求。provider 内部 retry 复用 onPayload 后的参数；error 分支的 turn_end continuation 不能代替该 settlement 边界。恢复通过新 provider request 重新进入 payload hook。

Magic Context 0.49.13 的真实扩展在两种加载顺序下均通过主会话联调，每场景 4 个本地 HTTP 请求，并验证了真实 ctx_reduce 与 ctx-flush 的物化删除。此前研究测试合计 27 项通过；这不是本仓库打包版本测试数量。

## 包装时的选择

当前行为独立写在 [行为规格](../state/behavior.md)。实现将研究快照状态改为插件命名空间，增加分支持久化 on/off/reset、scope 摘要及每次 settlement 周期一次恢复上限；对 turn 外请求和多请求歧义采用保守处理。这些增量通过本仓库的失败先行测试验证。

公开材料只保留汇总和合成测试数据；原始用户 session、凭据、生产请求和密文样本留在本地调查目录。安装时须停用其他身份错误恢复实现，避免两个扩展同时接手。

## 验证记录

本仓库在 Windows / Node 24.15.0 / Pi SDK 1.4.0 下执行 `npm run check`：TypeScript strict typecheck 通过，**32/32 测试通过**，包括实际 Pi package manifest 的加载。Magic Context 0.49.13 的两顺序联调各发送 4 个 loopback HTTP 请求，扩展事件错误为 0。

恢复实现前，空 factory 的第一轮 SDK 测试出现 16 个缺失行为失败；reset 用例补足“先发生真实清理”的独立断言后也在空实现上失败。实现后全部契约通过。没有将负向用例在空实现下通过冒充正向恢复能力。

将测试迁移为可移植环境时，受控 A/B 发现：同一 MC artifact 和测试代码在额外 `tsx` import hook 下会在首个 HTTP 请求前中止，换用 Node 原生 TypeScript 类型擦除后两个加载顺序均通过。测试因此直接使用 Node ≥22.19.0 的类型擦除，不向 Pi 安装流程增加运行时转译依赖。

LSP 的主动检查为 inconclusive；类型结论来自实际执行的 tsc，而非把空诊断缓存视为确认通过。`npm pack` 已生成仅含插件、manifest、README、license 和正式规格/记录的包，测试、临时材料和 node_modules 留在 Git 开发仓库中或按忽略规则排除。

GitHub CI 配置覆盖 Ubuntu/Windows × Node 22/24；远端实际运行结果以 Actions 为准。长期线上可靠性、所有后台并发及任意扩展组合仍需在相应条件下验证。
