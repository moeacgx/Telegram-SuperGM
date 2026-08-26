import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../woker.js", import.meta.url), "utf8");
const worker = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;

function createHarness() {
  const values = new Map();
  const calls = [];
  let nextThreadId = 100;

  const kv = {
    async get(key, options) {
      const value = values.get(key);
      if (value == null) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, String(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };

  const env = {
    TOPIC_MAP: kv,
    BOT_TOKEN: "test-token",
    BOT_ID: "999",
    SUPERGROUP_ID: "-1001",
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const method = url.split("/").pop();
    calls.push({ method, body });

    const result = method === "createForumTopic"
      ? { message_thread_id: nextThreadId++ }
      : {};
    return new Response(JSON.stringify({ ok: true, result }));
  };

  return {
    values,
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
    async send(text, messageId = calls.length + 1) {
      const request = new Request("https://worker.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 42, first_name: "测试用户" },
            message_id: messageId,
            text,
          },
        }),
      });
      return worker.fetch(request, env, { waitUntil() {} });
    },
  };
}

function toFullWidthDigits(value) {
  return String(value).replace(/\d/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0x30 + 0xff10));
}

test("首次启动发题，答题消息不转发，答对后恢复正常对话", async () => {
  const harness = createHarness();
  try {
    await harness.send("/start");

    const challenge = JSON.parse(harness.values.get("challenge:42"));
    assert.match(challenge.question, /^\d+ [+-] \d+ = \?$/);
    assert.equal(harness.calls.at(-1).method, "sendMessage");
    assert.match(harness.calls.at(-1).body.text, /请直接回复答案数字/);

    await harness.send("答案不知道");
    assert.equal(harness.values.has("verified:42"), false);
    assert.equal(harness.calls.at(-1).method, "sendMessage");
    assert.match(harness.calls.at(-1).body.text, /答案不正确/);
    assert.equal(harness.calls.some(({ method }) => method === "forwardMessage"), false);

    await harness.send(toFullWidthDigits(challenge.answer));
    assert.equal(harness.values.get("verified:42"), "1");
    assert.equal(harness.values.has("challenge:42"), false);
    assert.equal(harness.calls.at(-1).method, "sendMessage");
    assert.match(harness.calls.at(-1).body.text, /验证成功/);
    assert.equal(harness.calls.some(({ method }) => method === "forwardMessage"), false);

    await harness.send("你好");
    assert.equal(harness.calls.at(-2).method, "createForumTopic");
    assert.equal(harness.calls.at(-1).method, "forwardMessage");
  } finally {
    harness.restore();
  }
});
