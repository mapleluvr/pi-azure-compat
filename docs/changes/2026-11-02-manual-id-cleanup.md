# 手动清理历史 item ID

## 触发场景与接口

AgentRouter 返回了另一种资源错误：`The requested item was created under a different *** OpenAI resource`。现有自动恢复要求错误句中的资源名为 Azure，因此该脱敏文案不会触发自动恢复。

新增 `/azure-compat clean`，允许用户主动清理而不依赖错误匹配。先停止正在运行的重试，执行命令，再重新提交原问题。命令会开启当前分支的兼容处理，自身不调用模型。

在下一次符合条件的主会话 Responses 请求中，插件捕获上下文变换后实际 payload 的顶层字符串 item ID，记录为当前模型 scope 的待清理 ID，当次即删除这些字段。后续请求继续清理同一批 ID，后来新生成的 ID 正常保留。需要清理新增历史时可再次执行命令。

清理不修改原始消息或签名，也不删除 encrypted_content、正文、摘要、MC 标签、工具 call_id。自动错误匹配规则保持原有范围。

## 状态与边界

- 新增分支 custom 状态 `clean-next`，按 provider/API/baseUrl/model 隔离；重载和磁盘 resume 后仍有效。
- 下一个符合条件的请求将当时实际 ID 记入既有清理集合并消费 `clean-next`。空 ID 集合也消费一次，防止误清理未来 ID。
- 引用式历史、其他模型和非主会话请求不执行、不消费清理。
- `off` 暂停清理，`on` 恢复；`clean` 主动开启处理。
- `reset` 取消当前 scope 的待执行清理并清除已捕获 ID，恢复尝试旧 ID。它与 `clean` 的作用相反。
- `/azure-compat status` 同时报告已知 ID 数和手动清理的 pending/idle 状态。

## 验证

使用真实 Pi SDK 与 loopback HTTP/SSE，无真实 AgentRouter 请求。

手动命令的测试先在原实现上运行，6 个正向行为失败，断言显示实际请求仍带历史 ID；实现后全部通过。原有边界保护测试在旧实现上也可能通过，它们验证清理不会越界。

最终 `npm run check`：strict typecheck 通过，**60/60 测试通过**。新增覆盖主动清理、密文及 call_id 保留、原始签名不变、后续新 ID 保留、脱敏错误后磁盘恢复、off 分支、引用请求延迟执行、空集合消费、reset、模型隔离、分支回退和非 Responses 模型。

真实 Magic Context 0.49.13 的两种加载顺序均验证了手动命令。用未实现命令的旧安装副本运行同样用例，两者都在“历史 ID 应已清除”的断言失败；新实现通过，且真实 ctx_reduce / ctx-flush 仍正常。原有独立恢复和排队恢复的 4 个 MC 场景继续通过。

`npm pack --dry-run` 与 `git diff --check` 通过。主动 LSP 批次中无返回的类型错误，部分文件为 inconclusive；类型验证以实际 tsc 结果为准。

## diagnostics 核对

pi-lens 同时通过多套规则报告相同源码形状，因此诊断总数包含重复项。当前已检查的内容包括：

- `unknown`、`Record<string, unknown>` 和 `typeof` 位于实际外部 provider payload / 会话 custom 状态边界，用于保守检查未知数据和保留未知字段，保留这些检查。
- `delete copy.id` 仅操作请求 item 的浅拷贝，是实现删除该字段的预期行为。
- 命令 handler 的 async-noise 属于接口约束：Pi 的 `RegisteredCommand.handler` 声明要求 `Promise<void>`。
- filter/map、else-return 和复杂度规则属于仍存在的代码风格/维护性提示，本轮未把它们当作已修复的问题。
- 新测试中一个未使用的解构变量已改用 `_id`。HTTP JSON 比较先去除序列化时省略的 undefined 字段，避免把 SDK 内部字段表示差异误判为清理问题。

本地证据位于 `docs/.temp/red-manual-clean.txt`、`red-manual-magic.txt`、`check-manual-clean.txt` 和 `pack-manual-clean.json`，不纳入 Git。
