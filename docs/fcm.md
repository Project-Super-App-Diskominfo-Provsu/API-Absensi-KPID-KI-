# Pengingat check-in melalui Firebase Cloud Messaging

Backend menyediakan registrasi token dan worker pengingat terpisah. PostgreSQL menyimpan antrean agar restart API tidak menghapus jadwal pengiriman. Redis tetap dipakai untuk rate limit API; tidak perlu layanan antrean tambahan.

## Aturan pengingat

- Batas tepat waktu mengikuti `starts_at + grace_minutes` pada jadwal database. Untuk aturan instansi, isi jam masuk 08.00 WIB dan toleransi 0 menit; pengingat dijadwalkan 07.55 WIB. Setelah 08.00, check-in tetap dapat diterima sebagai LATE sesuai pemeriksaan absensi lainnya.
- Worker memeriksa jadwal hari ini di Asia/Jakarta. Akun harus aktif, role EMPLOYEE/VERIFIER, dan kategori KPID/KI. Perangkat harus ACTIVE, token terdaftar pada Firebase project yang dikonfigurasi, serta keluarga sesi Android masih aktif.
- Pegawai yang sudah memiliki check-in diterima tidak dikirimi pengingat. NEEDS_REVIEW bukan check-in diterima. Status notifikasi tidak menentukan status kehadiran.
- Jika worker mulai setelah 07.55, pengingat masih dapat dicoba sebelum 08.00. Setelah batas itu, job yang belum selesai dilewati. Waktu pengiriman mengikuti polling, default 10 detik, bukan jaminan penerimaan tepat pada detik 07.55.
- Jadwal pending dihitung ulang ketika jadwal berubah. Jadwal yang sudah mendapat notifikasi tidak dikirim ulang hanya karena diedit.
- Worker memeriksa ulang akun, perangkat, sesi, jadwal dan check-in sebelum memanggil FCM. Check-in/logout yang terjadi bersamaan setelah pemeriksaan terakhir masih dapat beririsan dengan pengiriman yang sudah dimulai.

## Kontrak FE Android

Sesudah login dan perangkat disetujui, kirim token dari Firebase Messaging SDK:

```http
POST /api/v1/devices/{device_id}/push-token
Authorization: Bearer <access_token_aplikasi>
Content-Type: application/json

{"token":"<FCM registration token>","signature":"<base64 Ed25519 signature>"}
```

Pesan yang ditandatangani dengan private key perangkat yang sudah terdaftar:

```text
push-token:<user_id>:<device_id>:<sha256(token)>
```

SHA-256 menggunakan byte UTF-8 token persis dan hex lowercase, tanpa newline. Jangan memakai private key Firebase untuk signature perangkat. Respons berhasil HTTP 204 tanpa body. Ulangi registrasi ketika FCM memanggil `onTokenRefresh`, setelah login baru, atau token/project Firebase berubah. Pembaruan token perangkat yang sama menggantikan nilai lama; token yang sudah dipakai perangkat lain menghasilkan 409 `FCM_TOKEN_IN_USE`.

Endpoint memerlukan sesi MOBILE aktif; cookie panel admin tidak digunakan. API juga memverifikasi signature agar pemegang JWT saja tidak bisa mengalihkan tujuan push tanpa kunci perangkat.

Untuk berhenti menerima notifikasi perangkat:

```http
DELETE /api/v1/devices/{device_id}/push-token
Authorization: Bearer <access_token_aplikasi>
```

Respons HTTP 204. Endpoint ini tetap dapat membersihkan token milik perangkat sendiri yang telah dicabut. FE dianjurkan menghapus token pada backend sebelum logout. Backend juga memeriksa keluarga sesi sehingga logout, logout-all, reset password atau pencabutan sesi menghentikan kelayakan pengiriman meskipun token belum dihapus. Rotasi refresh token tetap dalam keluarga yang sama dan tidak membutuhkan registrasi ulang pada setiap refresh.

FE perlu meminta izin notifikasi Android yang sesuai dan membuat notification channel ID `attendance-reminders`. Pesan berisi notification title/body generik dan data:

```json
{
  "type": "CHECK_IN_REMINDER",
  "notification_id": "<UUID delivery>",
  "schedule_id": "<UUID jadwal>",
  "expires_at": "<ISO timestamp batas tepat waktu>"
}
```

Tidak ada NIP, embedding, atau koordinat dalam payload. Tangani foreground/background sesuai SDK React Native yang dipakai, gunakan notification_id untuk deduplikasi, dan abaikan data kedaluwarsa. Notifikasi dapat membuka halaman absensi; keberhasilan push tidak memberi izin melewati aturan API.

## Konfigurasi lokal

Gunakan service account untuk Firebase project yang sama dengan `google-services.json` dan token perangkat FE. Project FCM yang disepakati adalah `absensi-439de`; kredensial Google SSO dikelola terpisah dan tidak berubah.

```dotenv
FCM_ENABLED=true
FIREBASE_PROJECT_ID=absensi-439de
GOOGLE_APPLICATION_CREDENTIALS=C:/path/private/firebase-admin.json
NOTIFICATION_WORKER_PORT=8001
NOTIFICATION_POLL_MS=10000
```

Path tersebut contoh; gunakan lokasi JSON lokal sebenarnya. File private key harus berada di luar Git dan build context image. API hanya membutuhkan flag dan Project ID untuk registrasi; JSON kredensial digunakan worker.

```powershell
npm ci
npm run db:migrate
npm run notifications:check
```

Perintah check membaca service account, memeriksa kesesuaian project dan inisialisasi SDK tanpa mengirim push. Itu belum membuktikan izin IAM/FCM API atau pengiriman ke perangkat nyata. API tetap dijalankan di terminal tersendiri:

```powershell
npm run dev
```

Worker dijalankan pada terminal lain:

```powershell
npm run notifications:dev
```

Health worker lokal: `http://localhost:8001/health`. Readiness: `http://localhost:8001/ready`. Readiness menandakan siklus database berhasil baru-baru ini dan konfigurasi dimuat; bukan konfirmasi pengiriman FCM ke Android. Worker notifikasi tidak bergantung pada worker wajah untuk startup.

## Deployment Dokploy

Jalankan migration 012 pada database sebelum worker dimulai. Migration ini menambah tabel/index dan tidak mengganti data akun, sesi atau jadwal. API dapat memakai migrasi startup sesuai pengaturan deployment yang sudah ada. Worker hanya memverifikasi schema; tidak melakukan migrasi sendiri.

Untuk Compose, simpan JSON di host server dan isi environment deployment, misalnya:

```dotenv
FCM_ENABLED=true
FIREBASE_PROJECT_ID=absensi-439de
GOOGLE_APPLICATION_CREDENTIALS=/opt/absensi/secrets/firebase-admin.json
NOTIFICATION_POLL_MS=10000
```

Path di atas merupakan sumber bind mount host. Compose memasangnya read-only ke `/run/secrets/firebase-admin.json` dan mengatur path di dalam worker secara otomatis. Pastikan user non-root container dapat membaca file. Gunakan service account dengan izin pengiriman FCM yang diperlukan; jangan menanam private key ke image atau mengirimnya ke Android.

Aktifkan profil `notifications` pada deployment Dokploy yang sama dengan API. Jika menjalankan dari terminal host, gunakan root checkout dan nama project Compose yang benar:

```sh
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml --profile notifications up -d --build --wait api notification-worker
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml logs --tail=100 notification-worker
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml exec notification-worker npm run notifications:check:production
```

Ganti NAMA_PROJECT_DOKPLOY; nama berbeda dapat membuat stack kedua. Jangan menjalankan Compose dari terminal container API. Worker membutuhkan akses PostgreSQL yang sama dengan API dan akses keluar HTTPS ke Google. Jika PostgreSQL berada pada jaringan Dokploy tersendiri, hubungkan worker ke jaringan itu juga. Worker tidak membutuhkan port/domain publik. Service notifikasi menunggu health API pada Compose untuk urutan startup setelah migrasi.

Jika menggunakan Application Dockerfile, buat worker sebagai service terpisah memakai image API terbaru. Start command: `npm run notifications:start`. Isi DATABASE_URL, FCM_ENABLED, FIREBASE_PROJECT_ID, dan GOOGLE_APPLICATION_CREDENTIALS dengan path file di dalam container, lalu pasang JSON read-only. Atur health check `/ready` port 8001; health check bawaan image API port 3000 harus diganti untuk service ini.

Untuk menonaktifkan fitur, set FCM_ENABLED=false pada API dan hentikan profil/service notification-worker. Jangan mengaktifkan profil ketika flag false karena worker memang menolak konfigurasi tersebut. Jika rollback runtime, hentikan worker baru terlebih dahulu dan pertahankan tabel migration 012; tidak perlu menghapus data atau mengubah migration lama.

## Retry dan operasional

Satu delivery per jadwal dilindungi unique constraint. Worker memakai claim ID, `FOR UPDATE SKIP LOCKED`, lease dua menit, dan heartbeat saat panggilan provider berlangsung. Job worker yang mati dapat diambil kembali setelah lease habis. Kegagalan transient dicoba maksimal tiga percobaan aplikasi, dengan jeda awal 5 detik lalu 10 detik, hanya sebelum deadline. Firebase Admin SDK juga dapat melakukan retry transport internal.

Token yang secara eksplisit dinyatakan invalid/not registered dihapus dengan kondisi nilai token masih sama; pembaruan token yang terjadi bersamaan tidak terhapus. Error permanen seperti mismatch credential gagal tanpa retry berulang. Log/audit tidak mencetak token atau private key. Periksa status agregat tanpa mengambil token:

```sql
SELECT status, last_error, count(*)
FROM notification_deliveries
WHERE created_at >= now() - interval '7 days'
GROUP BY status, last_error;
```

Status SENT berarti FCM menerima pengiriman, bukan bukti Android menampilkan atau pengguna membaca. Delivery bersifat at-least-once: proses dapat mati setelah FCM menerima tetapi sebelum DB mencatat SENT. Retry memakai ID dan Android notification tag yang sama untuk mengurangi duplikasi; FE tetap perlu deduplikasi. Tidak ada jaminan exactly-once maupun waktu penerimaan mutlak karena jaringan, kondisi Android, dan retry transport. TTL dibatasi waktu tersisa hingga deadline, maksimal lima menit; expires_at juga tersedia bagi FE.

Data delivery/token memerlukan kebijakan retensi operasional; pembersihan otomatis belum ditambahkan. Tidak ada endpoint broadcast/admin bebas untuk mengirim ke token sembarang. Pengujian nyata menunggu registration token dari Android pada project yang sama.

Sumber: [Firebase Admin SDK send](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk), [pengelolaan token](https://firebase.google.com/docs/cloud-messaging/manage-tokens), [masa berlaku pesan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).
