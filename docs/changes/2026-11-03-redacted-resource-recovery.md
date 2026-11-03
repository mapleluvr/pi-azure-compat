# 脱敏 resource 身份错误的自动恢复

## 采用的变化

用户报告 AgentRouter 返回的同一类错误在 provider 名被替换为 `***` 后不再触发自动恢复，且错误体不含单个 item ID：

```text
AgentRouter API error (400): {"message":"OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it. [trace_id=...]","type":"invalid_request_error","param":"","code":null}
```

本地会话中该错误对应 `stopReason=error`、空 content、`api=openai-responses`、provider `AgentRouter`、model `gpt-6-astra`，scope 摘要与该会话已记录的 Azure compat scope 一致。随后执行 `/azure-compat clean` 捕获 121 个顶层字符串 ID，下一请求成功。这说明清理算法本身可用，阻塞点是自动错误匹配仍要求字面 `Azure`。

本轮采用用户确定的三项范围：

1. 自动恢复只接受“严格句”和“脱敏强指纹”，不加入 A 子句 + `OpenAI resource` 的中等强度。
2. 只有 A 子句、缺少 same-resource 说明时，不改变请求；每个用户操作至多提示一次 `/azure-compat clean`。
3. `/azure-compat status` 增加最近一次错误分类和未恢复原因。

## 匹配规则

错误文本先归一化：把 JSON 中可能出现的转义 `\n`/`\r`/`\t`、ANSI 控制序列和连续空白转成单空格，再分类。

| 分类 | 条件 | 自动动作 |
| --- | --- | --- |
| `strict` | 含 `The requested item was created under a different Azure OpenAI resource` | 准备一次 ID 清理并续跑 |
| `redacted` | 含 `requested item was created under a different ... resource`，且含 `same resource that created the item` | 准备一次 ID 清理并续跑 |
| `weak` | 只含前一个子句 | 不改变请求，当前操作提示一次手动 clean |
| `none` | 其他文本 | 不改变请求 |

A 子句的 `resource` 后带负向前瞻，排除 `resource group`、quota、limit、provider 等其他资源身份措辞；B 是稳定的服务端解释句，因此 `***`、网关前缀、trace_id 和换行都不会阻止强指纹。

这里没有采用“A + 任意 `OpenAI resource`”的较弱规则。A 本身已经足够独特，但单独出现时可能来自其他资源级错误；B 让 `redacted` 仍保留服务端的“使用创建 item 的同一资源”语义。完全无法识别的错误继续走 `/azure-compat clean`，不猜测。

## 全量清理的边界

错误体没有可用的单个 item ID（`param` 为空、`code` 为 null），插件也不发探测请求，因此命中后记录失败请求中的全部顶层字符串 ID。下一次请求统一省略这些 ID；正文、encrypted_content、call_id、工具配对、摘要和 raw entry 不变。内联 Responses 请求的 ID 是可选的，全量抑制因此可以重放；后来新生成的 ID 正常保留。

这一行为与手动 clean 共用同一套捕获和清理逻辑，不新增按错误文案猜测单个 ID 的路径。每次用户操作到最终 settlement 仍最多准备一次身份修复；继续失败时不扩大删除范围。

## 诊断

`/azure-compat status` 在原有开关、ID 数、手动清理和运行期统计后追加：

```text
Last error: redacted (prepared).
```

括号内是本次未继续自动恢复的原因：`prepared`、`budget`、`no-ids`、`disabled`、`scope`、`unmatched`、`continued`、`multi-request`、`aborted` 等。诊断只存在当前 runtime，不写入会话，不改变状态或清理行为。恢复 warning 也会标注本次分类，例如 `(redacted)`。

## 失败先行与验证

先加入测试并在旧实现上运行，出现 8 个预期失败：

- `masked-resource` 与单行 `router-masked-resource` 都没有发出第二次请求。
- 两个 status 用例没有 `Last error` 字段。
- pi-retry 两种加载顺序的 masked 场景，第二次请求仍带 3 个 ID。
- 三轮排队 weak 错误没有产生提示。
- masked 错误的 rejected 状态没有跨磁盘 resume。

手动 clean 的磁盘恢复用例改用完全不可识别的 `opaque-resource` 文案，在旧实现上仍然通过，作为“手动路径不依赖匹配器”的基线。`resource-group` 负向用例也在旧实现上通过，用于防止扩展匹配后误伤。

实现后：

- `npm run check`：strict typecheck 通过，**71/71 测试通过**。
- 实际 Magic Context 0.49.13：4 个自动恢复场景（两种加载顺序 × 独立/排队）、2 个脱敏恢复场景、2 个手动清理场景，共 8 个，各 4 个请求；脱敏场景的错误文本含真实换行和 same-resource 说明。扩展错误为 0。
- 本机完整 `../pi-retry/index.ts`：普通/Fast-Retry × retry-first/repair-first × `router-resource`/`router-masked-resource`/`masked-resource`，共 12 个场景。每个场景 2 个请求，ID 数为 `[3, 0]`，密文保留，扩展错误 0。隔离日志记录 12 次 retry 和 12 次 retry_succeeded；源码 SHA-256 为 `ba8e7db9bd245f0fe65e6471d034af67f4c8cd7a05f1999f2c3e74c2176e353c`。
- 对本地实际错误重新分类，结果为 `redacted`；该结果来自实际存盘的 298 字符错误文本，不是只测构造样例。
- 主动 LSP 检查对源码返回 inconclusive，未把空 diagnostics 当作确认；类型结论来自实际 `tsc --noEmit`。Markdown 语言检查本次不可用，文档由人工核对，不称其为“Markdown 检查通过”。

本地材料：`docs/.temp/red-redacted-recovery.txt`、`green-redacted-recovery.txt`、`green-retry-redacted.txt`、`full-retry-check.mjs`。

## 本机应用

工作区版本为 `0.2.0`。本机 git 安装副本的同步与运行中会话的 `/reload` 由用户在目标环境完成；本记录不宣称远端发布或运行中会话已经更新。同步前应保留安装副本的旧入口备份，避免覆盖其本地状态。

远端发布前还需要：提交工作区、按发布流程更新远端，并在安装副本上重跑同一组 MC/pi-retry 验证。
