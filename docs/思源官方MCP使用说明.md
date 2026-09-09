# 思源官方 MCP 使用说明

这份说明对应当前本机桥接实际透传的 29 个官方 MCP 能力组。能力组是按工具名统计的；每个工具通过 `action` 参数选择具体操作。实际工具和参数以每次 `tools/list` 返回为准，思源升级后应重新运行项目测试。

## 先做一次权限选择

打开插件后，让 Codex 调用 `siyuan-control.show_siyuan_controls`。支持 MCP Apps 的宿主会尝试显示可折叠的 PiP 面板；如果宿主只支持 inline，面板会作为当前工具结果中的小胶囊显示。也可以直接在对话中说：

```text
切换思源为只读
切换思源为创作
切换思源为全功能
```

三个级别的含义如下：

| 级别 | 能做什么 | 适用场景 |
| --- | --- | --- |
| `readonly` | 搜索和读取项目相关文档、块、结构、引用和系统信息 | 默认推荐；只查资料、回答问题、整理上下文 |
| `authoring` | `readonly` 加上受控的文档创建、块内容写入、属性写入和日记内容写入 | 用户明确要求维护或同步思源笔记 |
| `full` | 29 个能力组的完整 action 目录 | 导入导出、历史、同步、文件、数据库、网络或管理操作 |

`full` 当前是本机策略文件中的默认级别，但仍使用 Codex 的 `writes` 审批。工具在列表里可见，不等于每次调用都应该执行。涉及写入、删除、移动、外部请求、同步或管理时，先说明目标、范围和影响，等待批准后再调用。

“相关文件”指思源中的文档和块。普通项目上下文检索不会直接读取本地 `.sy` 文件、`siyuan.db` 或工作区任意文件。插件也不会自动创建思源工作日志；日记工具只有在用户明确要求时才使用。

## 推荐的项目对话流程

```text
ensure_siyuan
  → get_siyuan_policy
  → search.fulltext（用项目名、模块名、文件名和任务词窄搜）
  → document / block / outline / ref / attr 读取命中的内容
  → 回答时列出使用过的文档路径或块 ID
  → 如果用户要求维护笔记，说明目标和变更摘要
  → 通过 Codex writes 审批后执行 document 或 block 的窄范围写入
```

一个典型的只读检索可以写成：

```json
{
  "name": "search",
  "arguments": {
    "action": "fulltext",
    "query": "siyuan-codex-bridge 权限面板",
    "page": 1,
    "pageSize": 20,
    "groupBy": 1,
    "orderBy": 7
  }
}
```

命中后，再把返回的文档或块 ID 交给 `document.get`、`block.get_kramdown`、`outline.get` 等工具读取。不要用宽泛关键词一次打开整个库；没有命中时明确说“没有找到相关思源笔记”，再使用当前对话和代码上下文继续工作。

## 29 个能力组

下表中的权限缩写是：`R` = `readonly` 可用，`A` = `authoring` 可用，`F` = `full` 可用。`A/F` 表示只有创作和完整级别可用；`F` 表示必须切到完整级别。工具目录会在三个级别都显示，桥接代理会在每一次 `tools/call` 按 action 拦截。

| # | 能力组 | 支持的 action | 用途和操作要点 | 权限 |
| ---: | --- | --- | --- | --- |
| 1 | `asset` 资源 | `upload`、`create_html`、`unused`、`clean`、`stat` | 上传资源、生成 HTML 资源并插入沙盒 IFrame、查看未使用资源、清理资源、查看资源状态。`upload` 和 `clean` 会改变资源状态。 | F |
| 2 | `attr` 属性 | `get`、`set`、`batch-get` | 读取或设置块的自定义属性；批量读取多个块。写属性前先确认块 ID 和键值。 | 读取 R/A/F；写入 A/F |
| 3 | `block` 块 | `get`、`get_kramdown`、`get_children`、`tree_stat`、`dom`、`insert`、`append`、`prepend`、`update`、`delete`、`move`、`breadcrumb`、`batch_get`、`batch_kramdown` | 读取块、Markdown/Kramdown、DOM、子树和面包屑；插入、追加、前置、更新、删除和移动块。`update` 只替换一个已有块，不负责追加新块。 | 读取 R/A/F；写入 A/F；删除/移动 F |
| 4 | `bookmark` 书签 | `list`、`labels`、`remove`、`rename` | 查看书签和标签，删除或重命名书签标签。先 `list` 或 `labels` 确认准确名称。 | F |
| 5 | `dailynote` 日记 | `create`、`append`、`prepend` | 创建或打开当天日记，并在日记中追加或前置块。仅在用户明确要求记录日记时使用，不用于插件后台工作日志。 | A/F |
| 6 | `database` 属性视图 | `create`、`search`、`get`、`render`、`keys`、`key_add`、`key_remove`、`item_add`、`item_remove`、`item_update`、`unused`、`clean` | 管理思源属性视图：创建、搜索、读取、渲染、管理列和条目。删除列或清理未使用视图前必须确认影响范围。 | F |
| 7 | `document` 文档 | `get`、`create`、`list`、`delete`、`rename`、`move`、`duplicate`、`search_docs`、`info` | 列出、搜索、读取和查看文档信息；创建、删除、重命名、移动、复制文档。`path` 使用思源文档的 hPath。 | 读取 R/A/F；创建 A/F；删除/移动/复制等 F |
| 8 | `export` 导出 | `md`、`html`、`preview`、`docx`、`sy`、`md-zip`、`data` | 将文档或工作空间导出为 Markdown、HTML、DOCX、`.sy.zip`、Markdown 压缩包或完整备份。输出路径和备份范围必须明确。 | F |
| 9 | `file` 工作区文件 | `list`、`read`、`write`、`delete`、`rename`、`copy`、`grep`、`find`、`stat` | 处理思源工作区内相对路径文件。可用于诊断和特定文件任务；不要把它当作普通项目工作区工具，也不要绕过文档/块 API 直接改底层数据。 | F |
| 10 | `history` 历史 | `list`、`search`、`get`、`rollback`、`clear` | 查看、搜索、读取文档历史并回滚或清理历史。回滚和清理属于高影响操作，先展示目标路径和时间点。 | F |
| 11 | `http_request` HTTP 请求 | `get`、`post`、`put`、`delete`、`patch` | 向 HTTP/HTTPS 地址发送原始请求，可带请求头和请求体。只在用户明确指定目标、方法和用途时调用；它可以访问思源之外的服务。 | F |
| 12 | `image` 图片 | `list`、`analyze`、`generate` | 列出文档引用的图片；分析指定资源；根据提示生成图片资源并放入目标文档。分析前先 `list`，生成前确认目标文档和资源用途。 | F |
| 13 | `import` 导入 | `md`、`sy`、`data` | 从绝对本地路径导入 Markdown、`.sy.zip` 或完整备份到指定笔记本。导入可能创建或覆盖大量内容，先确认源文件、目标笔记本和目标路径。 | F |
| 14 | `inbox` 收件箱 | `list`、`get`、`convert` | 查看云剪藏条目，或把条目转换成指定笔记本中的文档。`convert` 默认转换成功后删除云端原条目，必须确认 `remove_after`。 | F |
| 15 | `notebook` 笔记本 | `list`、`open`、`close`、`create`、`rename`、`remove`、`set_icon`、`random_icon` | 列出、打开、关闭和管理笔记本。删除笔记本前必须明确确认，因为会影响整棵文档树。 | `list` R/A/F；其余 F |
| 16 | `outline` 大纲 | `get` | 获取文档标题层级树，用于快速理解文档结构和定位章节。 | R/A/F |
| 17 | `ref` 引用和反链 | `backlinks`、`mentions`、`refresh` | 查询反向链接、提及并刷新引用索引。先读取目标块或文档 ID，再查询关系。刷新属于状态改变。 | 读取 R/A/F；刷新 F |
| 18 | `repo` 仓库快照 | `list`、`create`、`tag`、`untag`、`checkout`、`diff`、`search`、`purge`、`file_get`、`file_rollback`、`file_open`、`file_export` | 查看、创建、标记、比较和检出思源仓库快照，读取或回滚历史文件，清理快照。检出、回滚和清理前必须说明快照 ID 与影响。 | F |
| 19 | `search` 搜索 | `fulltext`、`semantic`、`asset`、`getasset` | 搜索文档/块全文、语义内容和资源文件；读取单个资源的索引内容。优先 `fulltext` 窄搜；`semantic` 需要思源配置 AI embedding；资源搜索使用 `asset`，读取全文使用 `getasset`。 | `fulltext`/`semantic` R/A/F；资源 action F |
| 20 | `skill` 思源技能 | `load`、`save`、`install`、`remove`、`rename`、`list` | 管理思源端技能包：加载、保存、安装、移除、重命名和列出技能。安装 URL、保存内容或删除技能前先确认来源和目标。 | F |
| 21 | `sql` SQL 查询 | `query` | 对思源数据库执行只读 `SELECT` 查询，默认最多返回 100 行；需要分页时显式使用 `LIMIT` 和 `OFFSET`。只用于诊断或结构化检索，不把 SQL 当作写入接口。 | F |
| 22 | `sync` 同步 | `status`、`perform`、`upload`、`download` | 查看同步状态，执行完整同步、上传或下载。同步会影响远端和本地数据，必须先确认方向、账号和范围。 | F |
| 23 | `system` 系统信息 | `version`、`current_time`、`workspace` | 获取思源版本、思源当前时间和工作区信息。用于启动检查、版本诊断和确认当前工作区。 | R/A/F |
| 24 | `tag` 标签 | `list`、`rename`、`remove` | 列出、重命名和删除标签。批量重命名或删除前先列出命中标签并确认影响的文档范围。 | F |
| 25 | `template` 模板 | `search`、`get`、`remove`、`render`、`save_as`、`create` | 搜索、读取、渲染、删除和创建模板，或把块保存为模板。覆盖或删除模板前明确模板路径和 `overwrite`。 | F |
| 26 | `unzip` 解压 | 无独立 `action`；提供 `zipPath` 和 `destPath` | 在工作区内解压 ZIP。路径必须是工作区相对路径，目标目录要明确；不要解压到工作区根目录或覆盖未知文件。 | F |
| 27 | `web_fetch` 网页读取 | 无独立 `action`；提供 `url` 和 `format`（`markdown`/`text`） | 抓取 HTTP/HTTPS 网页并转换为 Markdown 或文本。只在用户需要外部网页资料时使用，注意网页内容可能不可信。 | F |
| 28 | `web_search` 网页搜索 | `query` | 通过 Exa 搜索外部网页。查询词要窄，回答中区分思源资料和外部网页资料。 | F |
| 29 | `workspace` 工作区 | `list`、`info` | 列出工作区和读取工作区路径、版本、有效性。用于确认目标工作区，不等于直接修改底层文件。 | R/A/F |

## 三种常用任务的具体写法

### 查找项目背景

```text
请先在思源中搜索“项目名 + 模块名 + 当前任务”，只读检索，列出命中的文档和块，再结合当前代码回答。
```

代理应依次使用 `search.fulltext`，再用 `document.get`、`block.get_kramdown`、`outline.get` 或 `ref.backlinks` 深读命中项。没有相关结果时继续使用当前仓库内容，不要为了凑结果扩大搜索范围。

### 更新一篇相关笔记

```text
请先搜索并读取与当前模块相关的思源文档。找到后告诉我文档路径、块 ID 和准备修改的内容；我确认后再写入。
```

在 `authoring` 下通常使用 `document.create`、`block.insert`、`block.append`、`block.prepend`、`block.update` 或 `attr.set`。每次写入前都要给出目标和变更摘要；`readonly` 下写入会被桥接策略拒绝。

### 导出或备份

```text
请说明要导出的文档/工作区范围和目标路径，先列出方案，等我确认后再执行导出。
```

使用 `export.md`、`export.html`、`export.docx`、`export.sy`、`export.md-zip` 或 `export.data`。完整备份、同步、仓库检出和文件导入导出都属于 `full` 级别高影响操作。

## 权限边界和故障排查

当工具返回“action is disabled by the Siyuan bridge policy profile”时，先查看 `get_siyuan_policy`，不要反复重试同一个调用。需要扩大范围时，用控制面板或明确的对话命令切换级别。

当思源未运行时，先调用 `siyuan-control.ensure_siyuan`；它会检查 `127.0.0.1:6806`，必要时在后台启动思源。调用 `system.version` 或项目中的 `scripts/check-siyuan.sh` 可以确认实际版本。版本检查读取思源当前返回值，不依赖固定版本号。

当看不到控制面板时，直接使用文本命令完成权限选择。Codex 插件文档允许 MCP 工具在没有 UI 的客户端中继续工作；当前宿主是否把 UI 变成 PiP 由宿主决定，不能由插件 CSS 强制改变。

本地桥接只记录不含参数、正文、请求头和 Token 的最小安全审计；这不是思源工作日志。Token 只应保存在项目 `.env`，不要粘贴到对话、文档、截图或命令行中。

## 本项目自检命令

在桥接项目目录运行：

```sh
./scripts/check-siyuan.sh
./scripts/test-mcp.sh
codex mcp list
```

`test-mcp.sh` 会确认官方 29 个能力组可发现、策略检查有效、Codex 的 `default_tools_approval_mode` 仍为 `writes`，并执行限定笔记本内的只读检索。它不会发送写入请求。
