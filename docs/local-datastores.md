# PostgreSQL/PostGIS dan Redis lokal

Jalankan perintah dari root repo menggunakan PowerShell. Docker Desktop harus aktif. API berjalan pada host melalui `npm run dev`; `compose.yaml` utama ditujukan untuk deployment API dan tidak perlu dijalankan untuk alur ini.

## Konfigurasi

Salin `.env.example` menjadi `.env` hanya jika file lokal belum tersedia. Isi secret aplikasi dan `POSTGRES_PASSWORD`; samakan password tersebut dengan password dalam `DATABASE_URL` (password pada URL harus di-encode jika mengandung karakter khusus).

- `compose.postgres.yaml`: PostgreSQL 17 dengan PostGIS, port host `55432`, volume `absensi-datastore_postgres_data`.
- `compose.redis.yaml`: Redis 7, port host `56379`, volume `absensi-cache_redis_data`.
- `DATABASE_URL`: `postgresql://absensi:<password-URL-encoded>@localhost:55432/absensi`.
- `REDIS_URL`: `redis://localhost:56379`.

Redis menggunakan AOF untuk mempertahankan data setelah restart dan kebijakan `noeviction` agar rate limit tidak dibuang otomatis ketika batas memori tercapai. Restart policy tidak menggantikan pemantauan kapasitas dan backup database. Konfigurasi ini tidak menyediakan autentikasi Redis dan hanya memublikasikan port pada loopback host; jangan mengubah binding menjadi publik.

## Beralih dari container Redis manual

Jika `absensi-local-redis` dari panduan lama masih berjalan, hentikan sebelum menyalakan Compose agar port `56379` tersedia:

```powershell
docker stop absensi-local-redis
```

Container lama tidak dihapus. Compose membuat Redis tersendiri; isi rate limit Redis lama tidak dipindahkan. PostgreSQL dan container personal tidak terpengaruh.

## Menjalankan

```powershell
docker compose -f compose.postgres.yaml up -d --build --wait postgres
docker compose -f compose.redis.yaml up -d --wait redis
docker compose -f compose.postgres.yaml exec postgres psql -U absensi -d absensi -c "SELECT PostGIS_Version();"
docker compose -f compose.redis.yaml exec redis redis-cli ping
npm ci
npm run db:migrate
npm run dev
```

Perintah PostGIS harus menghasilkan versi extension dan Redis menghasilkan `PONG`. Jika nama user/database PostgreSQL diubah, sesuaikan argumen `-U` dan `-d`. Di terminal lain, periksa `http://localhost:3000/ready/auth`. Kesiapan ini tidak mencakup worker biometrik.

Untuk melihat status dan log:

```powershell
docker compose -f compose.postgres.yaml ps
docker compose -f compose.redis.yaml ps
docker compose -f compose.redis.yaml logs --tail=100 redis
```

Hentikan API dengan `Ctrl+C`, lalu hentikan datastore bila diperlukan:

```powershell
docker compose -f compose.postgres.yaml stop
docker compose -f compose.redis.yaml stop
```

`down` menghapus container dan network tetapi mempertahankan named volume. `down -v` juga menghapus volume beserta datanya.

## Server Dokploy

File Compose datastore dapat digunakan sebagai layanan terpisah jika server membutuhkan PostgreSQL/PostGIS atau Redis baru. API dalam container harus terhubung melalui jaringan privat bersama atau alamat layanan yang memang dapat dijangkau; `localhost` pada container API bukan host Docker. Kedua datastore memiliki jaringan Compose terpisah secara default, sehingga DevOps perlu mengatur konektivitas secara eksplisit. Jangan menyalin URL localhost dari `.env` lokal ke API server.

Secret server diinjeksi melalui Dokploy dan tidak disimpan di Git. Jika memakai Redis terkelola atau autentikasi Redis, sesuaikan konfigurasi layanan dan `REDIS_URL`; jangan menganggap Compose lokal ini sudah menyediakan autentikasi atau TLS.
