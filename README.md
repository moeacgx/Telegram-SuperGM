# Telegram-SuperGM
## TG 双向机器人超级群组 Cloudflare Worker 版

一个部署在 **Cloudflare Workers** 上的 Telegram 机器人中间层，实现“**私聊 ↔ 超级群话题**”的隔离转发，适合客服、中介、工单等场景。

```text
用户私聊  ──▶ Bot / Worker ──▶ 用户专属话题（Supergroup Topic）
    ▲                               │
    └─────────────◀─────────────────┘
           话题回复回流到用户私聊
```

## ✨ 项目亮点

- 🛡️ **数字验证**：新用户先在 Telegram 私聊中回答一道简单算术题，降低机器人骚扰和滥用风险。
- 💬 **独立话题沟通**：每个用户都在独立的 Telegram 话题（Forum）中对话，历史清晰、管理不串线。
- ⚫️ **随时拉黑用户**：若不想再接收某个用户的消息，直接在群内关闭对应话题，即可拦截 TA 的所有后续消息。（市面上的bot几乎都没有一键屏蔽用户消息的功能）
- 🖼️ **多媒体支持**：支持图片、视频、文件等消息类型的转发；文本消息支持 Telegram Markdown 格式。
- ⚡ **无需自建服务器**：基于 Cloudflare Worker，按量计费，省心托管，轻松应对大量消息。（实际上随便咋用都不会超过免费额度~）

---

## 项目结构

- `woker.js`：Cloudflare Worker 入口，处理 Telegram Webhook、读写 KV、调用 Bot API。
- `README.md`：项目说明文档（当前文件）。

### 相关频道 / 群

- 新站长仓库：<https://t.me/zhanzhangck>
- 站长群：<https://t.me/vpsbbq>

---

## KV 设置说明

本项目使用 Cloudflare KV 记录“用户 ↔ 话题”映射关系。

你只需要：

1. 在 Cloudflare Dashboard 创建一个 KV 命名空间（名称随意，例如 `tg-topic-map`）。
2. 在 Worker 的 **Settings → KV Namespace Bindings** 中绑定该命名空间，绑定名（Variable name）填：`TOPIC_MAP`。

所有实际的 key/value（例如：
- `user:<uid>` → `{ thread_id, title, closed }`
- `verified:<uid>` / `challenge:<uid>` 等
）都会由程序自动写入，无需手动创建。

---

## 环境变量（Settings → Variables）

在 Worker 的 **Settings → Variables** 中添加以下变量：

| 变量名              | 必须 | 说明 / 示例                                                                 |
|---------------------|------|------------------------------------------------------------------------------|
| `BOT_TOKEN`         | 是   | Telegram Bot Token。例如：`123456789:xxxx`                                  |
| `BOT_ID`            | 是   | 机器人自身 user id，就是 Bot Token 冒号前面的数字，例如 `123456789`        |
| `SUPERGROUP_ID`     | 是   | 目标超级群 chat id，形如 `-100xxxxxxxxxx`                                  |
| `API_BASE`          | 否   | 默认 `https://api.telegram.org`                                             |

> 获取 `SUPERGROUP_ID` 小技巧：
> - 在 Telegram 桌面端右键群内任意消息，复制消息链接；
> - 链接里会有一段 `-100xxxxxxxxxx` 或 `xxxxxxxxxx`；
> - 若只看到纯数字 `xxxxxxxxxx`，在前面加上 `-100`，就是完整的 `SUPERGROUP_ID`（私密频道/群组同理）。

---

## 部署指南（Dashboard）

### 1. Telegram 侧

1. 在 **@BotFather** 创建机器人，记录 `BOT_TOKEN`。
2. 使用 `/setprivacy` 关闭隐私模式（选择 `Disable`），保证能收到群内消息。
3. 将 bot 拉入目标超级群：
   - 群内启用话题（Topics）功能；
   - 给 bot 授权“发消息、管理话题”等权限。
4. 通过复制消息链接或其它方式获取该群的 `chat_id`，配置为 `SUPERGROUP_ID`（格式为 `-100xxxxxxxxxx`）。

### 2. Cloudflare 侧

1. 创建 KV 命名空间，并在 Worker 中绑定为 `TOPIC_MAP`（见上文 KV 设置）。
2. 新建 Worker（Modules 模式），将 `woker.js` 代码粘贴进去。
3. 在 Settings → Variables 中配置上文列出的环境变量。
4. 如需自定义域名，为 Worker 添加路由，例如 `https://tgbot.xxxx.com/*`。

### 3. 启用 Webhook（非常关键）

Telegram 通过 Webhook 推送消息到你的 Worker：

- 首次部署、换域名、换路径时，一定要重新 `setWebhook`；
- 仅修改代码、域名不变时可以不用重新设置。

示例：使用默认 `*.workers.dev` 域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxx.workers.dev"
```

示例：使用自定义域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxxx.com"
```

执行后可通过 `getWebhookInfo` 确认 `url` 是否已是最新地址。

### 4. 功能验证

1. 自己先私聊 bot，会先收到一道算术题；直接回复答案数字，答对后再继续。
2. 再发一条普通消息：
   - 超级群应自动创建一个以你昵称/`@username` 命名的话题；
   - 私聊消息会带引用转发到该话题中。
3. 在该话题中回复：
   - bot 会把消息复制回你的私聊，不带“转发自”标记。
4. 在话题菜单中关闭话题后，再次发消息应只收到“话题已关闭”的提示，不再推送到群；重新开启话题后又会恢复转发。

---

## 调试与日志

建议使用 `wrangler` 实时查看 Worker 日志：

```bash
npm install -g wrangler
wrangler login
wrangler tail <Worker名>   # 例如 wrangler tail tgbot
```

如果需要查看完整的 Telegram `update`，可以在 `fetch` 或处理函数中临时加上：

```js
console.log(JSON.stringify(update, null, 2));
```

再通过 `wrangler tail` 观察输出。

---

## 常见问题（FAQ）

1. `getWebhookInfo` 报 `Wrong response from the webhook: 404 Not Found`？  
   - 多数是 Webhook URL 写错，或 Worker 仍然是默认模板 `return fetch(request)`；
   - 请确认 URL 与实际 Worker 域名/路径一致，并已替换为本项目的 `woker.js`。

2. `wrangler tail` 看不到任何日志？  
   - 本地先手动打一个 POST：
     ```bash
     curl -X POST "https://tgbot.xxx.workers.dev" -H "content-type: application/json" -d "{}"
     ```
   - 若仍看不到调用，说明请求未命中 Worker：检查域名是否正确、是否成功 Deploy、Workers 路由是否配置。

3. 关闭话题后仍有消息推送进来？  
   - 确认 bot 账户在群里能看到 `forum_topic_closed` / `forum_topic_reopened` 事件（`wrangler tail` 中应有对应字段）；
   - 如果是直接删除话题（而不是关闭），Worker 会认为线程不存在并为该用户创建新的话题，这是当前的默认行为。

---

## 更新记录

- **2025-11-25**：修复用户端一次发送多媒体（相册消息）时会卡住、需等待后续消息才能一并推送的问题，新增 `ctx.waitUntil` 异步 flush，确保 2 秒超时即可自动发送;

- **2026-08-26**：验证改为 Telegram 内直接回答随机算术题，不再依赖网页或 Cloudflare Turnstile；题目记录保存 15 分钟，答对后才允许转发消息。


---

## 安全提示

- **不要泄露 Bot Token**。若不慎泄露，请立即在 @BotFather 中执行 `/revoke` 并更新 Worker 的 `BOT_TOKEN`。
- KV 中仅存“用户 id ↔ 话题 id / 状态”等元数据，不存聊天内容；聊天记录由 Telegram 自身保存。
