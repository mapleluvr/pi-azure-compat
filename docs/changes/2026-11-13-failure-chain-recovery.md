# 按成功模型响应切分连续失败链

## 采用的调整

用户在同一个长操作中报告重复的脱敏资源身份错误，并询问为何未再次自动清理。调查之后，用户批准保留连续失败时的熔断，同时在成功模型响应后刷新恢复额度。

恢复上限改为一次运行操作内每条连续失败链一次。刷新依据是与唯一符合条件的主请求对应、已持久化的正常 assistant 响应（stop/toolUse），而不是进入下一 turn、HTTP 200、存在可见文本或准备过一次清理。已确认的拒绝 ID 不随额度刷新撤销。

当前行为声明见 [behavior.md](../state/behavior.md)。

## 原因与证据

初版将每次 settlement 周期一次恢复作为[插件包装时的保守选择](2026-10-26-initial-release.md)；提前到 turn_end 准备恢复时[沿用这一上限](2026-11-02-early-id-recovery.md)。它旨在限制兼容插件自己的补救与 continuation，不是 Azure 协议限制，也不负责密文字段的保留。

实际安装 0.2.0 + Pi 1.5.2 的 loopback 对照中，两条真实脱敏资源错误分别首次出现时都能自动恢复；但“首次修复 → 成功工具响应产生新 rs/msg/fc → 再次资源错误”只有一次准备，第二次显示 redacted (budget)。真实会话在前次自动清理后也有多轮成功工具响应，后来手动 clean 在下一请求消费 25 个 ID 后获得成功响应。

现场未持久化每次 lastSkip 或完整 HTTP payload，因此不把每一次历史跳过均断言为 budget；本次调整修复的是代码及受控实验已经确认的过粗边界。

## 边界与范围

- 单次连续失败仍只有一次本插件自动修复；错误、普通重试与 queued continuation 不重新授予额度。
- 对无法关联的主请求、错误响应身份、多 provider hook 歧义或取消采用保守处理。
- ID 清理仅作用于实际 wire payload 的顶层 item.id，密文、call_id 与原始签名保留。
- 本轮不扩大资源 matcher，不新增 required-reasoning 恢复，不修补此前两项 P2。
- 现有状态格式与手动 clean/on/off/reset 接口保持；准备、请求消费及服务端成功仍是不同阶段。

## 验证与交付

实现版本为 0.2.1；package/lockfile 同步，状态格式保持 v1。测试使用隔离目录、真实 SDK/扩展与 loopback HTTP/SSE，未向真实模型发请求、修改生产会话或 MC 存储。

### 失败先行与保护边界

- 改实现前，SDK 侧 8 个新增正向用例失败：工具成功后再错、三条失败链、正常 stop 后 owner continuation、第二次准备后取消/resume，以及 queued fallback 两种加载顺序。实际 MC 的 4 个进展后再失败组合也失败。
- 原实现下，无取消的独立链路仅 3 请求；queued fallback 虽到第 4 请求，ID 数是 `[3,0,3,3]`。变更后分别到 4 请求、2 次准备，ID 数为 `[3,0,3,0]`。
- 三条链的单 prompt 用例是 `[3,0,3,0,3,0]`，拒绝集合依次加入历史 IDs、tool-1 的新 rs/msg/fc、tool-2 的新 rs/msg/fc；密文、call_id 和 raw signatures 均保留。
- 无间断错误、部分流式输出后失败、响应身份不一致、成功但 store:true、成功 turn 内多 provider hooks，仍保持一次准备的熔断。第二次拒绝边界之前取消不新增准备；边界之后取消保存新 IDs，disk resume 请求清理它们。
- 对三个内存加载器 mutation（不刷新、每个边界都刷新、忽略响应身份）分别捕获 8、8、3 个断言失败；未改写磁盘实现。

### SDK、MC 与真实 pi-retry

- `npm run check`：Pi 1.4.0 + MC 0.49.13，typecheck 与 91/91 测试通过。
- Pi 1.5.2 + 本机 MC 0.49.50，以同一测试入口、默认推理保留配置 10,000 运行，91/91 通过。Pi 1.5.2 + MC 0.49.13 的 12 个 MC 用例也通过。
- MC 用例覆盖两个加载顺序、独立 continuation / queued fallback、两次身份修复、真实 tagging、ctx_reduce 和 ctx-flush 物化，以及后来新 ID 保留。10,000 配置仅覆盖短历史；超预算时 MC 省略 rs 的历史配对问题仍是独立未解决事项。
- 加载完整本机 pi-retry 源码（SHA-256 `ba8e7db9bd245f0fe65e6471d034af67f4c8cd7a05f1999f2c3e74c2176e353c`），Pi 1.4.0 / 1.5.2 各 24 场景通过：三种错误 × 普通/Fast × 两种加载顺序 × 首次失败/成功工具进展后再失败。共 48 场景，扩展错误为零；每个 SDK 的 retry / retry_succeeded 日志各 36 条。
- 新版 SDK/MC 通过 test-only Node resolve hooks 路由到本机包，并为 MC 路由宿主 TUI。MC 启动迁移 worker 会继承 Node execArgv 且测试已切换 cwd，因此 `--import` 使用绝对 file URL；初次相对路径实验在 HTTP 请求前被 MC 因 storage worker 失败中止，修正测试启动方式后通过，没有改生产插件或依赖。

### 真实报错的版本对照

从同一真实会话只读提取两条资源错误及独立 message/required-reasoning 错误的 envelope，配合隔离合成历史在 Pi 1.5.2 重放。两条资源错误首次出现时，开发入口与安装 0.2.0 都是 redacted (prepared)。

| 入口 | 首次错误 → 成功工具响应 → 第二条原始错误 | 拒绝集合 | 最后请求 ID 数 | last error |
| --- | --- | --- | --- | --- |
| 安装 0.2.0（保持未修改） | 3 请求、1 次准备 | 初始 3 IDs | 3 | redacted (budget) |
| 开发 0.2.1 | 4 请求、2 次准备 | 初始 3 IDs + 新 3 IDs | 0 | redacted (prepared) |

独立 required-reasoning 错误在两个入口均为 1 请求、0 修复、none (unmatched)，确认本轮没有改变错误分类范围。此对照证明额度/清理/queued continuation 的实现行为，不声称复现 Azure 服务端的真实密文解密。

### 交付状态

实现提交为 `1c6b17f`。初次交付时是本地 0.2.1、安装仍为 0.2.0；随后用户要求安装并 push，已从远端发布并同步 Git 安装。过程与实际安装入口验证见 [0.2.1 发布记录](2026-11-13-0.2.1-release.md)。运行中的用户会话未被自动重载。

可持续回归入口为 `test/recovery-budget.test.mjs`、`test/retry-interop.test.mjs` 与 `test/magic-context.test.mjs`。本机补充脚本与输出放在未跟踪的 `docs/.temp/`：`verify-failure-chain-full-retry.mjs`、`verify-failure-chain-reported-errors.mjs`、`current-sdk-hooks.mjs` 及 `green-failure-chain-*`；正式结论和边界已在本记录保留。
