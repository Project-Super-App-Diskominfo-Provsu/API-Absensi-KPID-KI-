# Login internal dan staging

Login internal dapat digunakan tanpa Google Console, callback, atau kredensial SSO. Tetapkan `SSO_ENABLED=false`. Akun pegawai dibuat admin, bukan melalui registrasi publik. Akun dengan `auth_mode=SSO` tidak dapat memakai password lokal; akun LOCAL/BOTH tetap memerlukan password yang benar dan status aktif.

## Kontrak login Android

Semua endpoint berikut memakai prefix `/api/v1`:

| Endpoint | Body | Hasil |
| --- | --- | --- |
| POST `/auth/login` | `email`, `password` | Access JWT dan refresh token |
| POST `/auth/refresh` | `refresh_token` | Pasangan token baru, token lama dicabut |
| POST `/auth/logout` | Tidak ada; Bearer wajib | 204; cabut keluarga sesi saat ini |
| POST `/auth/logout-all` | Tidak ada; Bearer wajib | 204; cabut seluruh sesi pengguna |
| POST `/auth/change-password` | `current_password`, `new_password`; Bearer wajib | 204; cabut seluruh sesi, login ulang |

Access token berlaku maksimal 10 menit. Refresh token memiliki batas absolut 30 hari sejak login; refresh tidak memperpanjang batas tersebut. Mendekati akhir sesi, access token dibatasi sisa masa berlaku sesi. Refresh token berupa nilai acak dan hanya hash SHA-256 yang disimpan di database. Penggunaan ulang token yang sudah dirotasi mencabut seluruh keluarga sesi, termasuk token anak.

Android harus mengirim satu request refresh pada satu waktu, menyimpan pasangan token baru secara atomik, lalu mengulang request bisnis. Jangan menjalankan refresh paralel. Jika respons refresh hilang dan token lama sudah dipakai, login ulang diperlukan. Simpan refresh token pada penyimpanan aman berbasis Android Keystore; jangan masukkan token dalam URL, log, atau penyimpanan plaintext.

Verifikasi JWT membatasi algoritme HS256, issuer, audience, tipe token, waktu terbit, umur, kedaluwarsa, dan claim identitas sesi. Setiap request terlindungi juga memeriksa sesi aktif serta role/kategori terkini di PostgreSQL. Pencabutan sesi tidak menunggu JWT kedaluwarsa. Row lock pengguna menyelaraskan refresh, logout, perubahan password, dan penerbitan sesi agar operasi bersamaan tidak meninggalkan sesi yang seharusnya dicabut.

## Password dan pembatasan percobaan

Password baru berukuran 15–128 karakter dan di-hash Argon2id dengan memori 64 MiB, tiga iterasi, serta parallelism 1. Password tidak dipangkas atau dipotong diam-diam. Perubahan password memerlukan password saat ini dan mencabut seluruh sesi. Login memeriksa ulang hash password di dalam transaksi sebelum membuat sesi, sehingga password yang telah berubah tidak menerbitkan sesi berdasarkan pemeriksaan lama.

Maksimal empat operasi hash/verifikasi aktif per proses membatasi penggunaan memori Argon2 sekitar 256 MiB di luar overhead aplikasi. Kelebihan operasi menerima 503 `AUTH_BUSY`; kapasitas perlu diukur di mesin staging. Pesan login dibuat sama untuk akun tidak ditemukan, nonaktif, SSO-only, dan password salah. Tidak tersedia fitur lupa password atau pemulihan akun mandiri pada tahap ini.

Rate limit disimpan di Redis, per jendela 15 menit:

| Lingkup | Batas |
| --- | --- |
| Semua endpoint API per IP | 3.000 request |
| Login per IP | 300 request |
| Login per email ternormalisasi, lintas IP | 10 kegagalan; request sukses tidak menghabiskan kuota ini |
| Refresh per IP | 1.000 request |
| Refresh per hash token | 30 request |
| Perubahan password per pengguna | 5 request |

Kuota login dan refresh terpisah agar pegawai pada jaringan kantor yang sama tetap dapat memperbarui sesi. Pembatasan berbasis akun dapat membuat akun tertahan sementara jika diserang; pantau kejadian 429 dan ukur batas melalui uji beban. Header `Retry-After` memberi waktu tunggu untuk request yang dibatasi. Audit tidak menyimpan password atau token.

## Konfigurasi staging

1. Gunakan database PostgreSQL dengan PostGIS dan Redis staging terpisah dari lokal/produksi. Siapkan backup dan kredensial migrasi terpisah dari role runtime yang tidak memiliki hak pemilik/superuser.
2. Isi `JWT_SECRET` dengan secret acak sesuai `.env.example`. Untuk staging khusus login/admin, `BIOMETRIC_KEY_BASE64` dan `FACE_WORKER_TOKEN` boleh belum diisi. Operasi enrollment dan absensi mengembalikan `503 FACE_NOT_CONFIGURED` sampai key, worker, model, dan threshold lengkap. Untuk mengaktifkan biometrik, gunakan secret berbeda untuk ketiga variabel tersebut; template yang sudah terenkripsi tetap membutuhkan key asli. Jangan commit `.env`, memakai secret contoh, atau membagikannya di chat.
3. Tetapkan `NODE_ENV=production`, `SSO_ENABLED=false`, dan daftar origin web yang diizinkan pada `CORS_ORIGINS` bila digunakan. CORS bukan pengganti autentikasi Android.
4. Pasang reverse proxy dengan HTTPS. Isi `TRUST_PROXY` hanya dengan alamat IP/CIDR proxy sebenarnya, dipisahkan koma. Jangan mempercayai semua alamat. Proxy harus menimpa header forwarded dari klien, terutama `X-Forwarded-For` dan `X-Forwarded-Proto`, dan akses langsung publik ke port API harus dibatasi.
5. Startup Docker menjalankan migrasi tertunda secara default (`DB_MIGRATE_ON_START=true`). Untuk role runtime terbatas, jalankan migrasi terpisah menggunakan role migrasi, kemudian set flag tersebut ke `false`. Startup dari source tetap memerlukan `npm run db:migrate` secara default. Buat admin awal melalui `npm run admin:create`; jangan simpan `ADMIN_PASSWORD` setelah provisioning. Build dengan `npm run build` dan jalankan proses dengan secret environment yang benar. `npm start` membaca `.env` jika tersedia; container menerima environment runtime dan membaca `/app/.env` jika file tersebut dipasang.
6. Periksa `/health` untuk proses hidup dan `/ready/auth` untuk PostgreSQL beserta kolom autentikasi serta Redis. Endpoint kesehatan ini dapat dipanggil melalui HTTP pada jaringan privat. Request bisnis dengan `NODE_ENV=production` wajib terdeteksi sebagai HTTPS; header HTTPS dari proxy tak tepercaya ditolak.
7. Uji login HTTPS, profil, refresh, logout, logout-all, perubahan password, dan penolakan token lama dari Android staging. Hindari mencatat request body login atau Authorization pada proxy/platform pemantauan.

`/ready/auth` tidak menyatakan face recognition siap. `/ready` tetap menghasilkan 503 apabila worker/model belum siap. Koordinat, model, threshold, dan enrollment harus selesai sebelum menguji absensi operasional. Image Docker yang dibangun sebelum perubahan autentikasi harus dibangun ulang sebelum digunakan.

Keputusan autentikasi mengacu pada [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), dan [konfigurasi Express di balik proxy](https://expressjs.com/en/guide/behind-proxies.html). Pengujian lokal memvalidasi perilaku kode; konfigurasi TLS, jaringan, kapasitas, dan penyimpanan Android tetap perlu diverifikasi pada lingkungan staging sebenarnya.

## Migrasi: padanan Laravel

Express mengatur HTTP dan tidak menyediakan migrasi bawaan. Proyek ini memakai migrator SQL sendiri pada `src/database/migrate.ts`, digunakan bersama oleh startup Docker dan CLI `scripts/migrate.ts`. Image produksi menyediakan CLI terkompilasi melalui `npm run db:migrate:production`; tidak membutuhkan `tsx` atau dependency development.

| Laravel | Proyek ini |
| --- | --- |
| `database/migrations/` | `migrations/` |
| `php artisan migrate` | `npm run db:migrate` |
| Tabel `migrations` | Tabel `schema_migrations` |
| `Schema::create(...)` / `Schema::table(...)` | SQL `CREATE TABLE` / `ALTER TABLE` pada file migration |
| `make:migration` | Buat file SQL baru secara manual |
| `migrate:rollback` / `migrate:fresh` | Tidak tersedia |

Database baru memakai `001_initial_postgres.sql`, lalu `002_sso.sql` dan `003_office_coordinates.sql`. Database legacy tetap memakai baseline `001_initial.sql` tanpa perubahan checksum. Migrator memilih satu baseline otomatis dari ledger. Jalankan dari root proyek:

```powershell
npm run db:migrate
```

Perintah membaca `DATABASE_URL` dari environment/`.env`. Pastikan target koneksinya benar sebelum menjalankan. Migrator mengurutkan nama file SQL, memeriksa ledger dan checksum, lalu menjalankan file yang belum diterapkan. Advisory lock mencegah dua migrator berjalan bersamaan. Semua migrasi yang tertunda dan catatan ledger berada dalam satu transaksi: jika salah satu gagal, perubahan transaksi tersebut dibatalkan. Gunakan SQL yang dapat dijalankan dalam transaksi; operasi seperti `CREATE INDEX CONCURRENTLY` memerlukan prosedur deployment terpisah.

Untuk perubahan berikutnya, buat misalnya `migrations/013_add_employee_phone.sql`:

```sql
ALTER TABLE users ADD COLUMN phone_number text;
```

Jalankan kembali `npm run db:migrate`. File lama dilewati; perubahan pada file yang sudah diterapkan ditolak karena checksum berbeda. Jangan mengedit migration yang sudah digunakan lingkungan lain. Untuk membatalkan perubahan, buat migration koreksi baru setelah menilai kehilangan data dan kompatibilitas aplikasi. Backup tetap diperlukan sebelum perubahan yang menghapus atau mengubah data. Migrasi koordinat kantor adalah penambahan kompatibel; jangan menghapus kolom legacy atau extension sebagai bagian rollout ini.
