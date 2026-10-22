# Panduan Setup Container PostgreSQL + PostGIS untuk DevOps

Dokumen ini memandu DevOps dalam mem-build, mem-push image ke container registry, dan menjalankan container PostgreSQL dengan ekstensi **PostGIS** untuk backend Absensi KPID-KI (Provinsi Sumatera Utara).

---

## 1. Spesifikasi Image

- **Base Image:** `postgres:17-bookworm`
- **Ekstensi:** `postgis`, `postgis_topology` (PostGIS 3)
- **Auto-Initialization:** Mengandung skrip `/docker-entrypoint-initdb.d/10_postgis.sh` yang otomatis mengaktifkan ekstensi `postgis` saat database pertama kali diinisialisasi.
- **File Dockerfile:** `Dockerfile.postgres`
- **File Compose:** `compose.postgres.yaml`

---

## 2. Build & Push Image ke Container Registry

DevOps dapat mem-build dan mem-push image ini ke registry internal (Docker Hub, GitHub Container Registry `ghcr.io`, GitLab Registry, atau Harbor).

### Langkah Build:
```bash
# Ganti <registry-url> sesuai registry organisasi Anda
docker build -t <registry-url>/absensi-postgres-postgis:17 -f Dockerfile.postgres .
```

*Contoh jika menggunakan Docker Hub:*
```bash
docker build -t username/absensi-postgres-postgis:17 -f Dockerfile.postgres .
```

*Contoh jika menggunakan GitHub Packages (GHCR):*
```bash
docker build -t ghcr.io/org-name/absensi-postgres-postgis:17 -f Dockerfile.postgres .
```

### Langkah Push:
```bash
docker push <registry-url>/absensi-postgres-postgis:17
```

---

## 3. Menjalankan di Server Production / Staging

### Opsi A: Menggunakan `compose.postgres.yaml` (Rekomendasi)

Tersedia file `compose.postgres.yaml` siap pakai yang mencakup PostgreSQL + PostGIS; Redis tetap memakai layanan eksternal:

1. Buat file `.env` di server (atau set environment variable):
   ```env
   POSTGRES_IMAGE=<registry-url>/absensi-postgres-postgis:17
   POSTGRES_USER=absensi
   POSTGRES_PASSWORD=GantiDenganPasswordKuatDanAman123!
   POSTGRES_DB=absensi
   POSTGRES_PORT=5432
   ```

2. Jalankan container:
   ```bash
   docker compose -f compose.postgres.yaml up -d
   ```

3. Cek log dan status:
   ```bash
   docker compose -f compose.postgres.yaml ps
   docker compose -f compose.postgres.yaml logs -f postgres
   ```

---

### Opsi B: Menggunakan Docker Run Langsung

```bash
docker volume create postgres_absensi_data

docker run -d \
  --name absensi-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=absensi \
  -e POSTGRES_PASSWORD=GantiDenganPasswordKuatDanAman123! \
  -e POSTGRES_DB=absensi \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -p 127.0.0.1:5432:5432 \
  -v postgres_absensi_data:/var/lib/postgresql/data \
  <registry-url>/absensi-postgres-postgis:17
```

---

### Opsi C: Deployment melalui Dokploy / Coolify / Portainer

1. Pilih **Deploy via Dockerfile** atau **Image Repository**.
2. Jika menggunakan Image: masukkan URL image yang telah di-push (`<registry-url>/absensi-postgres-postgis:17`).
3. Set environment variables:
   - `POSTGRES_USER`
   - `POSTGRES_PASSWORD`
   - `POSTGRES_DB`
4. Mount volume persistent pada path: `/var/lib/postgresql/data`.

---

## 4. Verifikasi Instalasi PostGIS

Untuk memastikan PostGIS telah aktif di database target, jalankan query berikut:

```bash
docker exec -it <container_name> psql -U absensi -d absensi -c "SELECT PostGIS_Full_Version();"
```

Output yang diharapkan:
```text
POSTGIS="3.x.x" [EXTENSION] PGSQL="17" GEOS="..." PROJ="..." ...
```

---

## 5. Menjalankan Migrasi Database Aplikasi

Setelah database siap, API absensi dapat menjalankan migrasi database (termasuk migrasi poligon `005_office_polygon.sql`):

- **Otomatis:** Saat container API berjalan dengan `DB_MIGRATE_ON_START=true` (default).
- **Manual via CLI Image API:**
  ```bash
  docker run --rm --env-file .env absensi-api:latest npm run db:migrate:production
  ```
- **Manual dari source code:**
  ```bash
  npm run db:migrate
  ```

## Konfigurasi jaringan dan secret

Compose database hanya menjalankan PostgreSQL/PostGIS. POSTGRES_PASSWORD wajib diberikan tanpa password fallback. Port host diikat pada 127.0.0.1; hubungkan API dan database pada jaringan privat yang sama di Dokploy dan gunakan hostname service database pada DATABASE_URL. Jangan mengandalkan host.docker.internal untuk mengakses port yang hanya bind loopback pada server Linux. Redis memakai layanan eksternal melalui REDIS_URL. Pisahkan role runtime API dari superuser provisioning database.

Migration 006_office_geofence_policy.sql menyimpan alamat ketiga kantor, mengunci radius 50 meter, memvalidasi polygon dan menyiapkan pembentukan polygon otomatis. Koordinat yang belum diverifikasi tidak diisi perkiraan dan kantor belum dapat diaktifkan sebelum titik pusat serta kebijakan GPS diisi.


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
