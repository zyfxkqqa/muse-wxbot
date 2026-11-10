#!/bin/sh
# 每个机器人一个包装文件：把 WECHAT_BOT_SEL 换成该机器人 id 的前 8 位。
export WECHAT_BOT_SEL=<机器人id前8位>
exec ~/hooks/scripts/wechat-inbox.sh
