# Arsitektur backend

Backend menggunakan modular monolith: satu API Express dengan modul berdasarkan domain, serta proses worker ONNX terpisah. Struktur ini mempertahankan transaksi PostgreSQL lintas domain tanpa menambahkan komunikasi antarlayanan untuk operasi bisnis biasa.

```text
src/
  app.ts                       # Komposisi Express, middleware, dan router
  server.ts                    # Bootstrap koneksi, listener, dan shutdown
  config/
    env.ts                     # Validasi environment; diteruskan sebagai dependency
  database/
    client.ts                  # Pool PostgreSQL dan batas transaksi
    audit.ts                   # Penulisan audit dalam transaksi pemanggil
  docs/
    openapi.ts                 # Kontrak HTTP yang dipublikasikan
  middleware/
    error-handler.ts           # Pemetaan error ke respons HTTP
  modules/
    admin/
    attendance/
    auth/
    device/
    face/
    office/                     # Koordinat PostgreSQL, pengukuran Redis GEO
    sso/
  shared/
    errors/api-error.ts        # Error aplikasi tanpa dependency Express
    files/image-upload.ts     # Batas upload dan validasi gambar
    security/crypto.ts         # Hash, enkripsi template, dan signature
    validation/pagination.ts  # Skema pagination bersama
  worker/
    server.ts                  # HTTP internal dan lifecycle worker
    engine.ts                  # Session ONNX dan pipeline inferensi
    math.ts                    # Alignment, NMS, dan preprocessing
scripts/                       # Migrasi, bootstrap admin, build, dan pemeriksaan
migrations/                    # SQL terversi dengan checksum
tests/                         # Pengujian unit, kontrak worker, dan integrasi
```

## Tanggung jawab file dalam modul

| File | Tanggung jawab |
| --- | --- |
| `*.route.ts` | Mendaftarkan URL, middleware autentikasi/peran/upload, serta controller. |
| `*.controller.ts` | Membaca HTTP request, memvalidasi dengan schema, memanggil service, dan membentuk respons. |
| `*.schema.ts` | Skema Zod untuk body, query, dan parameter yang dimiliki modul. |
| `*.service.ts` | Aturan bisnis, orkestrasi, otorisasi domain, transaksi, serta koordinasi model. |
| `*.model.ts` | Fungsi akses data SQL terparameterisasi dan tipe row. Pada proyek ini perannya adalah repository, bukan model ORM. |
| `*.client.ts` | Adaptor layanan eksternal, saat domain membutuhkan integrasi tersebut. |
| `*.policy.ts` | Keputusan atau perhitungan domain yang dipakai beberapa alur. |
| `*.types.ts` | Kontrak yang perlu dipakai tanpa memuat implementasi HTTP/database. |

Tidak semua modul membutuhkan seluruh jenis file. Buat pemisahan hanya jika ada tanggung jawab nyata. Hindari base repository, controller generik, atau dependency injection framework sebelum ada kebutuhan yang terbukti.

## Batas dependency

- `app.ts` mengomposisikan router; `server.ts` mengelola proses. Import `app.ts` dalam tes tidak membuka listener sendiri.
- Service dan model tidak mengimpor controller atau route. Controller modul lain bukan API untuk komunikasi antardomain.
- Schema bersama seperti pagination berada di `shared`, sehingga modul absensi tidak harus mengimpor controller admin.
- Service boleh memakai service/domain helper modul lain. Data helper lintas modul dipakai secara eksplisit jika diperlukan untuk mempertahankan satu transaksi/row lock; model tidak membuka koneksi atau melakukan commit sendiri.
- Pemilik workflow menentukan batas transaksi dan meneruskan client transaksi ke data helper. Jangan mengganti client transaksi dengan pool di tengah operasi atomik.
- Worker bergantung pada utilitas bersama, bukan pada controller/service API. Kontrak HTTP antara API dan worker tetap eksplisit; API mengambil keputusan akhir absensi.
- `shared`, `database`, dan `config` tidak bergantung pada modul bisnis. Jangan menaruh aturan kategori/lokasi pada utilitas generik.
- Token aplikasi hanya diterbitkan oleh `auth.service.ts`; login lokal dan SSO memakai fungsi yang sama. Tidak ada implementasi penerbitan token kedua di root `src`.
- Tidak ada barrel compatibility di root yang mengekspor semua lapisan modul sekaligus. Gunakan import langsung ke file pemilik tanggung jawab.

`npm run check:architecture` memeriksa deklarasi import/export statis, dependency ke controller/route lintas modul, ketergantungan worker/infrastruktur pada modul API, dan siklus import runtime statis. Pemeriksaan ini melengkapi typecheck; bukan parser TypeScript penuh dan tidak memeriksa dynamic import.

## Build dan verifikasi

```powershell
npm run format:check
npm run typecheck
npm run check:architecture
npm test
npm run test:integration
npm run build
```

Build membersihkan hanya direktori `dist` milik proyek yang targetnya diverifikasi, lalu menjalankan compiler. Ini mencegah JavaScript lama dari lokasi file sebelum refactor ikut terbawa ke hasil build. Build tidak menjalankan migrasi. Startup image menjalankan migrasi ketika `DB_MIGRATE_ON_START=true`; mode manual memverifikasi seluruh checksum yang dibutuhkan sebelum membuka HTTP listener.

Refactor struktur tidak mengubah URL endpoint, matriks kategori-lokasi, radius 50 meter, perilaku signature/idempotency, atau kebijakan fail-closed. SSO dan biometrik tetap memerlukan konfigurasi operasional; respons 503 ketika layanan tersebut belum siap bukan error kompilasi.

PostgreSQL standar menjadi sumber data koordinat kantor. `office.geo.ts` menjalankan pengukuran Redis GEO atomik dari snapshot koordinat terbaru tanpa cache bersama; service kantor menerapkan izin kategori, urutan jarak/kode, akurasi, usia GPS, dan radius 50 meter. Redis diteruskan dari komposisi aplikasi sampai workflow absensi; model kantor hanya mengakses PostgreSQL.
