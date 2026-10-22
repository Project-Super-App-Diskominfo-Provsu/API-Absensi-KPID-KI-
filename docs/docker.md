# Docker aplikasi dengan database dan Redis eksternal

`Dockerfile` membuat satu image multi-stage yang dipakai API dan worker ONNX. Runtime menggunakan user non-root. `compose.yaml` hanya berisi service `api` dan `face-worker` dengan profil opsional `biometrics`. Tidak ada database, Redis, atau volume data keduanya pada Compose aplikasi.

## Menjalankan API

1. Salin `.env.example` menjadi `.env` jika belum ada. Isi secret serta alamat PostgreSQL dengan PostGIS dan Redis 7+ yang sudah tersedia. Jangan menimpa `.env` yang telah dikonfigurasi.
2. Pastikan database dapat diakses dari mesin yang menjalankan migrasi dan dari jaringan Docker. Jika layanan berada pada host Docker, alamat dari dalam container adalah `host.docker.internal`, bukan `localhost`. Untuk layanan remote, gunakan hostname layanan. PostgreSQL harus menyediakan paket PostGIS dan role migrasi perlu izin mengaktifkan extension, atau DBA mengaktifkannya terlebih dahulu; role runtime sebaiknya terpisah tanpa hak pemilik/superuser. Batasi akses database/Redis melalui jaringan privat dan autentikasi.
3. Image menyertakan migrator dan file SQL. Secara default Docker memakai `DB_MIGRATE_ON_START=true`: migrasi tertunda dijalankan sebelum HTTP server dibuka, termasuk inisialisasi database kosong. Role pada `DATABASE_URL` harus memiliki izin membuat/mengubah skema. Untuk role runtime terbatas, jalankan migrasi secara terpisah menggunakan role migrasi melalui `npm run db:migrate:production` pada image, lalu set `DB_MIGRATE_ON_START=false` pada API. Alternatif dari source tetap tersedia melalui `npm ci` dan `npm run db:migrate`. Jalankan `npm run admin:create:production` di image atau `npm run admin:create` dari source untuk provisioning admin awal jika belum ada. CLI memerlukan `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_EMPLOYEE_NUMBER`, dan `ADMIN_PASSWORD` (minimal 15 karakter). Masukkan password melalui secret environment sementara dan hapus sesudah provisioning; jangan menaruhnya di command line/log atau environment permanen aplikasi.
4. Pastikan port host 3000 belum dipakai proses API lokal. Bila masih dipakai, tentukan `API_HOST_PORT=3001` pada `.env`.
5. Jalankan:

```powershell
docker compose build api
docker compose up -d --wait api
docker compose ps
```

API mengikat port host pada loopback saja: `127.0.0.1:3000` secara default. Pasang reverse proxy HTTPS pada host dan isi `TRUST_PROXY` dengan IP/CIDR proxy yang benar-benar dilihat container. Jangan mengasumsikan IP proxy selalu `127.0.0.1`: koneksi melalui bridge Docker dapat terlihat sebagai alamat gateway. Compose memaksa `NODE_ENV=production`; endpoint bisnis menolak HTTP tanpa proxy HTTPS tepercaya. Health check privat memakai `/ready/auth` untuk database dan Redis, sehingga staging login tidak menunggu model wajah.

`docker compose config --quiet` memvalidasi konfigurasi tanpa mencetak environment berisi secret. Jangan membagikan output penuh `docker compose config`, `docker inspect`, atau log proxy yang memuat kredensial.

## Environment runtime dan Dokploy

Compose memetakan variabel aplikasi secara eksplisit dari environment proses Compose atau file `.env` ke container API. Tiga variabel wajib (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`) yang hilang atau kosong menghentikan Compose sebelum container dibuat. `BIOMETRIC_KEY_BASE64` yang hilang atau kosong tetap mengizinkan startup login/admin, tetapi enrollment dan absensi mengembalikan `503 FACE_NOT_CONFIGURED`. Key nonkosong tetap wajib dapat didekode menjadi 32 byte. Environment proses Compose mempunyai prioritas atas `.env`; periksa apakah ada variabel shell lama yang menimpa nilai file.

Jika deployment menggunakan Dokploy dengan build type Dockerfile, isi variabel pada environment runtime aplikasi, simpan, lalu redeploy/recreate container. Build arguments saja tidak mengisi `process.env` aplikasi. File `.env` sengaja dikecualikan melalui `.dockerignore` dan tidak disalin ke image. Jika menggunakan deployment Compose, gunakan `compose.yaml` ini dan pastikan environment deployment tersedia untuk interpolasi Compose.

Startup API dan worker menggunakan `--env-file-if-exists`: image membaca `/app/.env` jika file tersebut tersedia saat runtime, misalnya melalui file mount read-only. `npm start` dan `npm run worker:start` membaca `.env` pada working directory. Environment container tetap mempunyai prioritas atas isi file, termasuk nilai kosong. File tidak wajib tersedia jika semua variabel telah diinjeksi sebagai environment. Variabel wajib yang tidak ditemukan pada kedua sumber tetap membuat startup gagal.

CMD Docker sebelumnya menjalankan `node dist/server.js` sehingga `.env` yang tersedia di container tidak dibaca, berbeda dari `npm start`. Dukungan pembacaan file ini memperbaiki ketidakkonsistenan tersebut. File `.env` yang hanya dibuat pada host/build context Dokploy tetap harus dipasang ke `/app/.env` atau diteruskan sebagai environment runtime; flag Node tidak menyalin file dari host. Deployment Application Dockerfile tidak menggunakan `compose.yaml`.

Untuk Docker langsung, berikan file saat membuat container:

```sh
docker build -t absensi-api:local .
docker run -d --name absensi-api --env-file .env -p 127.0.0.1:3000:3000 absensi-api:local
```

Alamat database/Redis harus dapat dijangkau dari jaringan container. Jika keduanya berada di jaringan Docker privat, tambahkan `--network NAMA_JARINGAN` yang sama. Untuk hostname layanan pada Dokploy, gunakan jaringan tempat layanan tersebut terhubung.

Pada versi lama, error `expected string, received undefined` pada `BIOMETRIC_KEY_BASE64` menghentikan seluruh API ketika key tidak ada di environment proses Node. Sekarang key hilang atau kosong menonaktifkan operasi biometrik tanpa menghentikan login/admin. `/ready/auth` memeriksa database dan Redis; `/ready` tetap mengembalikan 503 jika konfigurasi biometrik atau worker belum siap. Baris komentar `# BIOMETRIC_KEY_BASE64=` tidak menimpa nilai aktif pada parser env standar. Hindari nama variabel aktif yang sama lebih dari sekali.

Periksa hanya status variabel, tanpa mencetak nilainya:

```sh
docker compose exec api node -e 'for (const k of ["DATABASE_URL","REDIS_URL","JWT_SECRET","BIOMETRIC_KEY_BASE64"]) console.log(k + ": " + (process.env[k] === undefined ? "missing" : process.env[k] === "" ? "empty" : "set"))'
```

Jika container terus restart, jalankan pemeriksaan pada container sekali jalan:

```sh
docker compose run --rm --no-deps api node -e 'const v = process.env.BIOMETRIC_KEY_BASE64; console.log("BIOMETRIC_KEY_BASE64: " + (v === undefined ? "missing" : v === "" ? "empty" : Buffer.from(v, "base64").length === 32 ? "set, decodes to 32 bytes" : "invalid length"))'
```

Untuk deployment Dockerfile, jalankan pemeriksaan melalui terminal container platform atau ganti `docker compose exec api` dengan `docker exec NAMA_CONTAINER`. Setelah mengubah environment, buat ulang container; `docker restart` saja tetap memakai environment container lama:

```sh
docker compose config --quiet
docker compose up -d --build --force-recreate --wait api
```

Jangan mengganti key biometrik secara otomatis ketika variabel hilang: template wajah yang sudah dienkripsi memerlukan key lama agar dapat dibaca.

## Migrasi saat startup

`DB_MIGRATE_ON_START=true` adalah default image dan Compose. Startup dari source memakai default `false` agar alur migrasi manual tetap tersedia. Flag ini tidak membuat database PostgreSQL baru; database pada `DATABASE_URL` harus sudah ada dan dapat diakses. Migration 004 mengaktifkan extension PostGIS. Paket PostGIS harus sudah diinstal pada server database oleh DevOps; image API tidak memasang paket pada server database eksternal.

Migrator memakai advisory lock PostgreSQL yang sama untuk semua replica dan CLI, ledger `schema_migrations`, serta checksum SHA-256. File yang sudah diterapkan dilewati. Seluruh migrasi tertunda dan perubahan ledger dijalankan dalam satu transaksi; kegagalan membatalkan transaksi dan menghentikan startup. Restart tidak menghapus data atau mengulang seed. Jangan mengubah SQL yang sudah diterapkan.

Database yang sudah berisi tabel aplikasi tetapi tidak memiliki ledger tidak diadopsi otomatis: konflik tabel menghentikan migrasi dan transaksi dibatalkan. Periksa riwayat skema sebelum menentukan baseline; jangan menghapus tabel atau menandai migrasi sebagai selesai tanpa verifikasi. Perubahan skema yang sudah berhasil di-commit tidak dibatalkan oleh rollback image Docker. Untuk rollback skema, gunakan migrasi koreksi yang telah ditinjau atau pemulihan backup.

Jika mode otomatis dimatikan, startup memeriksa nama dan checksum setiap file migrasi yang dibutuhkan image. Ledger kosong, migrasi tertunda, atau checksum berbeda menghentikan startup. Entri migrasi tambahan dari image yang lebih baru diperbolehkan agar rollback image tetap mungkin selama skema bersifat additive dan kompatibel. Jika skema belum tersedia, startup mencatat instruksi untuk menjalankan `db:migrate:production` atau mengaktifkan flag tersebut. Pada Dokploy Application Dockerfile, default flag berasal dari image, sehingga tidak perlu bergantung pada Compose untuk menjalankan inisialisasi database.

## PostgreSQL dengan PostGIS dan Setup Container untuk DevOps

PostGIS diperlukan untuk validasi geofencing poligon kantor. PostgreSQL/PostGIS dapat dijalankan sebagai container mandiri menggunakan `compose.postgres.yaml`; Redis tetap layanan eksternal. Password PostgreSQL wajib diberikan dan port host hanya diikat pada loopback. Hubungkan API ke jaringan privat database melalui Dokploy untuk komunikasi antar-container.

### Menyiapkan dan Mem-push Image PostgreSQL + PostGIS (DevOps)

Tersedia `Dockerfile.postgres` berbasis PostgreSQL 17 Bookworm yang sudah dilengkapi paket PostGIS 3 serta skrip inisialisasi otomatis (`scripts/init-postgis.sh` -> `/docker-entrypoint-initdb.d/10_postgis.sh`) agar extension `postgis` langsung aktif saat database baru dibuat.

1. **Build dan Tag Image:**
   ```bash
   docker build -t registry.example.com/absensi/postgres-postgis:17 -f Dockerfile.postgres .
   ```
2. **Push ke Container Registry:**
   ```bash
   docker push registry.example.com/absensi/postgres-postgis:17
   ```
3. **Menjalankan di Server (Docker Compose):**
   Gunakan file `compose.postgres.yaml` yang sudah disediakan:
   ```bash
   docker compose -f compose.postgres.yaml up -d
   ```
   Atau definisikan variabel environment:
   - `POSTGRES_USER`: Username admin database (default: `absensi`)
   - `POSTGRES_PASSWORD`: Password database
   - `POSTGRES_DB`: Nama database (default: `absensi`)
   - `POSTGRES_PORT`: Port host yang dipetakan (default: `55432`)

Periksa extension melalui query DBA ke database target:

~~~sql
SELECT name, installed_version FROM pg_available_extensions WHERE name='postgis';
SELECT PostGIS_Version();
~~~

### Migrasi Geofencing Poligon (Migration 005)

- Migration `005_office_polygon.sql` menambahkan kolom `polygon geometry(Polygon, 4326)` pada tabel `offices` beserta spatial index GiST.
- Kantor yang sudah memiliki koordinat titik mendapat backfill polygon; status aktif dipertahankan. Migration 006 memastikan buffer default mengikuti kebijakan 50 meter. Uji upgrade di staging sebelum deployment.
- Query geofencing memerlukan `ST_Covers(o.polygon, point)` dan `ST_DWithin(center::geography, point::geography, 50)`. `ST_Distance` menghitung jarak pegawai dari pusat kantor, termasuk ketika pegawai berada dalam polygon.

## Worker wajah opsional

Untuk staging login saja, profil ini tidak perlu diaktifkan. API tetap menolak operasi wajah ketika worker belum tersedia. Untuk mengaktifkan biometrik:

1. Siapkan direktori `models` berisi `manifest.json` dan bobot model yang sah. Path relatif pada manifest dihitung dari direktori manifest; misalnya `recognition.onnx` menunjuk `/app/models/recognition.onnx` di dalam container. Path absolut, jika digunakan, harus menunjuk lokasi di dalam container. Konfirmasikan izin baca untuk user non-root container.
2. Isi `BIOMETRIC_KEY_BASE64` dan `FACE_WORKER_TOKEN` pada `.env` serta versi dan threshold API dari hasil kalibrasi. Compose memasang direktori model read-only, menentukan manifest `/app/models/manifest.json`, dan menghubungkan API ke `http://face-worker:8000` pada jaringan Compose.
3. Jalankan:

```powershell
docker compose --profile biometrics up -d --build --wait
```

Worker tidak memublikasikan port ke host. Health check worker memeriksa model melalui `/ready` dengan autentikasi. Model atau manifest yang belum valid membuat worker tidak ready; proses yang hidup saja tidak membuktikan model siap.

Container menggunakan filesystem read-only, direktori sementara di memori, seluruh capability tambahan dibuang, dan privilege escalation dinonaktifkan. API mempunyai waktu shutdown 20 detik untuk menyelesaikan penutupan koneksi. Ukur penggunaan RAM worker dan Argon2 pada staging sebelum menentukan limit resource platform.

## Pengujian dan layanan yang sudah berjalan

CI menjalankan alur API pada PostgreSQL/PostGIS dan Redis, termasuk pengujian upgrade baseline numeric serta legacy. Service CI bukan bagian deployment aplikasi. Tes lokal memerlukan TEST_DATABASE_URL dan TEST_REDIS_URL ke layanan uji tersendiri jika berbeda dari default tes; akun PostgreSQL uji membutuhkan hak membuat database dan mengaktifkan PostGIS. Isi TEST_LEGACY_DATABASE_URL untuk membuktikan backfill, checksum, dan penulisan dua arah selama rollback; CI menjalankan skenario tersebut. Jangan gunakan akun produksi.

Perubahan Compose tidak menghentikan container database/Redis lama dan tidak menghapus volume lama. Jika layanan lama masih dipakai untuk data lokal, tentukan pemindahan dan backup secara terpisah. Jangan menjalankan `docker compose down --remove-orphans` atau menghapus volume tanpa memastikan data sudah aman.

## Runbook produksi Dokploy

Gunakan Application dengan build type **Dockerfile**, context root repository, dan `Dockerfile` utama; atau gunakan deployment Compose dengan file `compose.yaml`. Pilih satu jalur. Image memakai Node.js 24 dan tidak membutuhkan dependency development pada runtime. Pengaturan runtime berikut berlaku pada kedua jalur:

1. Pada environment runtime, isi `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `DB_POOL_MAX`, `CORS_ORIGINS`, dan `TRUST_PROXY` sesuai instalasi. Jangan mengisi secret sebagai build argument. File `.env` opsional; environment proses, termasuk nilai kosong, mempunyai prioritas. CLI source dan production sekarang sama-sama dapat berjalan tanpa file `.env` jika environment sudah diinjeksi.
2. Hubungkan aplikasi ke jaringan privat yang sama dengan PostgreSQL/Redis. Gunakan hostname internal layanan Dokploy. URL harus memakai `postgresql://`/`postgres://` dan `redis://`/`rediss://`; percent-encode karakter khusus pada username/password. Untuk layanan TLS, pakai verifikasi sertifikat yang valid; jangan menonaktifkan verifikasi TLS secara global.
3. Atur domain HTTPS dengan port tujuan **3000** (Application dapat memakai `PORT` lain). Isi `TRUST_PROXY` hanya dengan alamat/CIDR Traefik yang benar-benar terlihat oleh API. Jangan memakai `true`, `1`, atau seluruh jaringan publik. Verifikasi HTTPS melalui domain: health check lokal bisa sehat walaupun konfigurasi proxy endpoint bisnis salah. Pada Compose, konfigurasi domain harus menunjuk service `api` port 3000 dan jaringan proxy harus terhubung ke service tersebut.
4. Backup database dan simpan key biometrik asli sebelum rollout. Pilihan role terpisah: jalankan `npm run db:migrate:production` sebagai release job pada image baru memakai kredensial migrasi, lalu jalankan API dengan kredensial runtime dan `DB_MIGRATE_ON_START=false`. Role runtime membutuhkan CONNECT, USAGE schema, SELECT/INSERT/UPDATE pada tabel bisnis yang diperlukan, SELECT/INSERT saja pada audit_logs, SELECT pada schema_migrations, serta USAGE/SELECT sequence audit. PostGIS harus disiapkan oleh DBA/role migrasi. Jangan beri hak DDL atau kepemilikan tabel kepada role runtime. Provisioning admin juga memerlukan INSERT audit. Alternatif deployment sederhana tetap mendukung auto-migration dengan role berizin.
5. Health check image memanggil `/ready/auth`, dengan startup grace 180 detik untuk migrasi. Sesuaikan health/startup/rollout timeout Dokploy agar tidak mematikan container saat migrasi. Jika image yang sama dipakai sebagai worker Application terpisah, override command ke `npm run worker:start` dan override health check ke port 8000 `/ready` dengan Bearer token; health check bawaan image ditujukan untuk API. Worker hanya boleh di jaringan privat dan perlu mount model read-only.
6. Sesudah deploy, pastikan `/ready/auth` HTTP 200, login melalui HTTPS berhasil, refresh/logout berjalan, dan IP rate limiter sesuai client. Untuk aktivasi absensi, `/ready` juga harus HTTP 200 dengan model dan threshold terkalibrasi; health autentikasi saja belum membuktikan biometrik siap.

`DB_POOL_MAX` default 15 per proses API, idle connection ditutup setelah 30 detik, waktu koneksi 5 detik, query runtime 10 detik, dan transaksi idle 15 detik. Hitung total pool semua replica **termasuk replica lama saat rollout**, lalu sisakan koneksi bagi migrasi, monitoring, backup, dan aplikasi lain. CLI migrasi/admin memakai maksimum satu koneksi. Jangan menaikkan pool sebelum mengukur antrean dan kapasitas PostgreSQL.

Migrasi menggunakan statement timeout 120 detik per statement dan lock timeout 60 detik di dalam transaksi; pengaturan tidak terbawa ke query runtime. Migrasi yang lebih lama memerlukan perencanaan terpisah. Tidak ada SQL lama yang diubah atau down migration destruktif otomatis. Migrasi additive yang sukses tetap ada saat rollback image; verifikasi kompatibilitas versi lama di staging sebelum rollback. Jika migrasi gagal, transaksi dibatalkan dan deployment harus dihentikan/diperbaiki sebelum retry.

Redis membatasi antrean tulis 3 detik dan socket tanpa respons 3 detik (heartbeat 1 detik saat idle), antrean maksimum 1000, dan menolak command saat offline. Reconnect otomatis dibatasi 10 retry dengan jeda sampai 3 detik; kegagalan startup menutup pool dan keluar agar restart policy bekerja. Jika retry koneksi habis setelah startup, readiness menjadi gagal dan operator/platform perlu me-restart container setelah layanan pulih. Rate limiting tetap fail-closed; kegagalan Redis tidak meloloskan request tanpa limit. Gunakan instance/database Redis terpisah per environment untuk menghindari saling memengaruhi rate limit. Atur kapasitas memory dan monitoring; kebijakan `noeviction` menghindari penghapusan key rate limit dini, tetapi memory penuh akan menolak request. Restart/kehilangan data Redis mereset counter rate limit; gunakan persistence sesuai kebutuhan operasional. Nonce dan idempotency tetap aman di PostgreSQL.

Pantau readiness, restart, 5xx/429, durasi request, pool/connection PostgreSQL, lock, slow query, Redis memory/eviction, disk/WAL, serta backup. Uji restore ke database terpisah. Retensi data sesi, challenge, attempt, audit, dan backup perlu kebijakan instansi; tidak ada penghapusan otomatis pada perubahan ini. Jangan menghapus refresh session lama sembarangan karena row yang revoked masih dipakai mendeteksi token reuse selama keluarga sesi berlaku. Sizing resource dan target latency harus dibuktikan dengan data dan beban representatif sebelum rollout penuh.

## Port API lokal sudah dipakai

Jika startup melaporkan EADDRINUSE, hentikan server API lama pada terminal asal dengan Ctrl+C, lalu jalankan npm run dev kembali. Periksa pemilik port di PowerShell dengan Get-NetTCPConnection -LocalPort 3000 -State Listen. Jangan menghentikan proses lain sebelum mengenali pemiliknya. Alternatif lokal: ubah PORT ke port bebas; untuk Compose ubah API_HOST_PORT. Log berhasil startup hanya dicetak setelah listener benar-benar terbuka.

## Aturan kantor dan buffer 50 meter

Migration 006 mencatat alamat Diskominfo Provsu (Jl. HM. Said No.27), KPID Sumut (Jl. Adinegoro No.7), dan KI Sumut (Jl. Alfalah No.22). Pusat absensi harus berupa latitude/longitude yang diverifikasi. PATCH /api/v1/admin/offices/{id} dengan pasangan koordinat membentuk polygon geography buffer 50 meter pada server. Radius selain 50 ditolak. Polygon menggunakan quad_segs=64; keputusan akhir juga memakai ST_DWithin geography 50 meter agar pendekatan bentuk polygon tidak memperluas batas maksimum. Titik pusat yang berubah membentuk ulang polygon, termasuk penulisan melalui jalur legacy.

Area custom tetap dapat mempersempit area absensi; seluruh interior ring dipertahankan dan polygon tidak valid ditolak. Lokasi hanya diterima jika berada dalam polygon dan maksimal 50 meter dari titik pusat. Aturan kategori tetap KPID: Diskominfo/KPID; KI: Diskominfo/KI. Konfigurasi tidak meloloskan kategori lain meskipun posisi berada dalam polygon kantor tersebut.


### Pusat kantor dari pin Google Maps (21 Oktober 2026)

Koordinat berikut menggunakan titik tempat pada tautan Google Maps yang diberikan pengguna, bukan pusat viewport peta. Urutan kolom: latitude, longitude.

| Kantor | Latitude | Longitude | Sumber |
| --- | --- | --- | --- |
| Diskominfo Provsu | 3.601785 | 98.682827 | [Pin Diskominfo](https://maps.app.goo.gl/VSY7gHx8Z6TsC2CA9) |
| KPID Sumut | 3.601287 | 98.6823199 | [Pin KPID](https://maps.app.goo.gl/QxJFYrK3XUDHjVPdA) |
| KI Sumut | 3.5464663 | 98.6946129 | [Pin KI](https://maps.app.goo.gl/DUhWXSKG119ffTfi8) |

Migration 007 mengisi pusat kantor yang belum memiliki koordinat maupun polygon. Trigger migration 006 otomatis membuat polygon buffer 50 meter. Koordinat atau polygon yang sudah dikonfigurasi admin dipertahankan; untuk kantor tersebut, admin perlu menyelaraskan pusat melalui endpoint PATCH kantor jika diperlukan. Jalankan migrasi dengan npm run db:migrate (lokal) atau npm run db:migrate:production (hasil build).

Migration ini tidak mengaktifkan kantor atau mengisi batas akurasi/umur lokasi GPS. Admin harus menentukan kebijakan GPS dan mengaktifkan kantor sebelum absensi digunakan. Kebijakan kategori tetap: KPID boleh di Diskominfo dan KPID; KI boleh di Diskominfo dan KI. Izin kategori diperiksa bersama polygon dan batas jarak geography 50 meter. Polygon antar kantor yang berdekatan dapat beririsan; sistem menentukan kantor dari lokasi dan izin kategori pengguna. Ketepatan pin terhadap titik absensi fisik tetap perlu diuji di lokasi.


## Perbaikan QA 22 Oktober 2026: checksum, enrollment, dan jadwal

Migrator menulis checksum LF untuk migrasi baru. Saat memeriksa ledger lama, migrator menerima checksum dari isi SQL yang sama dengan line ending LF atau CRLF. Checksum ledger lama tidak diubah, migrasi lama tidak dijalankan ulang, dan perubahan isi SQL tetap ditolak. Git mengunci migrations/*.sql ke LF. Jangan mengedit SQL historis atau mengganti checksum ledger secara manual untuk melewati pemeriksaan.

Migration 008 menambahkan users.face_enrollment_version dengan nilai awal 0 tanpa mengubah template lama. Enrollment membaca versi saat mulai, lalu memeriksa ulang versi, akun, perangkat, dan template ACTIVE/PENDING di dalam transaksi sebelum menyimpan hasil inferensi. Reset admin dan penyimpanan enrollment baru menaikkan versi. Request yang kehilangan versi menerima HTTP 409 FACE_ENROLLMENT_CHANGED; mobile harus memulai enrollment baru dengan challenge baru. Template yang muncul dari writer lain juga ditolak dengan FACE_ALREADY_ENROLLED.

Migration 009 menambahkan constraint bahwa starts_at dan ends_at berada pada work_date yang sama di Asia/Jakarta. API menolak jadwal lintas tanggal dengan HTTP 400 VALIDATION_ERROR. Timestamp UTC tetap diterima jika tanggal WIB-nya sesuai. Jadwal lintas tengah malam belum didukung.

Sebelum deploy, periksa jadwal lama pada database tujuan:

~~~sql
SELECT id, user_id, work_date, starts_at, ends_at
FROM work_schedules
WHERE (starts_at AT TIME ZONE 'Asia/Jakarta')::date <> work_date
   OR (ends_at AT TIME ZONE 'Asia/Jakarta')::date <> work_date;
~~~

Jika ada hasil, hentikan rollout dan minta pemilik jadwal menentukan koreksinya. Migrasi tidak menghapus, menggeser jadwal, atau mengubah riwayat absensi. Migration 009 menolak data tersebut dan seluruh migrasi yang masih pending di batch yang sama dibatalkan. Setelah data diselesaikan sesuai persetujuan operasional, retry migrasi.

Untuk deployment, hentikan penerimaan request enrollment baru dan tunggu request pada semua replika versi lama selesai sebelum mengganti versi. Jalankan npm run db:migrate:production memakai build baru, lalu start replika baru. Kolom 008 dan constraint 009 bersifat additive; tidak perlu menghapusnya ketika rollback image. Namun, versi lama mengembalikan bug enrollment dan tidak memahami seluruh variasi checksum lama, sehingga rollback ke versi rentan bukan pemulihan yang aman untuk operasi biometrik. Jika perlu rollback darurat, pertahankan enrollment tidak tersedia sampai versi perbaikan aktif kembali. Jangan menghapus kolom atau constraint pada database berisi data.
