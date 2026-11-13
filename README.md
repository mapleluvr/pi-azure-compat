# pi-azure-compat

[![CI](https://github.com/mapleluvr/pi-azure-compat/actions/workflows/ci.yml/badge.svg)](https://github.com/mapleluvr/pi-azure-compat/actions/workflows/ci.yml)

让 [Pi](https://github.com/earendil-works/pi) 在遇到 Azure OpenAI 历史 item 身份错误后，**只清理受影响的历史 item ID，并自动发起一次新请求**。网关把 provider 名脱敏成 `***` 时，只要错误句仍保留 item/resource 身份指纹，也能识别：

```text
The requested item was created under a different Azure OpenAI resource.
The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it.
```

**保留 encrypted_content、工具 call_id 和原始会话签名。** 默认正常请求原样发送；也可用 `/azure-compat clean` 主动清理历史 item ID，不依赖错误文字。

## 安装

需要 **Pi ≥ 1.4.0**、Node.js ≥ 22.19.0。开发测试固定使用 Pi 1.4.0，并对 Pi 1.5.2 做本机集成验证；具体组合见[连续失败链恢复记录](docs/changes/2026-11-13-failure-chain-recovery.md)。

```sh
pi install git:github.com/mapleluvr/pi-azure-compat
```

然后在 Pi 中执行 `/reload`，或启动新会话。首次加载默认开启。

本地开发也可以：

```sh
git clone https://github.com/mapleluvr/pi-azure-compat.git
cd pi-azure-compat
npm ci
pi -e ./src/index.ts
```

迁移时先停用旧的 `strip-replay-ids` 或其他身份错误自动重试插件。**一次只启用一个此类恢复实现**，避免重复续跑或另一个插件同时删除密文。安装本插件本身不会替你改写其他插件配置。

## 工作过程

```text
正常请求（保留历史 ID）
  ↓ 完整 Azure 句，或同时保留 item/resource 与 same-resource 指纹的脱敏句，且尚无输出
turn_end 记录本次实际请求的历史 ID
  ↓ 复用已排队的重试；没有重试时由 agent_before_settle 续跑一次
下一次请求仅清理这些 ID，保留密文和 call_id
  ↓
继续会话；后来新生成的 ID 正常保留
```

失败的原始 assistant entry 和 usage 仍在会话中，只通过 `context_edit` 省略它对后续模型上下文的贡献。恢复状态保存为不进入模型上下文的 custom entry；不会插入隐藏的 user 重试提示。

受影响 ID 按 **provider + API + baseUrl + model** 隔离，随活动分支持久化，支持重载与磁盘 resume。scope 保存的是摘要而不是 URL。**每条连续失败链最多自动修复一次**；正常完成的主模型响应（包括工具调用响应）结束该失败链，刷新额度，但已记录的拒绝 ID 继续清理。同一长操作随后因新 ID 再次出错时，可以再修复；修复后仍连续失败，则停止本插件的自动补救。进入下一 turn、通用重试或部分输出后失败都不会刷新额度。

## 为什么清理全部 ID

错误体不提供可用的单个 item ID（上报错误的 `param` 为空、`code` 为 null），插件也不额外发探测请求。命中后记录失败请求中的全部顶层字符串 ID，下一次请求统一省略；正文、`encrypted_content`、`call_id`、工具配对和原始 entry 都保留。对于内联 Responses 请求，ID 是可选的，因此这种全量抑制可以重放；后来新生成的 ID 正常保留。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/azure-compat` 或 `/azure-compat status` | 开关、当前模型待清理 ID 数、手动清理是否待执行、运行期统计、最近一次错误分类 |
| `/azure-compat clean` | 开启插件，下一次符合条件的请求主动清理当时全部历史 item ID；后续新 ID 保留 |
| `/azure-compat off` | 当前分支停止 ID 清理和自动修复 |
| `/azure-compat on` | 当前分支恢复处理 |
| `/azure-compat reset` | 清除当前模型 scope 的受影响 ID；下一次先原样发送 |

## 脱敏错误

网关把 provider 名脱敏成 `***`、但错误句仍保留 `requested item was created under a different ... resource` 和 `same resource that created the item` 两个指纹时，插件按同一路径自动恢复，不需要手动命令。只有错误被完全脱敏/截断、或只保留前一个指纹时，才先按 Esc 停止重试，执行 `/azure-compat clean`，再重新提交原问题；后者会在当前操作内收到一次提示。命令本身不发请求；它在下一次符合条件的主请求上捕获实际历史 ID，并继续清理这批 ID。可再次执行命令以清理后来新增的历史 ID。

## 手动清理

手动清理按当前模型 scope 隔离，保留密文、正文、MC 标签及工具配对。待执行状态和已捕获的 ID 都随活动分支持久化。`off` 暂停清理，`on` 恢复；`clean` 会主动开启插件。`reset` 同时取消待执行清理并清除当前 scope 已记录的 ID，恢复尝试旧 ID。它的作用与 `clean` 相反。统计在扩展重载后重新计数。

## 适用条件

处理当前选中模型的内联 Responses 历史，API 为 `openai-responses` 或 `azure-openai-responses`，且 payload 的 model 与选中模型 ID 相符。

自动恢复接受的错误文本为：完整 Azure 句；或同时包含 item-created-under-different-resource 子句与 same-resource 说明的脱敏句。`resource group`、quota、limit、provider 等其他资源身份措辞不进入自动恢复。只出现前一个子句时，请求保持原样，并在当前操作内至多提示一次手动清理。

以下情况保留原始错误，由相应流程处理：

- `store:true`、`previous_response_id`、`item_reference` 引用式历史。
- 已产生部分流式输出、确认拒绝前用户取消、请求中已无可清理 ID。
- 密文校验失败、工具配对缺失、普通 item-not-found 或网络错误。
- 较早的 turn_end handler 已接手或移除失败贡献，或当前 turn 的 provider 请求关联出现歧义。
- 错误只保留 item-created-under-different-resource 子句、缺少 same-resource 说明，或完全无法识别。

当前支持 **Pi 主会话**。虚拟模型分发、OMP 和任意后台并发组合需要独立验证。插件没有额外网络请求、遥测或外部存储。

## 与通用自动重试的顺序

本插件在 `turn_end` 先记录拒绝 ID，早于 `agent_end` 的通用重试排队。`pi-retry` 的下一次请求直接应用 ID 清理，无需关闭其普通或 Fast-Retry 模式，也不依赖两个插件的加载顺序。没有排队重试时，本插件才在 `agent_before_settle` 补一次请求。

确认拒绝后取消会停止续跑，已经记录的拒绝 ID 仍跟随活动分支保留。失败 raw entry 也被保留，因此不能仅凭 TUI 显示 Error 判断是否修复；应结合恢复通知、状态与后续实际请求核对。

详见[阻断路径调查](docs/changes/2026-11-02-settlement-retry-interference.md)与[提前准备身份恢复的修复记录](docs/changes/2026-11-02-early-id-recovery.md)。

## Magic Context

实际 **Magic Context 0.49.13 + Pi 1.4.0** 联调覆盖两个加载顺序、独立续跑和通用重试排队、成功工具响应后再次身份错误、错误后的上下文重投影、后续新 ID 保留，以及真实 `ctx_reduce` / `/ctx-flush` 的物化删除。本机另验证 **MC 0.49.50 + Pi 1.5.2**，推理保留配置为默认 10,000；该短历史场景不代表已经覆盖超出预算导致 rs 被省略的问题。

MC 先管理上下文，插件再处理序列化请求中的 ID。保留的是 **MC 投影后仍存在的密文**；MC 自己按配置移除的推理不会由本插件塞回。联调关闭了 historian/dreamer/自动搜索，不能据此宣称所有后台并发均已验证。

## 验证与开发

```sh
npm ci
npm run check
```

使用真实 Pi SDK 和 loopback HTTP/SSE 服务，不需要 API key，也不会访问真实模型。测试包括脱敏匹配、弱指纹提示、状态诊断、请求恢复、停止条件、密文及工具链路保留、分支/磁盘状态、端点隔离、命令和实际 MC 扩展。测试直接使用 Node 的 TypeScript 类型擦除；不需要额外运行时转译器。

此前线上实验支持“指定资源身份错误后，清 ID 即可恢复”，但不证明 **所有 Azure 资源之间密文通用**或完整 CoT 语义恢复。本地合成密文只验证字节保留，不模拟服务端解密。

- [当前行为规格](docs/state/behavior.md)
- [设计来路与验证范围](docs/changes/2026-10-26-initial-release.md)
- [脱敏 resource 错误自动恢复](docs/changes/2026-11-03-redacted-resource-recovery.md)
- [连续失败链恢复额度与验证](docs/changes/2026-11-13-failure-chain-recovery.md)

## License

[MIT](LICENSE)
