export const HELP = `Selamat datang di Doobieduboo!

/search — cari teman
/next — ganti teman
/stop — berhenti
/block — blokir pasangan
/help — panduan

Kirim teks setelah mendapat pasangan. Profil pengirim tidak ditampilkan. Jangan bagikan data pribadi.

Telegram memproses pesan dan operator bot dapat mengakses ID pengguna. Antrean, pasangan, dan blokir disimpan di Cloudflare. Isi chat hanya disimpan sementara jika masih menunggu pengiriman. Screenshot tidak dibatasi oleh bot.`;

export function emptyState() {
  return { waiting: [], users: {}, seen: [], outbox: [] };
}

export function disconnect(state, id) {
  state.waiting = state.waiting.filter(other => other !== id);
  const user = state.users[id];
  if (!user) return null;
  const other = user.partner;
  user.partner = null;
  user.lastMessage = 0;
  if (other !== null && state.users[other]?.partner === id) {
    state.users[other].partner = null;
    state.users[other].lastMessage = 0;
  }
  return other;
}

export function enqueue(state, id, text, session = null) {
  state.outbox.push({ id, text, session });
}

function find(state, id, exclude, random) {
  const user = state.users[id];
  state.waiting = state.waiting.filter(other => other !== id);
  const candidates = state.waiting.filter(other =>
    other !== exclude && !user.blocked.includes(other)
    && !state.users[other].blocked.includes(id));
  if (!candidates.length) {
    if (state.waiting.length >= 1000) {
      enqueue(state, id, "Antrean penuh. Coba beberapa saat lagi.");
      return;
    }
    state.waiting.push(id);
    enqueue(state, id, "Mencari teman… /stop untuk membatalkan.");
    return;
  }
  const other = candidates[Math.floor(random() * candidates.length)];
  state.waiting = state.waiting.filter(value => value !== other);
  user.partner = other;
  state.users[other].partner = id;
  enqueue(state, other, "Teman ditemukan! Silakan kirim teks.", id);
  enqueue(state, id, "Teman ditemukan! Silakan kirim teks.", other);
}

// Pure transition: Telegram calls are performed separately using a persisted outbox.
export function applyUpdate(state, update, now = Date.now(), random = Math.random) {
  if (state.seen.includes(update.update_id)) return;
  state.seen.push(update.update_id);
  state.seen = state.seen.slice(-512);
  const message = update.message;
  if (!message || message.chat?.type !== "private" || message.from?.is_bot) return;
  const id = message.from?.id;
  if (!Number.isSafeInteger(id) || message.chat.id !== id) return;
  state.users[id] ??= { partner: null, blocked: [], lastMessage: 0 };
  const user = state.users[id];
  const text = message.text;
  const command = text?.startsWith("/") ? text.split(/\s/)[0].split("@")[0].toLowerCase() : null;

  if (command === "/start" || command === "/help") {
    enqueue(state, id, HELP);
  } else if (command === "/search") {
    if (user.partner !== null) enqueue(state, id, "Masih dalam chat. Ketik /next untuk ganti.");
    else find(state, id, null, random);
  } else if (["/stop", "/next", "/block"].includes(command)) {
    const other = disconnect(state, id);
    if (other !== null) {
      if (command === "/block" && !user.blocked.includes(other)) user.blocked.push(other);
      enqueue(state, other, "Lawan bicara mengakhiri chat. Ketik /search untuk mencari lagi.");
    }
    if (command === "/next") find(state, id, other, random);
    else enqueue(state, id, command === "/block" && other !== null
      ? "Pasangan diblokir. Ketik /search untuk mencari teman."
      : "Chat/pencarian dihentikan. Ketik /search untuk mencari teman.");
  } else if (command || !text) {
    enqueue(state, id, "Hanya pesan teks yang didukung. Ketik /help untuk panduan.");
  } else if (user.partner === null) {
    enqueue(state, id, "Ketik /search, lalu tunggu pasangan.");
  } else if (now - user.lastMessage < 1000) {
    enqueue(state, id, "Tunggu 1 detik sebelum mengirim lagi.");
  } else {
    user.lastMessage = now;
    enqueue(state, user.partner, text, id);
  }
}
