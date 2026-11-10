# muse-wxbot（自用演进版）

让 Muse 通过腾讯官方 iLink ClawBot 平台收发微信消息的工具集：扫码绑定的命令行工具、定时轮询的收件钩子、把对话历史存在本地文件里的干活规程，外加一个只读的网页查看器。**本仓库不包含任何凭证与私人数据**：没有 bot token、没有绑定文件、没有真实聊天记录。

本版本在公开包的基础上演进了三处（均为自用环境里实测在跑的版本）：

1. **轮询脚本增强版**（`hooks/wechat-inbox.sh`）：媒体改为唤醒 worker 时再下载（6 次重试，扛微信 CDN 延迟就绪），带超时重入队与死信处理、轮询连续失败计数与诊断唤醒；公开包里的同名脚本是较早的版本。
2. **命令行报错自动清除**：`poll` / `poll-all` 取消息成功后自动清掉绑定上留存的旧报错（`metadata.lastError`），避免过期报错长期挂在状态里。
3. **附带 worker 干活规程**（`hooks/worker-prompt.md`，脱密版）：对话上下文读写本地历史文件、微信内对话指令（帮助 / 新建对话 / 切换对话 / 切换到编号 / 修改旁聊名称）、回复与记录规则，全文都在里面；公开包未附此文件。

## 组成

- `src/`：CLI（TypeScript / Node.js）。扫码绑定、状态、发消息、取消息等命令，入口 `src/cli.ts`。
- `hooks/wechat-inbox.sh`：轮询脚本，定时跑，取到新消息就唤醒 worker 处理并回复；没消息时静默退出。
- `hooks/wechat-inbox-wrapper.example.sh`：多机器人时每个机器人一个的包装文件示例。
- `hooks/worker-prompt.md`：worker 的干活规程（脱密版，占位符部署时替换）。
- `viewer/`：网页查看器（全栈 Space 参考实现），只读本地数据文件看全部历史对话，支持搜索、未读提醒、每 8 秒自动同步。
- `docs/`：`SETUP.md` 部署、`USAGE.md` 使用、`ARCHITECTURE.md` 数据约定。

## 数据约定（要点）

- 绑定信息：`~/workspace/skills/wechat-bot/state/bindings.json`（含 token，**永不入库、永不外传**）。
- 对话历史：`~/hooks/state/wechat-convs/<哈希>/`，哈希 = `sha256("<机器人 id>:<绑定微信地址>")` 前 16 位；`meta.json` 管对话清单，`current.jsonl` 是当前对话（一行一条），`archive/<id>.jsonl` 是归档对话。
- 查看器只读上面两处文件；它自己的库只存机器人备注和每段对话的已读条数，不存消息内容。token 与消息游标绝不下发前端。

详细说明见 `docs/`。
