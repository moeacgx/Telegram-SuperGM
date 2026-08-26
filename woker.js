// Cloudflare Worker 入口（Telegram 答题验证 + 相册聚合：最多 10 张，2 秒超时 flush）
export default {
  async fetch(request, env, ctx) {
    try {
    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 先尝试 flush 超时的媒体组（>2 秒未追加）
    await flushExpiredMediaGroups(env, Date.now());

    if (msg.chat && msg.chat.type === "private") {
      await handlePrivateMessage(msg, env, ctx);
      return new Response("OK");
    }

    const supergroupId = Number(env.SUPERGROUP_ID);
    if (msg.chat && Number(msg.chat.id) === supergroupId) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await markThreadClosed(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await markThreadReopened(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.message_thread_id) {
        await handleTopicMessage(msg, env, ctx);
        return new Response("OK");
      }
    }

    return new Response("OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("worker-request-failed", { message });
      try {
        await env.TOPIC_MAP.put(
          "diag:last_error",
          JSON.stringify({ message, timestamp: new Date().toISOString() }),
          { expirationTtl: 3600 },
        );
      } catch {}
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

// 私聊 -> 话题
async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // Telegram 内答题验证。答题消息只用于验证，不会转发到客服群。
  if (!(await handleVerificationMessage(msg, env))) return;

  if (msg.text && msg.text.trim().toLowerCase().startsWith("/start")) return;

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。",
    });
    return;
  }
  if (!rec) rec = await createAndStoreTopic(msg.from, key, env);

  // 相册聚合：用户 -> 话题
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
    return;
  }

  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id,
  });

  if (!res.ok && isThreadMissingError(res)) {
    const newRec = await createAndStoreTopic(msg.from, key, env);
    await tgCall(env, "forwardMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: newRec.thread_id,
    });
  }
}

// 话题 -> 私聊
async function handleTopicMessage(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) return;

  const userId = await findUserByThread(threadId, env);
  if (!userId) return;

  // 相册聚合：话题 -> 用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: null });
    return;
  }

  const res = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id,
  });
  if (!res.ok) {
    const res2 = await tgCall(env, "forwardMessage", {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id,
    });
    console.log("forwardMessage fallback result", { ok: res2.ok, error_code: res2.error_code, description: res2.description });
  }
}

// 创建话题
async function createAndStoreTopic(from, key, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return rec;
}

// 话题标题：昵称 + @username
function buildTopicTitle(from) {
  const first = from.first_name || "";
  const last = from.last_name || "";
  const nick = `${first} ${last}`.trim();
  if (from.username) {
    const at = "@" + from.username;
    return (nick ? `${nick} ${at}` : at).slice(0, 128);
  }
  return (nick || "User").slice(0, 128);
}

// Telegram API
async function tgCall(env, method, body) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await resp.json();
  } catch {
    return { ok: false, description: "invalid json from telegram" };
  }
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || "").toUpperCase();
  return (
    desc.includes("MESSAGE THREAD NOT FOUND") ||
    desc.includes("MESSAGE_THREAD_NOT_FOUND") ||
    desc.includes("THREAD_NOT_FOUND") ||
    desc.includes("TOPIC_NOT_FOUND") ||
    desc.includes("FORUM_TOPIC_NOT_FOUND")
  );
}

async function markThreadClosed(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = true;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}
async function markThreadReopened(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = false;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}

// 答题验证状态
async function isVerified(uid, env) {
  const flag = await env.TOPIC_MAP.get(`verified:${uid}`);
  return Boolean(flag);
}

const VERIFICATION_TTL_SECONDS = 900;

async function handleVerificationMessage(msg, env) {
  const userId = msg.chat.id;
  if (await isVerified(userId, env)) return true;

  const challengeKey = `challenge:${userId}`;
  let challenge = await env.TOPIC_MAP.get(challengeKey, { type: "json" });
  if (!challenge) {
    challenge = createChallenge();
    await env.TOPIC_MAP.put(challengeKey, JSON.stringify(challenge), {
      expirationTtl: VERIFICATION_TTL_SECONDS,
    });
    await sendChallenge(userId, challenge, env);
    return false;
  }

  if (isChallengeAnswer(msg.text, challenge.answer)) {
    await env.TOPIC_MAP.put(`verified:${userId}`, "1");
    await env.TOPIC_MAP.delete(challengeKey);
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "✅ 验证成功！现在可以直接给我发送消息了。",
    });
    console.log("verified-set", { uid: userId });
    return false;
  }

  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: `❌ 答案不正确，请再试一次：\n\n${challenge.question}`,
  });
  return false;
}

function createChallenge() {
  const left = randomInt(10, 99);
  const right = randomInt(10, 99);
  const subtraction = randomInt(0, 1) === 1;
  const first = subtraction ? Math.max(left, right) : left;
  const second = subtraction ? Math.min(left, right) : right;
  const operator = subtraction ? "-" : "+";
  return {
    question: `${first} ${operator} ${second} = ?`,
    answer: subtraction ? first - second : first + second,
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isChallengeAnswer(value, expected) {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30));
  return /^-?\d+$/.test(normalized) && Number(normalized) === expected;
}

async function sendChallenge(userId, challenge, env) {
  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: [
      "👋 欢迎使用，请先完成一个简单的数字验证。",
      "请直接回复答案数字：",
      "",
      challenge.question,
      "",
      "验证有效期 15 分钟，答对后即可开始对话。",
    ].join("\n"),
  });
}

// 按 thread_id 反查用户
async function findUserByThread(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) return Number(name.slice("user:".length));
  }
  return null;
}

// ---------------- 媒体组批量发送：攒到 10 张，或 2 秒未追加则发送 ----------------
async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const now = Date.now();

  const item = extractMedia(msg, direction, msg.chat.id, msg.message_id);
  if (!item) {
    console.log("media group item unsupported, fallback single", { groupId });
    return direction === "p2t"
      ? tgCall(env, "forwardMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: threadId })
      : tgCall(env, "copyMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: now };

  rec.items.push(item);
  rec.last_ts = now;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
  console.log("media group buffered", { key, count: rec.items.length });
  scheduleMediaGroupFlush(ctx, env, key, now);

  // 满 10 张立即发送
  if (rec.items.length >= 10) {
    await flushMediaGroup(rec, env, key);
    await env.TOPIC_MAP.delete(key);
  }
}

function extractMedia(msg, direction, fromChatId, messageId) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: best.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  return null;
}

// 遍历所有 mg:*，超过 2 秒未追加就发送
async function flushExpiredMediaGroups(env, now) {
  const list = await env.TOPIC_MAP.list({ prefix: "mg:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (!rec || !rec.items || !rec.items.length) {
      await env.TOPIC_MAP.delete(name);
      continue;
    }
    if (now - (rec.last_ts || 0) > 2000) { // 2秒未追加，认为该组结束
      await flushMediaGroup(rec, env, name);
      await env.TOPIC_MAP.delete(name);
    }
  }
}

async function flushMediaGroup(rec, env, key) {
  if (rec.items.length === 1) {
    // 单条，用普通 copy/forward
    const it = rec.items[0];
    if (rec.direction === "p2t") {
      await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
        message_thread_id: rec.threadId,
      });
    } else {
      await tgCall(env, "copyMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
    }
    console.log("flushMediaGroup single", { key });
    return;
  }

  if (rec.direction === "p2t") {
    await forwardMediaGroupToTopic(rec, env);
  } else {
    await sendMediaGroupToUser(rec, env);
  }
  console.log("flushMediaGroup batch forwarded", { key, count: rec.items.length, direction: rec.direction });
}

function scheduleMediaGroupFlush(ctx, env, key, expectedTs) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  ctx.waitUntil(
    (async () => {
      await delay(2100);
      const rec = await env.TOPIC_MAP.get(key, { type: "json" });
      if (!rec || !rec.items || !rec.items.length) return;
      if ((rec.last_ts || 0) !== expectedTs) return;
      await flushMediaGroup(rec, env, key);
      await env.TOPIC_MAP.delete(key);
    })()
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forwardMediaGroupToTopic(rec, env) {
  const fromChatId = rec.items[0].from_chat_id;
  const sameSource = rec.items.every((it) => it.from_chat_id === fromChatId);
  if (sameSource) {
    const res = await tgCall(env, "forwardMessages", {
      chat_id: rec.targetChat,
      from_chat_id: fromChatId,
      message_thread_id: rec.threadId,
      message_ids: rec.items.map((it) => it.message_id),
    });
    if (res.ok) return;
    console.log("forwardMessages failed, fallback to single forwards", { error_code: res.error_code, description: res.description });
  }
  for (const it of rec.items) {
    await tgCall(env, "forwardMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
      message_thread_id: rec.threadId,
    });
  }
}

async function sendMediaGroupToUser(rec, env) {
  const media = rec.items.map((it, idx) => ({
    type: it.type,
    media: it.file_id,
    caption: idx === 0 ? it.caption : undefined,
  }));
  const res = await tgCall(env, "sendMediaGroup", {
    chat_id: rec.targetChat,
    media,
  });
  if (res.ok) return;

  console.log("sendMediaGroup to user failed, fallback to copy", { error_code: res.error_code, description: res.description });
  for (const it of rec.items) {
    const copyRes = await tgCall(env, "copyMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
    });
    if (!copyRes.ok) {
      await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
    }
  }
}
