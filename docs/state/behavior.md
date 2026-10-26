# 行为与接口

## 请求与恢复

插件默认开启，服务于 Pi 1.4.0 及以上版本的主会话 Responses 请求。适用请求使用 openai-responses 或 azure-openai-responses API、内联 input、当前选中模型，store 为 false 或未指定，历史以完整内容回放。

首次请求正常保留服务端 item ID。仅当空内容 assistant error 包含完整错误句 `The requested item was created under a different Azure OpenAI resource` 时，插件记录该次实际请求中的 ID，省略失败 entry 的未来上下文贡献，并请求一次新的模型调用。

新请求仅清理这批受影响的顶层字符串 ID，保留 encrypted_content、call_id、正文、摘要和其他字段。后续请求继续对这些历史 ID 应用清理；新生成的 ID 正常保留。每次用户操作至最终 settlement 最多发起一次身份修复 continuation。

引用式历史（store:true、previous_response_id、item_reference）、部分流式输出、取消、空 ID 集合、已被其他恢复流程接手、单 turn 中出现多个 provider 请求的歧义场景，均按原始错误交还调用方。密文校验、工具配对和普通网络错误由其各自处理路径负责。

## 状态

状态作为 custom entries 存入活动分支，按 provider/API/baseUrl/model 的 SHA-256 scope 区分。保存受影响 ID 及开关/reset 操作；上下文压缩、重载和磁盘 resume 后从活动分支读取。原始会话消息、签名和 MC 标签保持原有内容。

失败消息保留 raw entry 和 usage，其 future-context contribution 通过 context_edit 置空。custom 状态 entries 不进入模型上下文。

## 命令

- `/azure-compat`、`/azure-compat status`：当前开关、当前模型受影响 ID 数及运行期统计。
- `/azure-compat off`：当前分支停止清理与自动身份修复。
- `/azure-compat on`：当前分支恢复处理。
- `/azure-compat reset`：清除当前模型 scope 的受影响 ID 记录；下一次对这批身份原样发送。

开关和 reset 跟随活动分支持久化。计数仅表示本次扩展 runtime 的操作，重载后重新计数。

## 上下文管理与分发

Magic Context 先执行投影、标签和缩减，插件再对序列化后的实际请求处理 ID。每次 continuation 重新经过上下文钩子。MC 根据自身配置移除的推理内容以其投影为准。

插件在主 turn 生命周期内捕获请求；多请求交错时采用保守停止。正式支持范围为 Pi 主会话，嵌套/虚拟模型分发需要独立验证。
