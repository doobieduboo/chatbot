import { applyUpdate, disconnect, emptyState, enqueue } from "./chat.js";

// Chunk snapshots below the 128 KiB per-value Durable Object KV limit.
// All chunks and their count are committed atomically inside a storage transaction.
const CHUNK_SIZE = 16000;
export async function readState(storage) {
  const count = await storage.get("snapshot-count");
  if (!count) return emptyState();
  const chunks = await storage.get(Array.from({ length: count }, (_, i) => `snapshot:${i}`));
  return JSON.parse(Array.from({ length: count }, (_, i) => chunks.get(`snapshot:${i}`)).join(""));
}

export async function saveState(storage, state) {
  const text = JSON.stringify(state);
  const count = Math.ceil(text.length / CHUNK_SIZE);
  await storage.transaction(async tx => {
    const previous = await tx.get("snapshot-count") ?? 0;
    for (let i = 0; i < count; i++) {
      await tx.put(`snapshot:${i}`, text.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    for (let i = count; i < previous; i++) await tx.delete(`snapshot:${i}`);
    await tx.put("snapshot-count", count);
  });
}

export function telegramSender(token, request = fetch) {
  return async action => {
    let response;
    try {
      response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: action.id, text: action.text,
          link_preview_options: { is_disabled: true },
          protect_content: false,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const result = await response.json();
      if (result.ok === true) return "sent";
      if ([400, 403].includes(result.error_code)) return "unreachable";
    } catch {
      // Do not expose token-bearing URLs or message contents in logs/errors.
    }
    throw new Error("Telegram temporarily unavailable");
  };
}

export async function drain(state, storage, send) {
  const deadline = Date.now() + 15000;
  while (state.outbox.length) {
    if (Date.now() > deadline) throw new Error("Retry delivery later");
    const action = state.outbox[0];
    const stale = action.session !== null
      && (state.users[action.id]?.partner !== action.session
          || state.users[action.session]?.partner !== action.id);
    if (stale) {
      state.outbox.shift();
      await saveState(storage, state);
      continue;
    }
    const result = await send(action);
    state.outbox.shift();
    if (result === "unreachable") {
      const other = disconnect(state, action.id);
      if (other !== null) enqueue(state, other,
        "Pasangan tidak dapat dihubungi. Ketik /search untuk mencari lagi.");
    }
    await saveState(storage, state);
  }
}

export async function handleUpdate(storage, update, send) {
  // Reload on every request, including after an interrupted delivery.
  const state = await readState(storage);
  await drain(state, storage, send);
  applyUpdate(state, update);
  await saveState(storage, state);
  await drain(state, storage, send);
}
