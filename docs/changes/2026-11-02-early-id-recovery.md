# 修复：在通用重试之前准备 ID-only 身份恢复

## 采用的变更

用户在[截获调查](2026-11-02-settlement-retry-interference.md)后要求解决重复出现的同类资源错误。新的错误仍包含原有完整 Azure resource 身份错误句，不需要扩大正则。

本轮将错误识别和修复准备从 agent_before_settle 提前到 turn_end，在 agent_end 的通用重试排队之前提交：

- 记录本次实际请求中剩余的顶层字符串 ID。
- 以 context_edit 省略本次失败 entry 的未来上下文贡献，保留 raw entry 与 usage。
- 记住同一 scope 的待续跑标记，使用原有单操作一次修复预算。

通用重试排入的下一轮直接使用已记录的清理策略，turn_start 消费待续跑标记。若没有任何排队工作，agent_before_settle 仅补一次 continuation。这样保留了 Pi 1.4.0 上 error 分支忽略 turn_end continuation 的已验证事实，同时让 pi-retry 普通模式和 Fast-Retry 都能立即复用修复。

当前行为同步到 [behavior.md](../state/behavior.md)。没有修改 pi-retry 源码、错误匹配范围、密文、工具 call_id 或任何用户重试配置。

## 协作与边界

错误判断按 turn_end.messageEntryId 定位本次贡献，不再搜索所有投影中的最后一个 assistant。较早 turn_end handler 已请求 continuation，或已移除该失败贡献时，本插件跳过。之后的 settlement handler 可共享已准备的修复；本插件不为其额外再发一轮。

这是有意调整的阶段职责：身份清理的准备与新请求的发起分开。因此旧测试中“较早 settlement owner 接手时，历史 ID 必须原样发送”的断言已改为“复用清理且仅有一次下一请求”；真正已在 turn_end 接手的 owner 仍被尊重。测试 owner 使用已有可继续上下文，不会误删更早的历史 assistant。

引用式历史、部分输出、确认拒绝前取消、无可清理 ID、多 provider hook 歧义、策略关闭等条件继续阻止身份修复。确认拒绝后取消会停止新请求，但已记录的拒绝知识保留到 disk resume。on/off/reset 会失效运行时待续跑标记。recoveries 计数表示准备次数，而不是服务端成功次数。

每个操作最多准备一次身份修复。继续失败时不扩大删除范围；通用重试是否继续由其自身策略决定。

## 失败先行与验证

全部使用真实 Pi SDK 1.4.0 和 loopback HTTP/SSE 服务，不访问真实模型。

1. 新增队列协作测试在未修改实现上出现 5 个缺失行为失败：四个“下一次仍携带 3 个 ID”的失败和一个修复预算重复续跑失败。
2. 旧实现快照再次验证 settlement owner-first、新阶段取消/disk resume 与 reset 条件的失败；这些用例在新实现上通过。
3. 新 MC 排队测试使用原生加载的旧实现快照时，两种顺序均在“下一请求仍保留历史 ID”断言失败；新实现通过。
4. 最终 `npm run check`：strict typecheck 通过，**48/48 测试通过**。

测试覆盖请求包装（包括 AgentRouter 的平铺 JSON + `OpenAI Responses bad request:` 前缀）、密文字节保留、工具配对、无额外请求、单操作预算、off/reset、两阶段取消、磁盘状态、多 provider hook 歧义、分支/端点/模型隔离和其他 continuation。

实际 Magic Context 0.49.13 的联调扩展为：magic-first/repair-first × 独立续跑/排队重试，共 4 个场景，各 4 个请求。包含重新投影、新 ID 保留、真实 ctx_reduce 与 ctx-flush，扩展错误为 0。historian/dreamer/自动搜索保持关闭，验证范围不外推到所有后台并发组合。

另外加载本机完整 `../pi-retry/index.ts`，在隔离 HOME/USERPROFILE/PI_CODING_AGENT_DIR、1000 次预算与 2 秒间隔下执行：

| 模式 | 加载顺序 | 请求数 | 每个请求的 ID 数 |
| --- | --- | --- | --- |
| 普通 | retry-first | 2 | `[3, 0]` |
| 普通 | repair-first | 2 | `[3, 0]` |
| Fast-Retry | retry-first | 2 | `[3, 0]` |
| Fast-Retry | repair-first | 2 | `[3, 0]` |

原始 pi-retry 源码 SHA-256：`ba8e7db9bd245f0fe65e6471d034af67f4c8cd7a05f1999f2c3e74c2176e353c`。仅将它的旧 TUI 包名解析到当前 fork 的 TUI 依赖；没有替换 retry handler。隔离日志记录 4 次 retry 和 4 次 retry_succeeded，密文保留，扩展事件错误为 0。

上述 4 个完整 pi-retry 场景还以本机实际 git 安装副本作为 repair entry 重跑，全部通过。安装副本与工作区源码逐字核对（统一行尾）一致。

主动 LSP 检查 4 个改动源码路径为 inconclusive，不能把空 diagnostics 当成确认干净；类型结论来自实际 tsc。Markdown 检查通过。

本地实验材料在 `docs/.temp/`：`red-retry-interop.txt`、`red-legacy-compat.txt`、`red-staging-controls.txt`、`red-magic-fallback-native.txt`、`check-retry-release.txt`、`full-retry-check.mjs`、`full-retry-results.jsonl`、`installed-retry-results.jsonl`。

首次用额外 Node import resolver 注入旧实现的 MC 负向实验在首个请求前失败，不能算功能 RED；已改成不加 import resolver 的独立旧实现副本测试，并确认它在 ID 清理断言上失败。对应无效实验输出仅留在临时目录。

## 本机应用

同步前核对 `~/.pi/agent/git/github.com/mapleluvr/pi-azure-compat` 为干净安装副本、源码与已验证旧实现一致。备份保存到本地 `docs/.temp/installed-index-before.ts`，再对安装入口做同样的 6 处精确修改，没有改个人设置或自动重载任何正在运行的会话。

运行中的错误重试先用 Escape 停止，然后在目标 Pi 会话执行 `/reload`、`/azure-compat status`，重新提交原问题。确认状态为 on；出现身份恢复警告后，状态应显示清理操作。已显示的旧 error entry 保留，不代表当前请求仍未修复。

本轮修复已经应用到工作区和本机 git 安装副本，远端发布未执行；安装副本当前有本地 src/index.ts 修改。后续更新远端时应使用正式修复提交，避免覆盖该本地补丁或因脏工作区导致更新失败。
