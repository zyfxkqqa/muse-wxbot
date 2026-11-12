# 微信机器人会话查看（viewer）

Muse 的网页构件（Space，全栈 TypeScript）：在侧边栏打开，查看微信机器人的对话历史。

它和 CLI 是一体的：查看器不自己存聊天记录，每次都直接读 CLI 的本地文件——绑定信息与会话历史。所以机器人要先跑起来（有了绑定和历史），查看器才有东西可看。查看器也能在页面里以机器人名义回消息（底部输入框发文字，回形针发图片/视频/语音），还能暂停/恢复自动回复。

## 功能概览

- 三层导航：机器人列表 → 对话列表 → 聊天，每层有返回。
- 每 8 秒自动同步一次（读实时文件，不花 token），另有手动「同步」按钮与上次同步时间。
- 搜索只搜当前打开的对话，高亮、逐条跳转。
- 备注：给机器人起备注名（对话层铅笔按钮；机器人行显示备注）。
- 未读：对话行红色数字角标 +「N 条未读」；机器人行有未读总数角标；点开有未读的对话直接定位第一条未读，上方有「以下为新消息」分隔线，顶部有「N 条新消息」回跳按钮；滑到底（或在底部时新消息进来）即标已读、清零。
- 「当前」徽章是蓝色（与绿色按钮、红色未读区分）。
- 头像不是真照片：白气泡旁深色「Muse」文字块、绿气泡旁绿色「微信」文字块。
- 机器人行显示绑定状态（已绑定 / 最近有报错）与对话数。
- 回消息：对话页底部输入框发文字（最多 2000 字，Enter 发送）；回形针按钮发图片/视频/语音，输入框里的字当配文先发、再发媒体（图片超 250KB 自动压缩到 ≤250KB 再发；视频超 5MB、非 .silk 音频直接拦下）。
- 暂停：按机器人+联系人暂停自动回复（同一机器人跟同一个人的全部对话共用一个暂停标志）；暂停时 worker 只记朋友发来的消息、不回、不执行指令，由用户在页面里手动回；恢复后自动回。暂停状态每 8 秒刷新。

## 它读什么（数据约定）

查看器只依赖下面两处本地文件。路径是约定，不是写死的真实数据：

- 绑定：`~/workspace/skills/wechat-bot/state/bindings.json`（一个数组；每条只取 `id`、`label` / `displayName`、`platformBotId`、`ownerExternalId`、`createdAt`、`metadata.lastError`）。token 与游标（`metadata.getUpdatesBuf`）绝不返回给前端。
- 会话历史：`~/workspace/wechat-bots/<botId 前 8 位>/convs/<sha>/`，其中 `sha` = `sha256("<botId>:<ownerExternalId>")` 的前 16 位十六进制字符。每个文件夹内有：
  - `meta.json`：对话清单（编号按创建顺序固定）、`current_id`、翻页位置
  - `current.jsonl`：当前对话，一行一条（`ts`、`seq`、`role`、`text`）
  - `archive/<对话 id>.jsonl`：归档的旧对话

构件自己的数据库只存两样（存在构件的 `app.db` 里，由 drizzle 迁移生成，**不入库**）：

- `bot_remarks`：机器人备注（`bot_id` → `remark`）。
- `seen_positions`：每个对话看到第几条（`bot_id` + `conversation_id` → `seen_count`，只存条数，不存消息内容）。

表结构就是 `drizzle/` 里的迁移：0001 建 `entries`（占位表，后续被替换）、0002 删 `entries` 建 `bot_remarks`、0003 建 `seen_positions`。不需要、也不要往仓库里放真实的 `app.db`。

## 文件结构

```
viewer/
├── README.md               # 本文件：查看器说明与重建方法
├── AGENTS.md               # 构件目录的维护规则（只走构件工具构建，不手改产物）
├── space.json              # 构件元数据（runtime、slug、入口）
├── package.json            # 依赖与脚本（bun + React + drizzle）
├── bun.lock                # 依赖锁定（可复现安装）
├── bunfig.toml             # bun 安装配置（独立缓存目录）
├── tsconfig.base.json      # 共享的 TypeScript 配置
├── client/                 # 前端（React）
│   ├── index.html
│   ├── build.mjs           # 客户端打包入口（调用 SDK 的 buildClient）
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx         # 全部界面：三层导航、聊天、搜索、未读、备注
│       ├── main.tsx        # 入口（QueryClientProvider 包裹）
│       ├── api.ts          # 类型化 RPC 客户端（类型来自 server/src/actions.ts）
│       ├── theme.css       # 主题色（微信绿、当前蓝、未读红、气泡色）
│       └── globals.d.ts
├── server/                 # 后端（server actions + 特权函数）
│   ├── tsconfig.json
│   ├── src/
│   │   ├── actions.ts      # 九个 action：getOverview / getMessages / getMediaFile /
│   │   │                   # markConversationSeen / setRemark / sendMessage /
│   │   │                   # sendMedia / setPaused / getPaused
│   │   ├── schema.ts       # drizzle 表定义（bot_remarks、seen_positions）
│   │   └── privileged.ts   # 读 bindings.json 与 history 文件的特权函数
│   └── .generated/
│       └── privileged.contract.ts  # 由构建从 privileged.ts 生成的契约，不要手改
└── drizzle/                # 数据库迁移（按顺序执行）
    ├── 0001_initial.sql
    ├── 0002_replace_entries_with_bot_remarks.sql
    ├── 0003_add_seen_positions_for_unread_tracking.sql
    └── meta/_journal.json  # 迁移顺序记录
```

不包含的东西（构建时生成，不要从仓库里拷）：`node_modules/`、`client/dist/`、`server/dist/`、`.tsbuildinfo`、`app.db`、`.bun-cache/`、构建产物目录。

## 在自己的 Muse 里重建

别人拿到这个仓库后，按下面步骤能在自己的 Muse 里做出同样的查看器。

### 前置条件

1. 先把机器人跑起来：按 `docs/SETUP.md` 扫码绑定、跑起轮询 hook，确认 `bindings.json` 与 history 文件已经生成（查看器没有这些文件就什么都不显示）。
2. 自己的 Muse 支持全栈网页构件（Space）。

### 步骤

1. 把下面这段话原样发给你的 Muse，让它新建构件：

   > 请帮我建一个网页构件（全栈），名字叫「微信机器人会话查看」，放在侧边栏。它用来查看我微信机器人的对话历史：数据全部读本地文件——绑定信息在 `~/workspace/skills/wechat-bot/state/bindings.json`，对话历史在 `~/workspace/wechat-bots/<botId 前 8 位>/convs/<sha>/`（`sha` 是 `sha256(机器人 id:绑定微信地址)` 前 16 位），不要把聊天记录拷进构件自己的数据库。界面三层：机器人列表 → 对话列表 → 聊天；每 8 秒自动同步一次，另有手动同步按钮；搜索只搜当前打开的对话；能给机器人加备注；有未读角标，点开对话定位到第一条未读，上方显示「以下为新消息」分隔线；滑到底标为已读。头像不用真照片，用文字色块区分两边。参考实现在 `muse-wxbot/viewer/`，按里面的文件布局和数据约定做。

2. 把 `viewer/` 交给你的 Muse 当参考实现：重点是这几处——
   - `server/src/privileged.ts`：两个特权函数 `listBotsAndConversations` 与 `getConversationMessages`，以及 `BINDINGS_PATH` 与 `CONVS_ROOT` 两个路径常量；
   - `server/src/actions.ts`：九个 action（`getOverview` / `getMessages` / `getMediaFile` / `markConversationSeen` / `setRemark` / `sendMessage` / `sendMedia` / `setPaused` / `getPaused`）；
   - `server/src/schema.ts` 与 `drizzle/0001–0003`：构件自己数据库的两张表；
   - `client/src/App.tsx`：全部界面与未读定位逻辑（轮询间隔 `POLL_MS` = 8000 毫秒）。

3. 关键配置点：
   - `privileged.ts` 里的 `BINDINGS_PATH` 与 `CONVS_ROOT` 指向上面「它读什么」里的两个位置。如果你的 Muse 里技能目录或 hook 状态目录位置不同，只改这两个常量，不要硬编码任何真实 bot id。
   - 轮询间隔 8 秒（`client/src/App.tsx` 的 `POLL_MS`）。改这个数字就改自动同步的频率。
   - 打开对话时，「已读位置」按「当前对话消息数 - 未读数」算；未读位置只存条数，不存内容。
   - 迁移按 `drizzle/0001` → `0002` → `0003` 的顺序执行；`drizzle/meta/_journal.json` 记录这个顺序。
   - `server/.generated/privileged.contract.ts` 由构建从 `privileged.ts` 生成，不要手改；换了 privileged 函数后重新构建即会更新。

4. 构建与发布由 Muse 的构件工具完成：不要自己跑 `bun run build`、不要手改 `dist/` 产物；`node_modules/`、`dist/`、`app.db` 都是构建时生成的。

### 自查清单（建完对照）

- 机器人列表能显示已绑定的机器人（备注、状态、对话数、未读总数）。
- 点进一个对话能看到全部历史消息，时间分隔正常。
- 搜索只搜当前对话，高亮、能逐条跳。
- 给机器人改备注后，刷新还在。
- 有未读时点开对话会定位到第一条未读；滑到底后未读清零。
- 新绑定的机器人不用改代码，会自动出现在列表里（因为每次都实时读 `bindings.json`，没有硬编码的 bot id）。

## 安全说明

- 仓库里没有任何凭证、私人数据、真实对话内容。`bindings.json`、history 文件、`app.db`、`sent-log` 一律不入库（见根目录 `.gitignore`）。
- 查看器读绑定与历史时只返回显示需要的字段；token、游标不会出现在前端。
- 本文件与代码里出现的所有 id、地址、路径都是占位符或通用约定（如 `<BOT_ID>`、`<WECHAT_ID>`、`<CONV_SHA>`），按自己环境替换，不要填真实值。
