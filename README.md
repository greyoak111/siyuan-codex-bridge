# Codex ↔ SiYuan 官方 MCP 桥接

这个本地桥接把 Codex Desktop、Codex CLI 和 IDE 连接到思源笔记内置的官方 MCP。STDIO 代理只把 MCP 请求转发到 `http://127.0.0.1:6806/mcp`，并在请求头中补充 API Token；它不解析或改写 `.sy` 文件，也不直接操作 `siyuan.db`。

## 唯一需要手工填写的值

编辑 [`.env`](/Users/sunxifeng/siyuan-codex-bridge/.env)，只填写 `SIYUAN_API_TOKEN` 的值。`SIYUAN_API_URL` 和 `SIYUAN_MCP_URL` 保持默认值。`.env` 必须是权限 600；Token 不应出现在 git、README、对话、审计日志、截图、命令行参数或普通配置中。

## 能力和操作级别

思源官方 MCP 的完整工具目录会透传给 Codex。具体版本和工具数量以每次本机端点探测为准；官方端点通常返回按 `action` 选择读取、写入、管理、导入导出、同步或网络动作的聚合工具。

本地代理按每一次 `tools/call` 读取 [操作策略文件](/Users/sunxifeng/siyuan-codex-bridge/config/siyuan-policy.json)，支持三个级别：

- `readonly`：搜索、读取文档和块、文档树、大纲、反链、属性、笔记本列表、系统和工作区信息。
- `authoring`：在 `readonly` 基础上允许创建文档、插入/追加/前置/更新块、设置属性和创建或追加日记；删除、移动、重命名、复制、文件、数据库管理、SQL、网络、导入导出、同步和仓库操作仍拒绝。
- `full`：官方 MCP 当前公布的全部工具和 action 都可以转发。Codex 配置仍使用 `default_tools_approval_mode = "writes"`；代理会保留这个批准设置，并在每次调用前执行策略检查。SiYuan 3.8.3 把多个 action 聚合在同一个 MCP 工具里且没有 action 级 annotations，因此不能把“每个 action 必然弹出单独提示”当作安全边界，代理策略才是硬边界。

当前策略文件默认是 `full`，因为用户已经选择开放完整官方能力。策略文件只包含级别，不包含 Token，权限为 600。即使处于 `full`，普通创作请求也只应调用读取动作；需要修改或外部操作时先说明目标，再让 Codex 执行批准流程。

## 在插件页管理级别

个人插件源目录是 [`~/plugins/siyuan-notes`](/Users/sunxifeng/plugins/siyuan-notes)。插件页会显示这些技能和一个轻量控制工具：

- `$siyuan`：创作前检索思源并引用相关文档或块。
- `$siyuan-readonly`：切换并保持只读级别。
- `$siyuan-authoring`：切换到受控创作级别，允许内容写入。
- `$siyuan-full`：切换到完整官方工具级别。
- `$siyuan-policy`：查看当前级别和可用级别。

`siyuan-control.show_siyuan_controls` 会显示可折叠的范围面板；它会在宿主支持时请求 PiP（通常由宿主放在右下），不支持时回退为对话内卡片。面板只负责选择本地权限范围，不写入思源工作日志。

也可以直接在对话中说“查看思源操作级别”“切换思源为只读”“切换思源为创作”“切换思源为全功能”。这些技能调用插件自带的 `siyuan-control` 控制 MCP；代理本身仍会在每个 MCP 请求上重新检查策略，所以技能提示不是唯一安全边界。

插件规范的设置页能力取决于宿主，因此权限选择由技能和控制 MCP 共同完成；面板不可用时仍可用对话命令完成同一流程，不改变官方 MCP 或笔记数据格式。打开并选定范围后，相关项目对话会按当前范围先检索思源文档/块，再决定是否提出或执行受控调整；纯无关问题不会强制查询。

## 启动、重启和关闭

插件提供 `ensure_siyuan`、`start_siyuan`、`status_siyuan`。创作或检索开始前会检查 `127.0.0.1:6806`，思源未运行时通过 macOS 后台方式启动 `/Applications/SiYuan.app`。不需要每次手工开终端。

手工检查：

```sh
cd ~/siyuan-codex-bridge
./scripts/check-siyuan.sh
./scripts/test-mcp.sh
codex mcp list
```

`check-siyuan.sh` 每次都会请求 `/api/system/version`，动态显示思源实际返回的版本，并校验响应中存在可用的非空版本值；它不锁定某个最低或目标版本，因此升级思源不会因为版本号变化而被误报为失败。升级后仍应重新运行 `tools/list` 和 `test-mcp.sh`，确认官方工具目录与桥接行为没有变化。

切换操作级别后策略会在下一次官方 MCP 调用生效。若 Codex 客户端缓存了旧的工具目录，重启当前 Codex/IDE 会话或新建会话即可；无需重启思源，也不需要把 Token 再填一遍。

如果 macOS 暂时拦截当前 ChatGPT.app 内置的 `codex` 可执行文件，退出并重新打开 ChatGPT，让官方 Sparkle 更新完成后再运行上面的命令；这与思源桥接或 Token 无关。

在 Codex 中关闭连接：把 `siyuan` MCP 服务器设为 disabled，或在 [`~/.codex/config.toml`](/Users/sunxifeng/.codex/config.toml) 中将对应的 `enabled` 改为 `false`。这只关闭 Codex 连接，不会退出思源。

如果确实要退出思源，可以在终端运行：

```sh
/usr/bin/osascript -e 'tell application "SiYuan" to quit'
```

插件默认只负责启动和检查，不会在任务结束时强制关闭思源。

## 配置备份和恢复

每次修改全局 Codex 配置前先创建带时间戳的备份，例如 `~/.codex/config.toml.bak.siyuan-YYYYmmdd-HHMMSS`。恢复时先退出 Codex，再选择实际存在的备份文件：

本次配置前的原始备份是 [`~/.codex/config.toml.bak.siyuan-20260906-235232`](/Users/sunxifeng/.codex/config.toml.bak.siyuan-20260906-235232)。

```sh
cp ~/.codex/config.toml.bak.siyuan-20260906-235232 ~/.codex/config.toml
chmod 600 ~/.codex/config.toml
```

恢复后重新启动 Codex Desktop、CLI 或 IDE 会话。

## 审计和高风险能力

代理把允许或拒绝的操作写入 [`audit/operations.jsonl`](/Users/sunxifeng/siyuan-codex-bridge/audit/operations.jsonl)。这是最小的本地安全审计，不是写入思源的工作日志；每行只记录时间、级别、工具、action 和决策，不记录参数、笔记正文、响应、请求头或 Token；日志权限为 600。

官方 MCP 中的文件读写、导入导出、历史回滚、仓库检出、同步、任意 HTTP、网页访问、解压和 SQL 都属于高影响能力。`full` 会让它们可用；执行前仍应明确目标并让客户端按 `writes` 配置处理，同时由本地代理执行 action 级策略检查。不要把官方 HTTP 端点直接添加到另一个会自动放行写操作的客户端，否则会绕过本地策略代理。

按当前选择，`full` 下没有工具组被禁用；切换到 `readonly` 或 `authoring` 后，上述高影响动作以及删除、重命名、复制、批量移动和系统管理动作会由代理拒绝。这个边界按每次 `tools/call` 检查，而不是只依赖插件提示词。

思源端口保持绑定在 `127.0.0.1`，不会暴露到局域网或公网。升级 SiYuan 后请重新运行 `tools/list` 和测试，因为官方工具目录可能随版本变化。
