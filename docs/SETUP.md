# 搭建与绑定

## 前置条件

- Node.js 20+ 与 npm
- 一个 iLink / 微信 ClawBot 账号（平台侧）
- 一个微信号，用来绑成机器人（扫码授权用）

## 安装与构建

```bash
npm install
npm run build   # tsc，产物在 dist/，入口是 dist/cli.js
```

也可以只做类型检查，不出产物：

```bash
npm run typecheck
```

## 绑定（扫码）

```bash
node dist/cli.js provision
```

按提示用微信扫二维码授权。绑定成功后，平台会返回该微信的地址（`ownerExternalId`），并生成一条绑定记录（`state/bindings.json`）。

注意：

- 一个微信号只能绑一个机器人。想绑第二个机器人，得用**另一个**微信号扫码；用同一个微信号扫会顶掉旧的。
- 刚绑好的机器人不能主动发消息：必须绑定微信先发一条消息建立会话，之后机器人才能回。绑定时自动发的那条介绍，对方大概率收不到，不用管；等对方先发消息时，worker 会先发介绍、再回问题（只发一次）。

## 轮询 hook

让 `hooks/wechat-inbox.sh` 定时跑起来（例如每 8 秒一次），它会：

1. 跑 `poll-all` 取所有机器人的新消息；
2. 有新消息就交给 worker 处理并回复；
3. 没新消息就静默，不打扰。

刚绑好新机器人时，若 hook 收不到消息，先跑一次较长的轮询（例如 30 秒）把游标建好，再恢复正常间隔。

多机器人时，hook 按收到消息的那个机器人发回复，不会串。

## 查看器（viewer/）

查看器的完整源码与重建方法见 `viewer/README.md`。要点：

- 先把机器人跑起来（绑定成功、轮询 hook 在跑、`bindings.json` 与 history 文件已生成），查看器才有东西可看。
- 在自己的 Muse 里新建一个全栈网页构件，名字「微信机器人会话查看」，把 `viewer/` 当参考实现（文件布局、特权函数、四个 action、drizzle 迁移都照着做）。
- 关键配置点只有两处：`viewer/server/src/privileged.ts` 里的 `BINDINGS_PATH` 与 `CONVS_ROOT`（指向绑定文件与历史文件夹；如果你的 Muse 里这两个位置不同，只改这两个常量，不要硬编码真实 bot id）；`viewer/client/src/App.tsx` 的 `POLL_MS`（自动同步间隔，默认 8000 毫秒）。
- 构建与发布由 Muse 的构件工具完成；不要自己跑构建、不要手改产物。

## 状态文件位置

- 绑定信息：`state/bindings.json`
- 会话历史：`~/workspace/wechat-bots/<机器人 id 前 8 位>/convs/<对话哈希>/`
- 媒体：`~/workspace/wechat-bots/<机器人 id 前 8 位>/media/<日期>/`
- 发送记录：`state/sent-log.jsonl`

这些都在 `.gitignore` 里，是本地私有数据，绝不入库。换机器部署时，只拷通用代码与文档，重新扫码绑定即可。
