# Doobieduboo Telegram Chatbot

Bot chat anonim berbahasa Indonesia untuk **Cloudflare Workers + Durable Objects**. Bot Telegram: [@doobieduboo_chatbot](https://t.me/doobieduboo_chatbot).

Tidak memakai server Termux, D1, R2, KV namespace terpisah, atau database eksternal. **Tetap ada penyimpanan** di dalam Durable Object untuk antrean, pasangan, blokir, ID update terakhir, serta pesan yang belum selesai dikirim. Durable Object yang dipakai bertipe SQLite-backed (dukungan paket Free); Wrangler membuatnya otomatis melalui migration. Kamu tidak perlu membuat atau mengelola database/tabel sendiri.

## Fitur

- `/start`, `/help`: panduan dan informasi privasi.
- `/search`: cari teman acak yang juga sedang antre.
- `/next`: akhiri sesi dan masuk antrean lagi. Pasangan lama harus mencari lagi sendiri.
- `/stop`: akhiri chat atau batalkan pencarian.
- `/block`: akhiri chat dan cegah pertemuan lagi, termasuk setelah restart/deploy.
- Chat pribadi berbasis teks; media, kontak, lokasi, dan pesan grup tidak diteruskan.
- Kirim teks baru tanpa identitas forward atau entitas profil; tautan tidak menampilkan preview. Screenshot tidak dibatasi oleh bot (`protect_content: false`).
- Jeda pengiriman satu detik per pengguna; pesan yang terlalu cepat ditolak dengan pemberitahuan, bukan ditunda.
- Satu Durable Object mengoordinasikan pencocokan agar dua request tidak memilih pasangan yang sama.

## Deploy lewat browser HP dan GitHub

1. Buka Cloudflare Dashboard → **Workers & Pages → Create → Worker → Import a repository** (nama menu bisa berubah).
2. Hubungkan GitHub dan pilih repo **doobieduboo/chatbot**. Pilih **Workers**, bukan Pages.
3. Gunakan pengaturan build:
   - Root directory: `/` (root repo).
   - Build command: `npm run build`.
   - Deploy command: `npm run deploy`.
   - Worker name: `doobieduboo-chatbot` (sesuai `wrangler.jsonc`).
4. Deploy. Wrangler akan membuat binding `MATCHMAKER` dan migrasi Durable Object otomatis. **Jangan menghapus/mengganti migration `v1` atau nama object setelah bot dipakai.**
5. Di Worker → **Settings → Variables and Secrets**, tambahkan dua **Secret** runtime:
   - `TELEGRAM_BOT_TOKEN`: token bot yang baru dari BotFather.
   - `WEBHOOK_SECRET`: string acak 64 karakter. Buat di Termux dengan:

   ```bash
   python -c 'import secrets; print(secrets.token_hex(32))'
   ```

6. Simpan/deploy perubahan secrets. Catat URL Worker, misalnya `https://doobieduboo-chatbot.NAMA-AKUN.workers.dev`.
7. Matikan proses Python bot lama di Termux (**CTRL + C**). Bot polling dan webhook tidak dijalankan bersamaan.
8. Daftarkan webhook mengikuti langkah di bawah. Setelah webhook aktif, HP/Termux boleh mati.

Membuka halaman utama Worker hanya memeriksa HTTP endpoint, belum membuktikan token, Durable Object, atau webhook Telegram sudah berfungsi. Tanpa secrets, `/webhook` mengembalikan 503.

## Daftarkan webhook dari Termux, tanpa token masuk GitHub

Python yang sebelumnya dipasang sudah cukup. Salin seluruh blok, lalu isi token, URL Worker, dan **WEBHOOK_SECRET yang sama persis** dengan Cloudflare. Token/secret tidak terlihat saat diketik. URL dimasukkan tanpa `/webhook`.

```bash
python - <<'PY'
import getpass
import json
import re
import urllib.request
from urllib.parse import urlsplit

token = getpass.getpass("Token bot: ").strip()
base = input("URL HTTPS Worker (tanpa /webhook): ").strip().rstrip("/")
secret = getpass.getpass("WEBHOOK_SECRET dari Cloudflare: ").strip()
url = urlsplit(base)
if url.scheme != "https" or not url.netloc or url.path not in ("", "/") or url.query or url.fragment:
    raise SystemExit("Masukkan URL dasar HTTPS Worker yang valid.")
if not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", secret):
    raise SystemExit("Secret harus 16–256 karakter huruf, angka, _ atau -.")
payload = {
    "url": base + "/webhook",
    "secret_token": secret,
    "allowed_updates": ["message"],
    "max_connections": 1,
    "drop_pending_updates": True,
}
req = urllib.request.Request(
    "https://api.telegram.org/bot" + token + "/setWebhook",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.load(response)
    print("Webhook aktif!" if result.get("ok") else "Gagal. Periksa konfigurasi.")
except Exception:
    print("Gagal. Periksa token, koneksi, dan URL Worker. Token tidak dicetak.")
PY
```

`drop_pending_updates` membuang pesan Telegram lama yang menumpuk saat migrasi. Jalankan pendaftaran setelah pengguna selesai dengan sesi Termux lama; sesi lama di HP tidak diimpor ke Cloudflare.

## Deploy dari komputer (alternatif)

Node.js 22+:

```bash
npm ci
npm test
npm run build
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npm run deploy
```

Untuk pengembangan lokal, salin `.dev.vars.example` ke `.dev.vars`, isi secrets lokal, lalu `npm run dev`. File ini diabaikan Git. Jangan pernah commit `.env`, `.dev.vars`, atau token.

Ada juga `npm run webhook:set`, `npm run webhook:info`, dan `npm run webhook:delete` untuk Node. Script ini membaca variabel lokal `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, dan `WORKER_URL`. Menghapus webhook diperlukan sebelum kembali ke polling Python. Jangan memanggil API Telegram menggunakan URL berisi token di browser publik atau menaruh token di commit.

## Uji setelah deployment

1. Akun A kirim `/start` lalu `/search`: mendapat pesan mencari teman.
2. Akun B kirim `/search`: keduanya mendapat pesan teman ditemukan.
3. Kirim teks bolak-balik; tidak ada identitas profil atau atribusi forward.
4. Akun A `/stop`: B mendapat notifikasi; teks berikutnya tidak diteruskan.
5. Kedua akun cari lagi, lalu A `/block`. Setelah keduanya mencari lagi, mereka tidak dipasangkan satu sama lain. Blokir tidak dihapus saat Worker restart.
6. Tutup Termux dan coba `/start` lagi. Bot harus tetap membalas lewat Cloudflare.

## Privasi, pengiriman, dan batas pemakaian

- Ini bukan enkripsi ujung-ke-ujung. Telegram memproses pesan dan operator memiliki akses teknis ke ID pengguna. Pengguna tetap dapat mengungkap identitas lewat teks yang mereka tulis sendiri.
- Aplikasi tidak membuat log isi chat atau token. Pesan disimpan sementara dalam outbox sampai API Telegram mengonfirmasi pengiriman, kemudian dihapus dari snapshot aktif. Data antrean, pasangan dan blokir tetap tersimpan. Penyimpanan/infrastruktur Cloudflare dapat memiliki mekanisme pemulihan tersendiri.
- Jika Telegram timeout atau memberi error sementara, webhook mengembalikan 503 agar Telegram mencoba lagi. Update duplikat terbaru tidak mengulangi pencocokan. Jika Telegram menerima pesan tetapi responsnya terputus sebelum status tersimpan, pesan dapat terkirim dua kali saat retry; pengiriman tepat satu kali tidak dijamin oleh Bot API.
- Ketika API menyatakan penerima tidak dapat dijangkau, sesi dilepas dan pasangan diberi tahu. Pesan relay dari sesi yang sudah berakhir tidak dikirim ke sesi baru.
- Antrean dibatasi 1.000 pengguna. Versi awal ini memakai satu Durable Object dan snapshot untuk koordinasi; cocok untuk pemakaian awal, bukan klaim kapasitas layanan besar. Antrean tidak otomatis kedaluwarsa: pengguna keluar dengan `/stop` atau dikeluarkan saat tidak dapat dijangkau.
- Belum ada moderator, sistem laporan, penghapusan akun mandiri, atau dukungan media. Tambahkan sebelum memperluas layanan publik.
- Cloudflare Workers dan SQLite-backed Durable Objects memiliki paket Free **dengan kuota**; periksa [harga Workers](https://developers.cloudflare.com/workers/platform/pricing/) dan [harga Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) sebelum penggunaan besar. Tidak ada janji gratis tanpa batas atau selalu tersedia saat kuota habis.
- Deploy kode ke GitHub **tidak otomatis membuat webhook aktif**. Secrets dan pendaftaran webhook tetap harus diselesaikan di akun Cloudflare/Telegram milikmu.

Dokumentasi: [Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/) · [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook).
