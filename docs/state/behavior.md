# 行为与接口

## 请求与恢复

插件默认开启，服务于 Pi 1.4.0 及以上版本的主会话 Responses 请求。适用请求使用 openai-responses 或 azure-openai-responses API、内联 input、当前选中模型，store 为 false 或未指定，历史以完整内容回放。

首次请求正常保留服务端 item ID。仅当空内容 assistant error 命中下列两类错误文本之一时，插件在 turn_end 记录该次实际请求中的 ID，并以 context_edit 省略本次失败 entry 的未来上下文贡献：

- 完整句 `The requested item was created under a different Azure OpenAI resource`；
- 同时包含 `requested item was created under a different ... resource` 子句与 `same resource that created the item` 说明的脱敏句，例如 provider 名被替换为 `***`、文案前带网关前缀或 trace_id。

错误判断关联到当前 turn 的 messageEntryId，并在比较前归一化转义换行、ANSI 控制序列和连续空白。

新请求仅清理这批受影响的顶层字符串 ID，保留 encrypted_content、call_id、正文、摘要和其他字段。后续请求继续对这些历史 ID 应用清理；新生成的 ID 正常保留。一次运行操作内，每条连续失败链最多准备一次新的身份修复，并由本插件补发至多一次 continuation。

成功模型响应结束当前失败链并刷新自动修复额度：turn_end 的 outcome 为 completed，已持久化的 assistant 消息正常结束（stop 或 toolUse），其 provider/API/model 与唯一捕获的符合条件的主请求一致，且当前未取消。随后出现资源身份错误时，插件可以记录当时新出现的历史 ID。普通重试、排队 continuation、上下文重投影、部分输出后失败和其他错误继续共享当前失败链的额度。每次运行初始化或最终 settlement 清空运行期失败链状态；已确认的拒绝 ID 继续随活动分支持久化。

修复状态在 agent_end 之前提交。pi-retry 等流程排入的下一轮请求直接复用这批状态；下一轮 turn_start 消费待续跑标记。没有排队工作时，agent_before_settle 在同一模型 scope、未取消、策略开启且上下文可继续的条件下补一次 continuation。通用重试的普通/Fast 模式及两种加载顺序均适用；它自身的重试预算保持原有行为。

引用式历史（store:true、previous_response_id、item_reference）、部分流式输出、确认拒绝前取消、空 ID 集合、较早 turn_end handler 已接手、单 turn 中出现多个 provider 请求的歧义场景，均按原始错误交还调用方。较早 turn_end handler 已移除的失败贡献同样跳过。后续 settlement handler 可以复用已准备的修复，不额外重复发请求。密文校验、工具配对和普通网络错误由其各自处理路径负责。

错误只保留资源身份子句、缺少 same-resource 说明时，插件保持请求原样，并在当前操作内至多提示一次 `/azure-compat clean`。完全无法识别的错误不改变请求，由手动清理路径处理。确认拒绝后取消会停止续跑，但已记录的拒绝 ID 跟随分支保留；resume 后继续用于清理。on/off/reset 操作会清除当前运行时待续跑标记。

## 状态

状态作为 custom entries 存入活动分支，按 provider/API/baseUrl/model 的 SHA-256 scope 区分。保存受影响 ID、待执行的手动清理及开关/reset 操作；上下文压缩、重载和磁盘 resume 后从活动分支读取。原始会话消息、签名和 MC 标签保持原有内容。

手动清理以 clean-next 状态准备。在下一次符合条件的主会话 provider 请求中，捕获经 MC 等上下文变换后的实际全部顶层字符串 item ID，记录到既有 ID 集合并消费 clean-next。即使 ID 集合为空也消费一次。之后只继续清理这些已知 ID，保留后来生成的 ID。引用式请求或其他模型 scope 不执行、不消费该状态。

失败消息保留 raw entry 和 usage，其 future-context contribution 通过 context_edit 置空。custom 状态 entries 不进入模型上下文。

## 命令

- `/azure-compat`、`/azure-compat status`：当前开关、当前模型受影响 ID 数、手动清理是否待执行、运行期统计，以及最近一次错误分类和未恢复原因。
- `/azure-compat clean`：需要当前模型为 Responses API；开启当前分支插件，准备下一次符合条件的请求清理当时全部历史 item ID。命令不依赖错误匹配、不发起模型调用；用户随后重新提交问题。可重复执行以处理后来新增的历史。
- `/azure-compat off`：当前分支停止清理与自动身份修复。
- `/azure-compat on`：当前分支恢复处理。
- `/azure-compat reset`：清除当前模型 scope 的受影响 ID 记录并取消待执行的手动清理；下一次对这批身份原样发送。

开关和 reset 跟随活动分支持久化。off 暂停待执行手动清理，on 恢复；clean 会主动开启分支开关。计数仅表示本次扩展 runtime 的操作，重载后重新计数。recoveries 统计已准备的自动身份修复次数，不代表服务端成功次数；手动清理计入 cleanedRequests/cleanedIds。

状态中的 last error 形如 `redacted (prepared)`、`weak (unmatched)` 或 `none (unmatched)`：前者是错误分类，括号内是本次未继续自动恢复的原因（如 budget、no-ids、disabled、scope）。budget 表示当前连续失败链已准备过一次自动修复。该诊断只保留在当前 runtime，不写入会话，也不改变清理行为。

## 上下文管理与分发

Magic Context 先执行投影、标签和缩减，插件再对序列化后的实际请求处理 ID。每次 continuation 重新经过上下文钩子。MC 根据自身配置移除的推理内容以其投影为准。

插件在主 turn 生命周期内捕获请求；多请求交错时采用保守停止。正式支持范围为 Pi 主会话，嵌套/虚拟模型分发需要独立验证。
