# Docker aplikasi dengan database dan Redis eksternal

`Dockerfile` membuat satu image multi-stage yang dipakai API dan worker ONNX. Runtime menggunakan user non-root. `compose.yaml` hanya berisi service `api` dan `face-worker` dengan profil opsional `biometrics`. Tidak ada database, Redis, atau volume data keduanya pada Compose aplikasi.

## Menjalankan API

1. Salin `.env.example` menjadi `.env` jika belum ada. Isi secret serta alamat PostgreSQL/PostGIS dan Redis yang sudah tersedia. Jangan menimpa `.env` yang telah dikonfigurasi.
2. Pastikan database dapat diakses dari mesin yang menjalankan migrasi dan dari jaringan Docker. Jika layanan berada pada host Docker, alamat dari dalam container adalah `host.docker.internal`, bukan `localhost`. Untuk layanan remote, gunakan hostname layanan. PostgreSQL perlu extension PostGIS dan kredensial migrasi yang dapat menyiapkannya; role runtime sebaiknya terpisah tanpa hak pemilik/superuser. Batasi akses database/Redis melalui jaringan privat dan autentikasi.
3. Jalankan `npm ci` dan `npm run db:migrate` dari root source dengan `DATABASE_URL` yang dapat diakses dari host tersebut. Jalankan `npm run admin:create` untuk provisioning admin awal jika belum ada. Migrator tidak disertakan dalam image runtime.
4. Pastikan port host 3000 belum dipakai proses API lokal. Bila masih dipakai, tentukan `API_HOST_PORT=3001` pada `.env`.
5. Jalankan:

```powershell
docker compose build api
docker compose up -d --wait api
docker compose ps
```

API mengikat port host pada loopback saja: `127.0.0.1:3000` secara default. Pasang reverse proxy HTTPS pada host dan isi `TRUST_PROXY` dengan IP/CIDR proxy yang benar-benar dilihat container. Jangan mengasumsikan IP proxy selalu `127.0.0.1`: koneksi melalui bridge Docker dapat terlihat sebagai alamat gateway. Compose memaksa `NODE_ENV=production`; endpoint bisnis menolak HTTP tanpa proxy HTTPS tepercaya. Health check privat memakai `/ready/auth` untuk database dan Redis, sehingga staging login tidak menunggu model wajah.

`docker compose config --quiet` memvalidasi konfigurasi tanpa mencetak environment berisi secret. Jangan membagikan output penuh `docker compose config`, `docker inspect`, atau log proxy yang memuat kredensial.

## Worker wajah opsional

Untuk staging login saja, profil ini tidak perlu diaktifkan. API tetap menolak operasi wajah ketika worker belum tersedia. Untuk mengaktifkan biometrik:

1. Siapkan direktori `models` berisi `manifest.json` dan bobot model yang sah. Path relatif pada manifest dihitung dari direktori manifest; misalnya `recognition.onnx` menunjuk `/app/models/recognition.onnx` di dalam container. Path absolut, jika digunakan, harus menunjuk lokasi di dalam container. Konfirmasikan izin baca untuk user non-root container.
2. Isi `FACE_WORKER_TOKEN` pada `.env` serta versi dan threshold API dari hasil kalibrasi. Compose memasang direktori model read-only, menentukan manifest `/app/models/manifest.json`, dan menghubungkan API ke `http://face-worker:8000` pada jaringan Compose.
3. Jalankan:

```powershell
docker compose --profile biometrics up -d --build --wait
```

Worker tidak memublikasikan port ke host. Health check worker memeriksa model melalui `/ready` dengan autentikasi. Model atau manifest yang belum valid membuat worker tidak ready; proses yang hidup saja tidak membuktikan model siap.

Container menggunakan filesystem read-only, direktori sementara di memori, seluruh capability tambahan dibuang, dan privilege escalation dinonaktifkan. API mempunyai waktu shutdown 20 detik untuk menyelesaikan penutupan koneksi. Ukur penggunaan RAM worker dan Argon2 pada staging sebelum menentukan limit resource platform.

## Pengujian dan layanan yang sudah berjalan

CI memakai database dan Redis sementara khusus tes integrasi. Service CI tersebut bukan bagian dari deployment aplikasi. Tes lokal memerlukan `TEST_DATABASE_URL` dan `TEST_REDIS_URL` ke layanan uji tersendiri jika berbeda dari default tes; akun PostgreSQL uji membutuhkan hak membuat database. Jangan gunakan akun produksi.

Perubahan Compose tidak menghentikan container database/Redis lama dan tidak menghapus volume lama. Jika layanan lama masih dipakai untuk data lokal, tentukan pemindahan dan backup secara terpisah. Jangan menjalankan `docker compose down --remove-orphans` atau menghapus volume tanpa memastikan data sudah aman.
