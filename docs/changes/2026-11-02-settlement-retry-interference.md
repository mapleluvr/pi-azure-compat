# 截获调查：agent_end 通用重试先于身份恢复边界

本文记录修复前的行为。已实施的方案见[提前准备身份恢复](2026-11-02-early-id-recovery.md)，主动命令见[手动清理历史 ID](2026-11-02-manual-id-cleanup.md)。

## 调查范围与结论

用户报告了两次 AgentRouter HTTP 400，错误句前新增了 `OpenAI Responses bad request:`。本轮只调查现有截获行为，没有修改恢复实现或其他插件。

现场错误句仍匹配 `src/index.ts` 的 `RESOURCE_ERROR`，两条 assistant 消息均为 `openai-responses`、`stopReason:error`、空 content。前缀、JSON 包装和 TUI 换行不是此次阻断点。

已确认的阻断路径是：`pi-retry` 在 `agent_end` 排入新的请求，Pi 优先处理排队工作，尚未执行本插件的 `agent_before_settle`。这条路径即使本插件已加载，也会使其身份恢复边界暂时不可达。现场没有保存实际请求 payload 或扩展运行时快照，因此本轮不据此宣称其他全部资格条件已满足，或反推当时所有扩展均已加载。

## 现场证据

仅在本地核对原始会话和 `~/.pi/logs/pi-retry.jsonl`；公开记录保留汇总，原始 session、trace ID 和密文不纳入仓库。

| 时间（UTC，2026-11-01） | 观察 |
| --- | --- |
| 16:01:06.761 | 第一条 AgentRouter / `gpt-6.1-sol` 空内容 Responses error 持久化 |
| 16:01:07.349 | `pi-retry` 记录第 1 次重试：预算 1000、间隔 2000ms、Fast-Retry 开启 |
| 16:01:09.378 | 隐藏 `__retry_trigger` entry 持久化 |
| 16:01:21.105 | 第二条相同类别的空内容 error 持久化 |
| 16:01:21.126 | `pi-retry` 记录第 2 次重试：同一预算与间隔 |
| 16:01:23.152 | 第二个隐藏重试 entry 持久化 |
| 16:01:25.250 | 下一次 assistant 请求以 aborted 结束 |

该段会话没有真正的 `customType:pi-azure-compat:state:v1` 状态 entry。之前宽泛的字符串搜索还命中了其他工具结果内的文本；那些不是本插件状态，核对时按 entry 类型和 customType 精确区分。

## 调用链

Pi 1.4.0 的 `dist/core/agent-session.js`：

1. `_startRun` 的循环先调用 `_handlePostAgentRun()`。
2. `_handlePostAgentRun()` 在处理内建重试与压缩之后检查 `agent.hasQueuedMessages()`。
3. 有排队工作就 `agent.continue()` 并直接进入下轮循环。
4. 只有没有自动工作时，才执行 `_runBeforeSettleBoundary()`。

`pi-retry/index.ts` 的 `agent_end` handler 对这类非内建重试、非额度和非上下文溢出错误执行等待，再调用 `pi.sendMessage(..., { triggerTurn: true })`。该调用使第 2 步得到 true。

本插件的错误识别与状态写入全部位于 `agent_before_settle`。通用重试期间，每次 `turn_start` 和 provider request 更新的是当前请求快照，但身份修复 handler 尚未运行。通用重试预算耗尽后若仍是可修复错误，恢复边界才有机会运行；若通用重试已成功或操作已取消，则不会对此前错误补做身份恢复。

**交换扩展加载顺序无法改变两个不同生命周期阶段的先后关系。** 已有的 `event.continue` 守卫只协调同一 settlement 边界上的贡献，不能协调尚未到达该边界的 `agent_end` 排队。

另外，本插件保留失败 raw entry 和 usage，错误消息可能先显示在 TUI 中。因此单看 Error 显示不能证明恢复失败；应结合恢复通知、状态 entry 和后续实际 payload 判断。

## 受控实验

使用本仓库真实 Pi SDK 1.4.0、原始未修改的 `src/index.ts` 和 loopback HTTP/SSE 服务。复用 `runFixture`，额外注册与 `pi-retry` 相同的 `agent_end -> sendMessage(triggerTurn:true)` 调用及 context 标记过滤。实验不加载完整 `pi-retry`，不修改用户设置、不等待生产重试间隔，也不访问真实模型。

服务器固定依次返回：资源错误、资源错误、成功。历史含 3 个顶层 item ID。唯一改变的变量为排队重试预算与扩展加载顺序。

| 通用重试预算 | 每个实际 HTTP 请求的 ID 数 | 身份恢复状态 entry | 解释 |
| --- | --- | --- | --- |
| 0 | `[3, 0]` | 1 | 第一条错误即可进入身份恢复；第二条错误达到本插件单操作修复上限后停止 |
| 1 | `[3, 3, 0]` | 1 | 先原样通用重试；预算耗尽后身份恢复才清 ID |
| 2 | `[3, 3, 3]` | 0 | 两条错误都没有进入身份恢复边界；最终只在成功 outcome 上进入 settlement |

每个预算均执行 retry-first、repair-first 两种加载顺序，6 个场景全部通过断言，扩展事件错误为 0。此前 `node --test test/*.test.mjs` 32/32 通过；这些测试没有覆盖 agent_end 通用重试先行的组合，所以测试全绿与本次现场行为不矛盾。

本地重跑入口和原始实验输出：

```powershell
node docs/.temp/reproduce-retry-priority.mjs
# docs/.temp/retry-priority-results.jsonl
```

临时脚本与输出不纳入 Git。正式记录中的调用链、实验条件和结果可独立用于重新构造验证。

## 后续方向（尚未实施）

需要协调身份恢复与通用 fallback 的执行优先级，而不是扩大错误正则或删除 encrypted_content。候选是把通用 fallback 迁到身份恢复之后的同一可组合边界，或为 agent_end fallback 建立明确的恢复交接协议；需要同时考虑本插件 off、不适用请求、修复失败和其他 continuation 的行为。

仅切换 Fast-Retry 模式不足以消除该关系：正常模式的 `pi-retry` 同样在 agent_end 排队。先停用覆盖此错误的通用自动重试可以隔离验证，但本轮没有修改任何用户配置。
