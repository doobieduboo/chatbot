import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { applyUpdate, emptyState } from "../src/chat.js";
import { handleUpdate, readState, saveState, telegramSender } from "../src/coordinator.js";

function update(id, user, text, extra = {}) {
  return { update_id: id, message: { from: { id: user }, chat: { id: user, type: "private" }, text, ...extra } };
}

class MemoryStorage {
  data = new Map();
  async get(key) {
    if (Array.isArray(key)) return new Map(key.map(k => [k, structuredClone(this.data.get(k))]));
    return structuredClone(this.data.get(key));
  }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async transaction(callback) {
    const before = structuredClone(this.data);
    try { return await callback(this); } catch (error) { this.data = before; throw error; }
  }
}

test("two users pair, relay plain text, and stop disconnects both", () => {
  const s = emptyState();
  applyUpdate(s, update(1, 10, "/search"));
  applyUpdate(s, update(2, 20, "/search"));
  assert.equal(s.users[10].partner, 20);
  assert.equal(s.users[20].partner, 10);
  assert.deepEqual(s.waiting, []);
  s.outbox = [];
  applyUpdate(s, update(3, 10, "halo"));
  assert.deepEqual(s.outbox, [{ id: 20, text: "halo", session: 10 }]);
  applyUpdate(s, update(4, 20, "/stop"));
  assert.equal(s.users[10].partner, null);
  assert.equal(s.users[20].partner, null);
});

test("repeat search cannot match self; /start does not end an active session", () => {
  const s = emptyState();
  applyUpdate(s, update(1, 10, "/search"));
  applyUpdate(s, update(2, 10, "/search"));
  assert.deepEqual(s.waiting, [10]);
  applyUpdate(s, update(3, 20, "/search"));
  applyUpdate(s, update(4, 10, "/start"));
  assert.equal(s.users[10].partner, 20);
});

test("block prevents matching in either search order", () => {
  for (const order of [[10, 20], [20, 10]]) {
    const s = emptyState();
    applyUpdate(s, update(1, 10, "/search"));
    applyUpdate(s, update(2, 20, "/search"));
    applyUpdate(s, update(3, 10, "/block"));
    applyUpdate(s, update(4, order[0], "/search"));
    applyUpdate(s, update(5, order[1], "/search"));
    assert.equal(s.users[10].partner, null);
    assert.equal(s.users[20].partner, null);
    applyUpdate(s, update(6, 30, "/search"));
    assert.ok([10, 20].includes(s.users[30].partner));
  }
});

test("next leaves old partner out of queue; stop cancels waiting", () => {
  const s = emptyState();
  applyUpdate(s, update(1, 10, "/search"));
  applyUpdate(s, update(2, 20, "/search"));
  applyUpdate(s, update(3, 10, "/next"));
  assert.deepEqual(s.waiting, [10]);
  assert.equal(s.users[20].partner, null);
  applyUpdate(s, update(4, 10, "/stop"));
  assert.deepEqual(s.waiting, []);
});

test("media and group messages are not relayed; burst receives cooldown", () => {
  const s = emptyState();
  applyUpdate(s, update(1, 10, "/search"));
  applyUpdate(s, update(2, 20, "/search"));
  s.outbox = [];
  applyUpdate(s, update(3, 10, undefined, { photo: [{ file_id: "photo" }] }));
  assert.equal(s.outbox[0].id, 10);
  applyUpdate(s, update(4, 10, "group text", { chat: { id: -1, type: "group" } }));
  assert.equal(s.outbox.length, 1);
  applyUpdate(s, update(5, 10, "hello"), 10000);
  applyUpdate(s, update(6, 10, "too fast"), 10100);
  assert.equal(s.outbox.at(-1).id, 10);
  assert.match(s.outbox.at(-1).text, /1 detik/);
});

test("state survives restart and duplicate Telegram updates do not rematch or resend", async () => {
  const storage = new MemoryStorage();
  const sent = [];
  const send = async a => { sent.push(a); return "sent"; };
  await handleUpdate(storage, update(1, 10, "/search"), send);
  await handleUpdate(storage, update(2, 20, "/search"), send);
  const count = sent.length;
  await handleUpdate(storage, update(2, 20, "/search"), send);
  assert.equal(sent.length, count);
  assert.equal((await readState(storage)).users[10].partner, 20);
});

test("transient delivery failure resumes outbox without repeating transition", async () => {
  const storage = new MemoryStorage();
  await handleUpdate(storage, update(1, 10, "/search"), async () => "sent");
  await assert.rejects(handleUpdate(storage, update(2, 20, "/search"), async () => { throw Error("network"); }));
  assert.equal((await readState(storage)).outbox.length, 2);
  const sent = [];
  await handleUpdate(storage, update(2, 20, "/search"), async a => { sent.push(a); return "sent"; });
  assert.equal(sent.length, 2);
  assert.equal((await readState(storage)).outbox.length, 0);
  assert.equal((await readState(storage)).users[10].partner, 20);
});

test("unreachable partner is disconnected, stale match notification is suppressed", async () => {
  const storage = new MemoryStorage();
  await handleUpdate(storage, update(1, 10, "/search"), async () => "sent");
  const sent = [];
  await handleUpdate(storage, update(2, 20, "/search"), async a => {
    sent.push(a);
    return a.id === 10 ? "unreachable" : "sent";
  });
  const s = await readState(storage);
  assert.equal(s.users[10].partner, null);
  assert.equal(s.users[20].partner, null);
  assert.equal(sent.filter(a => a.id === 20 && /Teman ditemukan/.test(a.text)).length, 0);
  assert.match(sent.at(-1).text, /tidak dapat dihubungi/);
});

test("large Unicode state is chunked, restored, and obsolete chunks removed", async () => {
  const storage = new MemoryStorage();
  const s = emptyState();
  s.outbox.push({ id: 1, text: "😀Halo".repeat(20000), session: null });
  await saveState(storage, s);
  assert.ok(await storage.get("snapshot-count") > 1);
  assert.deepEqual(await readState(storage), s);
  await saveState(storage, emptyState());
  assert.equal(await storage.get("snapshot-count"), 1);
  assert.equal(await storage.get("snapshot:1"), undefined);
});

test("Telegram payload has no identity entities, formatting, preview, or screenshot protection", async () => {
  let payload;
  const send = telegramSender("fake-token", async (url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ ok: true });
  });
  assert.equal(await send({ id: 20, text: "<b>halo</b>" }), "sent");
  assert.equal(payload.text, "<b>halo</b>");
  assert.equal(payload.protect_content, false);
  assert.equal(payload.entities, undefined);
  assert.equal(payload.parse_mode, undefined);
  assert.deepEqual(payload.link_preview_options, { is_disabled: true });
});

test("webhook rejects wrong secrets and malformed updates before calling Durable Objects", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "fake-token", WEBHOOK_SECRET: "test-secret" };
  assert.equal((await worker.fetch(new Request("https://test/"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://test/webhook", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://test/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" }, body: "{}",
  }), env)).status, 400);
});

test("authenticated update is routed to the shared matchmaker", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "fake-token", WEBHOOK_SECRET: "test-secret",
    MATCHMAKER: { idFromName(name) { assert.equal(name, "global-v1"); return "id"; },
      get() { return { async fetch(req) {
        assert.deepEqual(await req.json(), update(1, 10, "/start"));
        return new Response("OK");
      } }; } },
  };
  const res = await worker.fetch(new Request("https://test/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify(update(1, 10, "/start")),
  }), env);
  assert.equal(res.status, 200);
});
