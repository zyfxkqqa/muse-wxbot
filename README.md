# muse-wxbot

Muse 的微信机器人：通过微信与 Muse（个人 AI 助理）聊天。

基于腾讯 iLink 微信 ClawBot 平台。机器人绑定后，微信里发来的消息会被 Muse 回复；对话记录存在本地文件里，换对话、切回旧对话都能接着聊。

## 功能

- 扫码绑定：用微信扫码，把一个微信号绑成机器人。一个微信号只能绑一个机器人；想绑第二个，得用另一个微信号扫。
- 收发消息：文字、图片、语音、视频、文件都能收能回。语音有转写，图片能看。
- 记上下文：每个对话的历史存在本地文件里，机器人按当前对话接着聊；新建对话就是真的清掉上下文，旧对话归档留着，能切回去。
- 对话管理：发一条单独的指令就能操作（见 `docs/USAGE.md`）。
  - 帮助：看指令清单
  - 新建对话：归档当前对话、开一个空的新对话
  - 切换对话：看对话清单、翻页、切换到指定对话
  - 修改旁聊名称：给对话改名
- 多机器人：可以同时绑多个机器人，各自回各自的消息，不串。
- 绑定介绍：绑定成功后程序留一个待发标记；对方第一次发消息时，worker 先发一段固定介绍、再回复，只发一次。
- 报错自动恢复：取数据失败会记一条报错；恢复正常后，下一轮取数据成功就自动把报错清掉，状态自己变回来。
- 会话查看器：网页构件（`viewer/`，见下），读同一份历史文件：选机器人 → 选对话 → 看全部历史，带搜索、备注、未读数与「从新消息开始看」。只看不回消息。

## 结构

```
muse-wxbot/
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
├── src/                # CLI（TypeScript，Node.js）
│   ├── cli.ts          # 命令入口：provision / status / send / poll / poll-all 等
│   ├── wechat-clawbot-api.ts      # iLink 平台 API 封装
│   ├── wechat-clawbot-provisioner.ts  # 扫码绑定流程
│   ├── file-store.ts   # 绑定信息本地存取
│   ├── types.ts        # 类型定义
│   └── index.ts
├── hooks/
│   ├── wechat-inbox.sh # 轮询 hook：定时取新消息、交给 worker 回复
│   ├── wechat-inbox-wrapper.example.sh # 多机器人时，每个机器人一个的包装文件示例
│   └── worker-prompt.md # worker 干活规程：上下文读写、对话指令与回复规则
├── viewer/             # 会话查看器构件（Muse 网页 Space，全栈 TypeScript）
│   ├── README.md       # 查看器说明与在自己 Muse 里重建的方法
│   ├── client/         # 前端（React）：三层导航、聊天、搜索、未读、备注
│   ├── server/         # 后端：读 bindings.json 与 history 文件的特权函数 + 4 个 action
│   └── drizzle/        # 构件自己数据库的迁移（只存备注与已读条数，不存消息内容）
└── docs/
    ├── ARCHITECTURE.md # 架构与数据流
    ├── SETUP.md        # 搭建与绑定
    └── USAGE.md        # 使用与对话指令
```

## 快速开始

见 [docs/SETUP.md](docs/SETUP.md)。

## 会话查看器（viewer/）

另有一个网页查看器，和 CLI 是一体的：它不自己存聊天记录，每次都直接读 CLI 的本地文件（`bindings.json` 与会话历史），在侧边栏里看全部历史。

- 位置：`viewer/`（完整源码 + 重建指南见 [viewer/README.md](viewer/README.md)）。
- 界面：机器人列表 → 对话列表 → 聊天；每 8 秒自动同步一次，另有手动同步按钮；搜索只搜当前打开的对话；能给机器人加备注；有未读角标，点开对话定位到第一条未读。
- 在自己的 Muse 里重建：按 `viewer/README.md` 里的步骤做（先把机器人跑起来，再让 Muse 新建一个全栈网页构件，把 `viewer/` 当参考实现）。
- 只看不回消息；查看器自己的数据库只存备注与已读条数，不存消息内容；`app.db` 不入库。

## 构建

```bash
npm install
npm run build   # tsc，产物在 dist/
```

## 安全说明

- 仓库里只有通用代码与文档，**没有任何凭证与私人数据**。
- 绑定凭证（token）、发送记录、会话历史都存在本地 `state/`（与历史文件夹）里，已在 `.gitignore` 中排除，绝不入库。
- 不要把 `state/`、绑定文件、会话历史发给别人或传到公开位置。
