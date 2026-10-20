// Run with Node 22+. Credentials come only from local environment variables.
const action = process.argv[2];
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || !["set", "info", "delete"].includes(action)) {
  console.error("Isi TELEGRAM_BOT_TOKEN lalu gunakan webhook:set, webhook:info, atau webhook:delete.");
  process.exit(1);
}
const secret = process.env.WEBHOOK_SECRET;
const base = process.env.WORKER_URL;
let method = "getWebhookInfo";
let body = {};
if (action === "set") {
  if (!base || !secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    console.error("Isi WORKER_URL dan WEBHOOK_SECRET (16–256 karakter A–Z, a–z, 0–9, _ atau -).");
    process.exit(1);
  }
  let url;
  try { url = new URL(base); } catch { console.error("WORKER_URL tidak valid."); process.exit(1); }
  if (url.protocol !== "https:") { console.error("WORKER_URL harus HTTPS."); process.exit(1); }
  url.pathname = "/webhook";
  url.search = "";
  url.hash = "";
  method = "setWebhook";
  body = { url: url.href, secret_token: secret, allowed_updates: ["message"], max_connections: 1, drop_pending_updates: true };
} else if (action === "delete") {
  method = "deleteWebhook";
  body = { drop_pending_updates: true };
}
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error("Telegram rejected request");
  if (action === "info") {
    console.log(JSON.stringify({ url: result.result.url,
      pending_update_count: result.result.pending_update_count,
      last_error_date: result.result.last_error_date ?? null,
      max_connections: result.result.max_connections }, null, 2));
  } else console.log(action === "set" ? "Webhook aktif." : "Webhook dihapus.");
} catch {
  console.error("Permintaan gagal. Periksa token, koneksi, dan URL Workers. Token tidak dicetak.");
  process.exitCode = 1;
}
