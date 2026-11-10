# 架构

## 组件

- **CLI（`src/`，TypeScript / Node.js）**：与 iLink 平台打交道的命令行工具。命令见 `src/cli.ts` 的 `main()`：
  - `provision`：扫码绑定一个微信号，生成绑定信息
  - `status`：看绑定状态（是否连着、最近一次报错）
  - `set-label`：改机器人显示名
  - `send`：给指定微信发消息
  - `sent-log`：看发送记录
  - `poll` / `poll-all`：取新消息（单个机器人 / 全部机器人）
  - `notify-start` / `notify-stop`：通知平台开始 / 停止
  - `download-media`：下载图片 / 语音 / 文件等媒体
- **API 封装（`src/wechat-clawbot-api.ts`）**：iLink 平台接口（取消息、发消息、通知等）的薄封装。
- **绑定流程（`src/wechat-clawbot-provisioner.ts`）**：生成绑定二维码、等扫码、保存绑定信息。
- **本地存取（`src/file-store.ts`）**：绑定信息的读写（`bindings.json`）。报错记录也存在这里。
- **轮询 hook（`hooks/wechat-inbox.sh`）**：每隔几秒跑一次 `poll-all` 取新消息；有新消息就交给 worker（Muse）处理并回复；没新消息就静默。
- **Worker（Muse）**：收到新消息后，读当前对话的历史、回消息、把新消息追加进历史。每次被叫醒都是新的，只靠历史文件记上下文。
- **会话查看器（`viewer/`，Muse 网页 Space，全栈 TypeScript）**：在侧边栏里看对话历史的网页构件。前端 React（`client/`），后端 server actions（`server/src/actions.ts`），读本地文件的特权函数（`server/src/privileged.ts`），数据库迁移（`drizzle/`）。它不自己存聊天记录，每次都实时读 CLI 的 `bindings.json` 与会话历史文件；它自己的数据库只存机器人备注（`bot_remarks`）与每个对话的已读条数（`seen_positions`，只存条数，不存消息内容）。详见 `viewer/README.md`。

## 数据流

```
微信用户发消息
  → iLink 平台（微信 ClawBot）
  → hook 每隔几秒 poll-all 取新消息
  → worker 读当前对话历史 → 回消息 → 追加进历史
  → CLI send → iLink 平台 → 微信用户收到回复
```

## 本地存储（都不入库）

- **绑定信息**：`state/bindings.json`。每个机器人一条，含平台号、token、绑定微信、显示名、游标（`getUpdatesBuf`）、最近报错（`lastError` / `lastErrorAt`）。
- **会话历史**：`state/wechat-convs/<对话哈希>/`，每个绑定微信一个文件夹，内有：
  - `meta.json`：对话清单（编号按创建顺序固定）、当前对话 id、翻页位置
  - `current.jsonl`：当前对话，一行一条（时间、序号、角色、内容）
  - `archive/<对话 id>.jsonl`：归档的旧对话
- **发送记录**：`state/sent-log.jsonl`。
- **介绍待发标记**：`state/wechat-intro-pending.<机器人 id 前 8 位>`，绑定后新建，第一次发消息时用掉即删。

这些都在 `.gitignore` 里，绝不进仓库。

## 多机器人

- 可以同时绑多个机器人（每个机器人绑一个不同的微信号；同一微信号扫码会顶掉旧的）。
- `poll-all` 一轮同时取所有机器人的新消息；回复按收到消息的那个机器人发，各自回各自的，不串。
- 每个绑定微信有自己独立的历史文件夹，互不干扰。

## 查看器架构

```
查看器前端（React，client/src/App.tsx）
  → server actions（server/src/actions.ts）
      getOverview / getMessages / markConversationSeen / setRemark
  → 特权函数（server/src/privileged.ts，读宿主文件）
      listBotsAndConversations / getConversationMessages
      读 ~/workspace/skills/wechat-bot/state/bindings.json
      读 ~/hooks/state/wechat-convs/<sha>/（meta.json + current.jsonl + archive/）
  → 构件自己的数据库（drizzle 迁移，app.db，不入库）
      bot_remarks（机器人备注）、seen_positions（每个对话已读到第几条）
```

- **数据流**：查看器每次打开或每 8 秒轮询时，实时读 `bindings.json` 与历史文件，不花 token、不缓存聊天记录；新绑定的机器人不用改代码，会自动出现（没有硬编码的 bot id）。
- **未读逻辑**：已读位置 = 当前对话消息数 - 未读数；打开对话时定位到第一条未读（上方「以下为新消息」分隔线）；滑到底（或在底部时新消息进来）即把已读位置写进 `seen_positions`，未读清零。只存条数，不存内容。
- **安全**：特权函数把 `bindings.json` 解析成新对象，只返回显示需要的字段；token 与游标（`metadata.getUpdatesBuf`）绝不返回给前端。`privileged.ts` 里 `conversationId` 只从 `meta.json` 里取，拼不出文件夹外的路径；`getConversationMessages` 只认 `bindings.json` 里有的 bot id。
- **构建**：由 Muse 的构件工具完成（不要自己跑 `bun run build`、不要手改 `dist/` 产物）；`node_modules/`、`dist/`、`app.db` 都是构建时生成的，不入库。`server/.generated/privileged.contract.ts` 由构建从 `privileged.ts` 生成，不要手改。

## 报错与自动恢复

- 取数据失败时，`markError` 会把报错记到绑定信息的 `lastError` / `lastErrorAt` 里；状态页与查看器显示「最近有报错」。
- 取数据成功时，`clearError` 会自动把旧的报错记录清掉（没有报错就不写文件，避免每轮都重写）。所以恢复正常后，报错显示自己就变回来了，不用手动清。
- 报错只记最近一次；再报错会重新记一条新的。
