import { handleUpdate, telegramSender } from "./coordinator.js";

async function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([actual, expected].map(value =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const a = new Uint8Array(hashes[0]);
  const b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/" && request.method === "GET") {
      return Response.json({ service: "Doobieduboo Chat", status: "ok" });
    }
    if (path !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", {
      status: 405, headers: { Allow: "POST" },
    });
    if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) {
      return new Response("Secrets not configured", { status: 503 });
    }
    if (!await secretMatches(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 65536) return new Response("Too large", { status: 413 });
    let update;
    try { update = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id)) return new Response("Invalid update", { status: 400 });
    try {
      const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global-v1"));
      return await stub.fetch(new Request("https://internal/update", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }));
    } catch {
      return new Response("Retry later", { status: 503 });
    }
  },
};

export class Matchmaker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.tail = Promise.resolve();
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/update") {
      return new Response("Not found", { status: 404 });
    }
    const update = await request.json();
    // Serialize transitions and deliveries, including across awaited network calls.
    const task = this.tail.then(() => handleUpdate(
      this.ctx.storage, update, telegramSender(this.env.TELEGRAM_BOT_TOKEN),
    ));
    this.tail = task.catch(() => {});
    try {
      await task;
      return new Response("OK");
    } catch {
      // Telegram retries non-2xx webhooks; the outbox resumes without rematching.
      return new Response("Retry later", { status: 503 });
    }
  }
}
