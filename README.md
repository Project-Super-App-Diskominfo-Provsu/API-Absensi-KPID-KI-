# API Sistem Absensi KPID/KI Sumatera Utara

Backend Express 5 dan TypeScript untuk aplikasi Android React Native. PostgreSQL/PostGIS menyimpan data dan menghitung radius; Redis menyimpan rate limit; worker ONNX menjalankan deteksi, alignment, embedding wajah 1:1, dan passive presentation attack detection (PAD).

Struktur modul, tanggung jawab setiap lapisan, dan aturan dependency dijelaskan pada [panduan arsitektur](docs/architecture.md). Modul menggunakan pemisahan route, controller, schema, service, dan model akses data. Infrastruktur, validasi bersama, dan worker dipisahkan dari handler HTTP bisnis.

## Status implementasi

Tersedia: autentikasi JWT dengan refresh rotation dan pencabutan keluarga sesi saat reuse, CRUD pegawai terbatas kewenangan, kategori KPID/KI, unit, konfigurasi tiga kantor, pengajuan/persetujuan perangkat Ed25519, jadwal aktual per tanggal kerja, enrollment 3–5 foto dengan persetujuan identitas, penghapusan template, check-in/check-out, idempotency persisten, nonce sekali pakai, riwayat, audit append-only, OpenAPI, health/readiness, dan worker ONNX.

Ketiga kantor di-seed **nonaktif tanpa koordinat**. Tidak ada akun atau password admin bawaan. Tidak ada model biometrik yang diunduh otomatis. Absensi belum dapat digunakan operasional sampai kantor, jadwal, perangkat, enrollment, model, dan threshold sudah siap.

Belum tersedia: persetujuan koreksi/manual, penyelesaian administratif status `NEEDS_REVIEW`, ekspor CSV/XLSX, impor massal, push notification, integrasi Play Integrity/SSO, object storage, serta uji akurasi/PAD dan benchmark dengan model operasional. Jangan menganggap target FAR/FRR atau p95 pada PRD telah terbukti. Foto hanya diproses di memori dan tidak disimpan; bukti visual untuk review belum tersedia.

## Aturan lokasi

| Kategori | Kantor yang diizinkan |
| --- | --- |
| KPID | DISKOMINFO_PROVSU, KPID_SUMUT |
| KI | DISKOMINFO_PROVSU, KI_SUMUT |

Semua radius tepat 50 meter. Masuk dan pulang boleh pada kantor berbeda yang diizinkan. Backend membaca kategori pengguna terkini dari database; role admin tidak memperluas izin lokasi absensi. Kantor nonaktif tidak dapat digunakan. Akurasi dan usia lokasi diatur terpisah per kantor setelah uji lapangan, tanpa memperbesar radius.

## Menjalankan lokal

Prasyarat: Node.js 24, npm, PostgreSQL 17 dengan PostGIS, serta Redis eksternal. `Dockerfile.postgres` tersedia untuk membangun image database dengan paket PostGIS; gunakan major version yang sesuai jika database sudah berisi data. Docker Compose diperlukan jika API dijalankan dalam container.

```powershell
npm ci
Copy-Item .env.example .env
```

Isi `DATABASE_URL` dan `REDIS_URL` ke layanan yang sudah tersedia serta isi `JWT_SECRET`. Login dan administrasi dapat berjalan tanpa `BIOMETRIC_KEY_BASE64` dan `FACE_WORKER_TOKEN`. Untuk mengaktifkan biometrik, isi keduanya dengan nilai acak yang berbeda dari `JWT_SECRET`, lalu lengkapi konfigurasi model dan threshold. Key biometrik yang tidak ada atau kosong menonaktifkan enrollment dan absensi dengan respons `503 FACE_NOT_CONFIGURED`; key nonkosong yang tidak dapat didekode menjadi 32 byte tetap ditolak saat startup. Gunakan kembali key asli untuk membaca template yang sudah dienkripsi. Perintah berikut menghasilkan satu nilai setiap dijalankan:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Lalu:

```powershell
npm run db:migrate
$env:ADMIN_EMAIL = 'admin@domain-instansi.go.id'
$env:ADMIN_NAME = 'Administrator'
$env:ADMIN_EMPLOYEE_NUMBER = 'ADMIN-001'
# Isi password yang dipilih pada environment lokal, minimal 15 karakter.
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Password admin awal' -AsSecureString)).Password
npm run admin:create
Remove-Item Env:ADMIN_PASSWORD
npm run dev
```

API berada di `http://localhost:3000`. Worker dijalankan di terminal terpisah dengan `npm run worker:dev`. `GET /health` hanya menandakan proses hidup. `GET /ready` mengembalikan 503 jika database, Redis, konfigurasi biometrik, atau worker belum siap. Endpoint autentikasi dan administrasi tetap dapat digunakan untuk menyiapkan sistem.

Compose menjalankan API dan menyediakan worker wajah opsional; tidak ada service atau volume database/Redis di deployment aplikasi. Database wajib mendukung PostGIS. Environment container harus menunjuk alamat layanan eksternal, bukan localhost container. Untuk layanan pada host Docker, gunakan `host.docker.internal`; untuk layanan remote, gunakan hostname remote. Image menyertakan migrator dan SQL; secara default startup Docker menerapkan migrasi tertunda sebelum membuka HTTP server. Role database harus memiliki izin migrasi dan menyiapkan PostGIS. Untuk memisahkan role migrasi dari role runtime, jalankan `npm run db:migrate:production` memakai role migrasi, lalu set `DB_MIGRATE_ON_START=false` pada API. Startup dari source tetap memakai migrasi manual secara default. Lihat [panduan Docker](docs/docker.md).

Panduan [login internal, staging, dan migrasi untuk pengguna Laravel](docs/internal-auth.md) menjelaskan konfigurasi HTTPS/proxy, masa berlaku token, endpoint password/logout, dan cara menambahkan migrasi. SSO tetap dinonaktifkan sampai konfigurasi Google tersedia. Gunakan `GET /ready/auth` untuk kesiapan database dan Redis pada staging khusus login; `/ready` tetap memeriksa worker wajah juga.

## Urutan menyiapkan data

1. Login sebagai super admin; buat unit dan pegawai dengan kategori yang tepat.
2. Ambil ID kantor melalui `GET /api/v1/admin/offices`. Tetapkan pasangan latitude/longitude yang diverifikasi di lapangan, `max_gps_accuracy_m`, dan `max_location_age_s`, kemudian `active: true` melalui PATCH kantor. Radius hanya menerima 50. Tidak ada koordinat perkiraan yang disediakan.
3. Buat jadwal pegawai melalui `POST /api/v1/admin/schedules`. `work_date` adalah tanggal WIB; `starts_at` dan `ends_at` harus berupa ISO datetime dengan offset. Implementasi awal mendukung satu jadwal per pegawai per tanggal WIB dan tidak mendukung shift lintas tanggal.
4. Android membuat pasangan kunci Ed25519, mengajukan perangkat, kemudian admin lain menyetujuinya. Approval mengganti perangkat aktif lama secara atomik.
5. Siapkan worker dan threshold; pegawai meminta challenge `ENROLL`, mengambil 3–5 foto berbeda, mencatat persetujuan pemrosesan, lalu mengajukan enrollment.
6. Admin lain memverifikasi identitas secara langsung/terawasi sebelum menyetujui template. Kunci perangkat dan template tidak bisa disetujui sendiri.
7. Pegawai meminta challenge `CHECK_IN`/`CHECK_OUT`, mengambil lokasi baru dan selfie, menandatangani payload, lalu mengirim absensi.

Admin biasa hanya mengelola pegawai/perangkat/enrollment berkategori sama dengan peran EMPLOYEE/VERIFIER. Pengelolaan kantor, unit, role istimewa, dan audit global hanya untuk SUPER_ADMIN. Tidak ada endpoint publik registrasi akun atau penggantian kategori sendiri.

## Kontrak React Native Android

Dokumen API tersedia melalui `GET /api/v1/openapi.json`. Prefix semua endpoint bisnis adalah `/api/v1`. Login dan refresh tidak memakai Bearer; endpoint lainnya memakai `Authorization: Bearer <access_token>`.

Simpan refresh token dan private key menggunakan penyimpanan aman Android. Backend tidak menerima private key. Integrasi library Ed25519 dan kemampuan secure storage pada perangkat target perlu diuji oleh tim mobile; mekanisme ini belum menyertakan hardware attestation atau Play Integrity.

Pembuatan challenge menggunakan **POST `/attendance/challenges`**, bukan GET pada draft awal. Body:

```json
{"device_id":"UUID perangkat aktif","purpose":"CHECK_IN"}
```

Respons menyertakan nonce, ID, waktu kedaluwarsa (90 detik), dan mode `PASSIVE_SERVER_PAD`. Mode ini memeriksa satu selfie di server; tidak mengklaim membuktikan instruksi kedip/tengok. Pengambilan aktif berbasis video belum diimplementasikan.

Upload JPEG/PNG maksimum 5 MiB per file, satu frame, dimensi 112–4096 piksel, maksimum 16 juta piksel. `images` enrollment terdiri atas 3–5 file berbeda; `image` absensi satu file. Jangan mengirim `employee_category`, skor wajah, jarak, atau boolean hasil liveness sebagai penentu verifikasi.

### Tanda tangan perangkat

Semua tanda tangan berupa Ed25519 atas byte UTF-8 payload, dikirim sebagai base64. Public key menggunakan format PEM SPKI. SHA-256 memakai hex lowercase. Hash file dihitung dari **byte file yang benar-benar diunggah**, tanpa diubah setelah ditandatangani.

Pengajuan binding menggunakan payload literal berikut tanpa newline:

```text
bind:<user_id>:ANDROID:<sha256(public_key_PEM)>
```

Enrollment menggunakan payload berikut. Urutan hash mengikuti urutan file pada multipart:

```text
enroll:<user_id>:<device_id>:<nonce>:<consent_version>:<image1_sha256>:<image2_sha256>:<image3_sha256>
```

Untuk 4–5 foto, tambahkan hash berikutnya dengan pemisah `:`. Body enrollment menyertakan `consent: "true"` dan `consent_version`.

Absensi memakai `JSON.stringify` atas object **dengan urutan properti berikut**, tanpa whitespace tambahan:

```javascript
const payload = JSON.stringify({
  user_id,
  purpose,                  // "CHECK_IN" atau "CHECK_OUT"
  idempotency_key,
  device_id,
  nonce,
  latitude: Number(latitude),
  longitude: Number(longitude),
  accuracy_m: Number(accuracy_m),
  captured_at,              // string ISO persis yang dikirim
  office_id: office_id ?? null,
  is_mock: is_mock ?? "false", // string, bukan boolean
  image_sha256
});
```

Nilai latitude/longitude/accuracy pada multipart adalah string desimal biasa, tanpa notasi eksponen. `signature` tidak ikut ditandatangani. `Idempotency-Key` berisi 16–100 karakter huruf, angka, `_`, atau `-`; UUID bisa digunakan. `office_id` opsional. Jika tidak diisi, server memilih kantor aktif yang diizinkan, memenuhi kualitas GPS, dan berada dalam radius, berdasarkan jarak lalu kode kantor.

Jika koneksi terputus, ulangi **file, semua field, dan key yang sama** untuk mendapatkan hasil tersimpan. Jangan mengubah timestamp atau mengambil selfie baru dengan key lama. HTTP 202 `PROCESSING` berarti tunggu dan cek `GET /attendance/attempts/:id`; `NEEDS_REVIEW` berarti belum ada absensi sah. Key sama dengan isi berbeda menghasilkan 409 `IDEMPOTENCY_CONFLICT`. Challenge terpakai tidak dapat dipakai untuk operasi baru.

Jam absensi adalah waktu server menerima request yang lolos parsing/upload; waktu selesai inferensi tidak membuat pegawai terlambat. Maksimum usia GPS tetap diperiksa. Retry identik mengembalikan waktu dan hasil awal. Tidak ada mode offline.

Format error:

```json
{"error":{"code":"OFFICE_NOT_ALLOWED","message":"Kategori pegawai tidak diizinkan di kantor ini."},"request_id":"UUID"}
```

## Worker wajah dan model

Worker memuat tiga file ONNX pada startup: SCRFD dengan lima landmark, ArcFace embedding 512 dimensi, dan classifier PAD. File model serta lisensi penggunaannya disediakan operator. Source library berlisensi terbuka tidak otomatis memberi izin memakai bobot model. Lihat [kebijakan model InsightFace](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md).

Salin `docs/face-manifest.example.json` ke lokasi lokal, isi checksum dan lisensi masing-masing model, lalu set `FACE_MANIFEST_PATH`. Semua path pada manifest relatif terhadap lokasi manifest. Jangan memakai contoh preprocessing sebagai bukti bahwa suatu model kompatibel: input/output, warna, mean/divisor, kelas live, dan crop harus sesuai dokumentasi model yang dipilih.

Kontrak yang didukung:

- SCRFD input NCHW float32 640×640, RGB `(pixel-127.5)/128`, resize mempertahankan rasio dan padding kanan/bawah. Tiga stride 8/16/32, dua anchor tiap sel, masing-masing output skor, jarak bounding box, dan sepuluh koordinat landmark. Isi nama output sesuai model.
- ArcFace input NCHW 112×112 setelah alignment similarity lima titik; warna dan normalisasi eksplisit dalam manifest. Output tepat 512 angka.
- PAD input NCHW dari bounding box yang diperluas `crop_scale`, dipotong pada batas gambar, lalu di-resize. Manifest menentukan warna, normalisasi, kelas live, serta output logits/probabilities. Model yang membutuhkan crop/pipeline lain perlu adaptor dan pengujian tersendiri.
- `quality_score` adalah minimum rasio ukuran wajah dan varians Laplacian terhadap referensi pada manifest, dibatasi 0–1. Ini indikator kualitas implementasi, bukan probabilitas atau metrik vendor.

Konfigurasikan `FACE_MODEL_VERSION` sama dengan manifest dan empat threshold API dari hasil pilot. Tidak ada threshold acceptance bawaan. Perubahan bobot atau preprocessing memerlukan model version baru dan enrollment ulang. Template dienkripsi AES-256-GCM dengan AAD user ID; kunci enkripsi disimpan terpisah dari database. Template saja tidak dapat dihitung ulang menjadi embedding model lain setelah foto mentah dihapus.

Worker terproteksi shared token dan harus ditempatkan pada jaringan privat/TLS saat dihosting. Endpoint internal `POST /v1/observe` menerima multipart `image` dan `nonce`, mengembalikan embedding, model version, skor kualitas/PAD, nonce, dan hash gambar. API memvalidasi identitas request dan memutuskan similarity sendiri. API membatasi panggilan bersamaan, worker memproses satu inferensi setiap saat, dan kelebihan beban menghasilkan 503 tanpa menerima absensi.

Passive PAD, signature perangkat, dan flag mock bukan jaminan kamera/lokasi asli. Uji foto cetak, layar, video, injeksi media, kondisi cahaya, perangkat target, serta kesalahan GPS diperlukan sebelum digunakan operasional. Nonce mengikat operasi jaringan; nonce tidak membuktikan umur isi foto secara mandiri.

## Pengujian

```powershell
npm run typecheck
npm run check:architecture
npm test
npm run test:integration
npm run build
npm audit
```

Tes integrasi membuat database acak terpisah pada server PostgreSQL lokal lalu menghapus database uji tersebut. Tidak mengosongkan database aplikasi atau Redis. Opsional: set `TEST_DATABASE_URL` untuk server uji yang mengizinkan CREATE DATABASE dan `TEST_REDIS_URL` untuk Redis uji. Jangan gunakan kredensial produksi untuk tes ini.

Tes ONNX menghasilkan graph konstan hanya dalam direktori sementara, menjalankan ONNX Runtime sebenarnya, lalu menghapusnya. Fixture tersebut tidak dipakai server aplikasi dan tidak membuktikan akurasi biometrik. API tests menggunakan FaceEngine fixture hanya melalui dependency injection pada kode tes; tidak ada environment flag untuk meloloskan wajah di aplikasi.

## Catatan operasional

- Waktu tersimpan sebagai timestamptz; tanggal kerja dihitung dalam Asia/Jakarta. Jadwal belum otomatis digenerasikan dari kalender kerja.
- Percobaan valid yang masuk alur absensi disimpan, termasuk penolakan dan kegagalan worker. Request yang ditolak sebelum parsing/auth/upload dicatat sebagai request metadata, bukan attendance attempt.
- Request yang terputus saat status PROCESSING tidak dapat membuat absensi kedua. Retry setelah 60 detik menutup percobaan yang belum selesai sebagai ERROR; hasil lama tetap dilindungi constraint database.
- Redis tidak menyimpan hasil idempotency. PostgreSQL menjadi sumber kebenaran nonce, attempt, dan absensi sehingga restart Redis tidak menghapus perlindungan duplikasi.
- Audit tidak menyimpan password, token, foto, atau embedding. Trigger mencegah update/delete audit biasa; deploy produksi tetap memerlukan role database runtime tanpa hak pemilik/superuser dan kredensial migrasi terpisah.
- Retensi/penghapusan backup, pemulihan, provisioning secret, dan kebijakan data biometrik operasional harus diselesaikan sebelum rollout. Fitur reset menghapus template pada database aktif; bukan klaim menghapus salinan backup.
- OpenAPI saat ini disimpan sebagai dokumen TypeScript dan divalidasi otomatis. Generasi seluruh kontrak dari Zod serta contoh respons per endpoint belum selesai.
