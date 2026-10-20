# Docker aplikasi dengan database dan Redis eksternal

`Dockerfile` membuat satu image multi-stage yang dipakai API dan worker ONNX. Runtime menggunakan user non-root. `compose.yaml` hanya berisi service `api` dan `face-worker` dengan profil opsional `biometrics`. Tidak ada database, Redis, atau volume data keduanya pada Compose aplikasi.

## Menjalankan API

1. Salin `.env.example` menjadi `.env` jika belum ada. Isi secret serta alamat PostgreSQL/PostGIS dan Redis yang sudah tersedia. Jangan menimpa `.env` yang telah dikonfigurasi.
2. Pastikan database dapat diakses dari mesin yang menjalankan migrasi dan dari jaringan Docker. Jika layanan berada pada host Docker, alamat dari dalam container adalah `host.docker.internal`, bukan `localhost`. Untuk layanan remote, gunakan hostname layanan. PostgreSQL perlu extension PostGIS dan kredensial migrasi yang dapat menyiapkannya; role runtime sebaiknya terpisah tanpa hak pemilik/superuser. Batasi akses database/Redis melalui jaringan privat dan autentikasi.
3. Image menyertakan migrator dan file SQL. Secara default Docker memakai `DB_MIGRATE_ON_START=true`: migrasi tertunda dijalankan sebelum HTTP server dibuka, termasuk inisialisasi database kosong. Role pada `DATABASE_URL` harus memiliki izin membuat/mengubah skema dan menyiapkan extension PostGIS. Untuk role runtime terbatas, jalankan migrasi secara terpisah menggunakan role migrasi melalui `npm run db:migrate:production` pada image, lalu set `DB_MIGRATE_ON_START=false` pada API. Alternatif dari source tetap tersedia melalui `npm ci` dan `npm run db:migrate`. Jalankan `npm run admin:create` dari source untuk provisioning admin awal jika belum ada.
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

`DB_MIGRATE_ON_START=true` adalah default image dan Compose. Startup dari source memakai default `false` agar alur migrasi manual tetap tersedia. Flag ini tidak membuat database PostgreSQL baru; database pada `DATABASE_URL` harus sudah ada dan dapat diakses. Server PostgreSQL wajib menyediakan PostGIS; image API tidak memasang extension pada sistem operasi server database.

Migrator memakai advisory lock PostgreSQL yang sama untuk semua replica dan CLI, ledger `schema_migrations`, serta checksum SHA-256. File yang sudah diterapkan dilewati. Seluruh migrasi tertunda dan perubahan ledger dijalankan dalam satu transaksi; kegagalan membatalkan transaksi dan menghentikan startup. Restart tidak menghapus data atau mengulang seed. Jangan mengubah SQL yang sudah diterapkan.

Database yang sudah berisi tabel aplikasi tetapi tidak memiliki ledger tidak diadopsi otomatis: konflik tabel menghentikan migrasi dan transaksi dibatalkan. Periksa riwayat skema sebelum menentukan baseline; jangan menghapus tabel atau menandai migrasi sebagai selesai tanpa verifikasi. Perubahan skema yang sudah berhasil di-commit tidak dibatalkan oleh rollback image Docker. Untuk rollback skema, gunakan migrasi koreksi yang telah ditinjau atau pemulihan backup.

Jika mode otomatis dimatikan dan skema belum tersedia, startup mencatat instruksi untuk menjalankan `db:migrate:production` atau mengaktifkan flag tersebut. Pada Dokploy Application Dockerfile, default flag berasal dari image, sehingga tidak perlu bergantung pada Compose untuk menjalankan inisialisasi database.

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

CI memakai database dan Redis sementara khusus tes integrasi. Service CI tersebut bukan bagian dari deployment aplikasi. Tes lokal memerlukan `TEST_DATABASE_URL` dan `TEST_REDIS_URL` ke layanan uji tersendiri jika berbeda dari default tes; akun PostgreSQL uji membutuhkan hak membuat database. Jangan gunakan akun produksi.

Perubahan Compose tidak menghentikan container database/Redis lama dan tidak menghapus volume lama. Jika layanan lama masih dipakai untuk data lokal, tentukan pemindahan dan backup secara terpisah. Jangan menjalankan `docker compose down --remove-orphans` atau menghapus volume tanpa memastikan data sudah aman.
