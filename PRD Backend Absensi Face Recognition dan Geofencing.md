# PRD — Backend Service Sistem Absensi Face Recognition dan Geofencing

Draft v0.6 · 22 Oktober 2026 · Status: implementasi awal P0; aturan lokasi, kategori, platform Android, dan perpindahan kantor disepakati

> Acuan implementasi: backend utama Express.js dengan REST API, frontend mobile React Native untuk **Android saja** dikerjakan terpisah. Tiga lokasi kantor, kategori pegawai KPID/KI, matriks izin lokasi, radius 50 meter, dan izin masuk/pulang di kantor berbeda yang sama-sama diizinkan adalah **kebutuhan yang telah disepakati**. Koordinat pusat dari pin pengguna tercatat pada bagian 17 dan di-seed melalui migration 007. Angka target, threshold, dan pilihan teknologi lainnya tetap **usulan** yang perlu divalidasi (lihat bagian 15). Status implementasi dan keputusan teknis awal tercatat di bagian 17; keberadaan kode belum membuktikan akurasi model atau kesiapan operasional.

## 1. Ringkasan

Backend service berbasis REST API untuk aplikasi absensi mobile. Pegawai melakukan absen masuk dan pulang dengan verifikasi wajah, dan hanya diterima bila posisinya berada dalam radius lokasi kantor yang ditentukan. Server adalah penentu akhir: hasil liveness, jarak, dan kecocokan wajah dari klien tidak dipercaya begitu saja.

Pegawai memiliki kategori KPID atau KI. Pegawai KPID boleh absen di kantor KPID Sumut dan kantor utama DISKOMINFO Provsu; pegawai KI boleh absen di kantor KI Sumut dan kantor utama DISKOMINFO Provsu. Masing-masing lokasi memiliki radius 50 meter. Aturan ini berlaku untuk check-in dan check-out.

## 2. Tujuan, Non-Tujuan, dan Metrik

**Tujuan**

- Absensi akurat dan sulit dimanipulasi (foto, mock GPS, absen titip, perangkat lain).
- Verifikasi wajah 1:1 yang cepat dan konsisten.
- Jejak audit lengkap untuk setiap percobaan absen, berhasil maupun gagal.
- Data biometrik dikelola aman dan selaras dengan UU PDP.

**Non-tujuan (v1)**

- Identifikasi 1:N / mode kiosk.
- Payroll dan perhitungan tunjangan.
- Aplikasi mobile dan dashboard web (dibahas di dokumen terpisah; PRD ini hanya backend).
- Integrasi mesin fingerprint atau perangkat absensi fisik.

**Metrik keberhasilan (usulan target, divalidasi saat pilot)**

| Metrik | Usulan target |
| --- | --- |
| Waktu respons check-in p95 | ≤ 3 detik (di luar latensi jaringan klien) |
| False accept rate | ≤ 0,1% |
| False reject rate | ≤ 3–5% |
| Ketersediaan pada jam kerja | ≥ 99,5% |
| Skenario spoofing (foto/layar) yang lolos pada uji | 0 dari seluruh skenario uji |

## 3. Pengguna dan Peran

| Peran | Kebutuhan utama |
| --- | --- |
| Pegawai | Enrollment wajah, absen masuk/pulang, lihat riwayat, ajukan koreksi |
| Atasan / Verifikator | Menyetujui koreksi, meninjau absen zona abu-abu |
| Admin Unit / HR | Kelola pegawai, lokasi, jadwal, reset perangkat dan wajah, laporan |
| Super Admin | Konfigurasi sistem, kebijakan, akses audit log |

### 3.1 Kategori Pegawai dan Otorisasi Lokasi (disepakati)

Kategori pegawai terpisah dari peran akses dan unit kerja. `employee_category` menentukan izin lokasi absensi; `role` menentukan akses fitur API. Peran admin tidak otomatis memberi hak absen di semua lokasi.

| Kode kategori | Kategori pegawai | Lokasi yang diizinkan |
| --- | --- | --- |
| KPID | Pegawai Komisi Penyiaran Indonesia Daerah Sumatera Utara | DISKOMINFO_PROVSU, KPID_SUMUT |
| KI | Pegawai Komisi Informasi Sumatera Utara | DISKOMINFO_PROVSU, KI_SUMUT |

### 3.2 Lokasi Absensi Awal (disepakati)

| Kode lokasi | Nama kantor | Radius | Koordinat pusat | Zona waktu |
| --- | --- | --- | --- | --- |
| DISKOMINFO_PROVSU | Dinas Komunikasi dan Informatika Provinsi Sumatera Utara (kantor utama) | 50 meter | Belum ditentukan | Asia/Jakarta |
| KPID_SUMUT | Komisi Penyiaran Indonesia Daerah Sumatera Utara | 50 meter | Belum ditentukan | Asia/Jakarta |
| KI_SUMUT | Komisi Informasi Sumatera Utara | 50 meter | Belum ditentukan | Asia/Jakarta |

Koordinat harus dikonfirmasi dari titik absensi di lapangan. Lokasi belum boleh diaktifkan sebelum koordinat valid tersedia; jangan memakai koordinat perkiraan atau `(0, 0)` sebagai pengganti. Izin kategori-lokasi disimpan sebagai relasi di database dengan matriks di atas sebagai data awal, agar aturan terpusat dan dapat diaudit.

## 4. Ruang Lingkup

**Termasuk:** autentikasi, device binding, manajemen pegawai/lokasi/jadwal, enrollment wajah, check-in/check-out dengan verifikasi wajah dan geofence, riwayat, koreksi, laporan, audit log.

**Tidak termasuk:** UI mobile/web, payroll, integrasi hardware absensi, identifikasi 1:N, mode offline penuh (lihat pertanyaan terbuka).

## 5. Kebutuhan Fungsional

Prioritas: P0 = wajib MVP, P1 = fase hardening, P2 = lanjutan.

| ID | Kebutuhan | Prioritas |
| --- | --- | --- |
| FR-01 | Login pegawai; access token berumur pendek + refresh token dengan rotasi (opsional integrasi SSO instansi) | P0 |
| FR-02 | Device binding: satu akun terikat satu perangkat aktif; ganti perangkat butuh persetujuan admin | P0 |
| FR-03 | CRUD pegawai, kategori KPID/KI, peran, dan unit kerja oleh admin; perubahan kategori diaudit; impor CSV | P0 (CRUD), P1 (impor) |
| FR-04 | Kelola tiga lokasi awal: kode, nama, koordinat pusat, radius 50 meter, batas akurasi GPS, zona waktu, status aktif | P0 |
| FR-05 | Otorisasi lokasi berdasarkan kategori: KPID ke kantor KPID dan DISKOMINFO; KI ke kantor KI dan DISKOMINFO; berlaku untuk masuk dan pulang | P0 |
| FR-06 | Enrollment wajah: 3–5 foto dengan pemeriksaan kualitas; consent tercatat | P0 |
| FR-07 | Check-in dan check-out: selfie, koordinat, akurasi GPS, device id, timestamp klien, nonce | P0 |
| FR-08 | Validasi geofence di server (jarak ≤ radius dan akurasi GPS ≤ batas) | P0 |
| FR-09 | Verifikasi wajah 1:1 dengan liveness/anti-spoofing; skor tersimpan | P0 |
| FR-10 | Deteksi indikasi kecurangan: flag mock location, integritas perangkat, lompatan lokasi tidak wajar, selisih waktu klien vs server | P1 |
| FR-11 | Penentuan status (hadir, terlambat, pulang cepat) berdasarkan jadwal dan toleransi | P0 (jadwal tetap), P1 (multi-shift) |
| FR-12 | Riwayat absensi pegawai dengan filter tanggal | P0 |
| FR-13 | Pengajuan koreksi/absen manual dengan alasan dan lampiran, persetujuan atasan | P1 |
| FR-14 | Laporan rekap harian/bulanan dan ekspor CSV/XLSX | P1 |
| FR-15 | Audit log untuk aksi sensitif (enrollment, reset wajah, ubah radius, approval) | P0 |
| FR-16 | Notifikasi push hasil absen, penolakan, dan pengingat | P2 |
| FR-17 | Reset enrollment dan penghapusan data biometrik atas permintaan (hak subjek data) | P1 |

## 6. Alur Utama Check-in

1. Mobile membuat challenge (`POST /attendance/challenges`) dengan device_id dan purpose: nonce sekali pakai, terikat pengguna, perangkat, dan tujuan operasi. Implementasi awal memakai passive PAD server untuk selfie; instruksi gerakan aktif belum tersedia.
2. Mobile mengambil selfie dan lokasi, lalu mengirim `POST /attendance/check-in` (multipart) dengan header `Idempotency-Key`.
3. API memvalidasi token, device binding, nonce, timestamp (anti-replay), dan rate limit.
4. API membaca kategori pegawai terkini dari database dan mengambil lokasi aktif yang diizinkan untuk kategori tersebut. API memvalidasi izin lokasi, geofence 50 meter, dan akurasi GPS. Jika gagal, tolak dan catat percobaan; kategori, jarak, atau hasil otorisasi dari klien tidak dipercaya.
5. Pada implementasi awal, foto hanya diproses di memori dan dikirim ke face worker internal; tidak disimpan ke disk/object storage. Transport terenkripsi dan jaringan privat wajib disiapkan pada deployment operasional.
6. Worker: deteksi wajah, cek kualitas, liveness, ekstraksi embedding, lalu cosine similarity terhadap template milik pegawai tersebut (1:1).
7. Keputusan: **sukses**, **ditolak**, atau **perlu review** (zona abu-abu skor).
8. API menyimpan attendance dan attempt beserta lokasi yang dipakai, kategori pegawai saat kejadian, radius yang diterapkan, dan jarak hasil perhitungan server; API menulis audit log dan mengembalikan hasil.
9. Buffer foto dilepas setelah pemrosesan; penyimpanan bukti foto dan retensinya belum diaktifkan.

Catatan: respons dapat sinkron (menunggu hasil worker dengan timeout) atau asinkron (polling status). Usulan awal: sinkron dengan timeout, beralih asinkron bila beban meningkat.

Check-out mengikuti validasi kategori dan lokasi yang sama. **Masuk dan pulang boleh di kantor berbeda** selama kedua kantor diizinkan untuk kategori pegawai pada saat operasi masing-masing. Check-out tetap memerlukan check-in sah pada jadwal aktual yang sama.

## 7. Aturan Bisnis

- Waktu otoritatif adalah waktu server; perhitungan hari kerja memakai zona waktu per lokasi kantor.
- Area absensi berupa polygon PostGIS dari buffer 50 meter terhadap titik pusat kantor yang diverifikasi. Posisi wajib tercakup polygon (`ST_Covers`) dan berjarak maksimal 50 meter menurut `ST_DWithin` geography. Perhitungan dilakukan server; bentuk polygon tidak memperbesar batas jarak.
- Radius absensi adalah **50 meter** untuk ketiga lokasi, berlaku untuk check-in dan check-out. Perubahan kebijakan radius memerlukan keputusan eksplisit dan audit; GPS buruk tidak boleh memperbesar radius secara otomatis.
- Batas akurasi GPS terpisah dari radius absensi dan ditetapkan setelah pilot di ketiga kantor; angka final belum disepakati. Absen ditolak bila estimasi akurasi melebihi batas yang ditetapkan. Radius 50 meter tidak berarti toleransi akurasi GPS juga 50 meter.
- Akun yang melakukan absensi wajib memiliki kategori aktif `KPID` atau `KI`. Kategori kosong/tidak dikenal tidak mendapat izin lokasi secara default.
- Backend mengambil kategori terkini dari database pada setiap percobaan, bukan dari body request atau klaim token yang mungkin sudah usang. Pegawai tidak boleh mengubah kategorinya sendiri; perubahan hanya oleh admin berwenang dan tercatat di audit log.
- Pegawai KPID tidak boleh absen di kantor KI dan sebaliknya, walaupun jarak dan verifikasi wajah lolos. Kantor DISKOMINFO Provsu dapat digunakan oleh kedua kategori.
- Jika klien menyertakan `office_id`, backend memvalidasi lokasi tersebut aktif, diizinkan, dan berada dalam radius. Jika tidak disertakan, backend memilih lokasi terdekat dari lokasi aktif yang diizinkan dan memenuhi radius; jika jarak sama, gunakan kode lokasi secara alfabetis sebagai pemutus. Lokasi yang tidak diizinkan tidak boleh terpilih.
- Lokasi, kategori, radius, dan jarak saat kejadian disimpan pada absensi. Perubahan kategori atau konfigurasi lokasi tidak mengubah catatan historis. Lokasi yang sudah direferensikan riwayat dinonaktifkan, bukan dihapus permanen.
- Satu check-in dan satu check-out per shift per hari; request ulang dengan Idempotency-Key sama mengembalikan hasil yang sama.
- Batas percobaan gagal (usulan 5 kali per 15 menit) memicu kunci sementara.
- Skor di antara threshold bawah dan atas masuk antrean review atasan; threshold final ditetapkan setelah kalibrasi pilot, bukan dari nilai default model.
- Percobaan yang ditolak tetap dicatat (alasan dan metadata), dengan foto hanya bila kebijakan retensi mengizinkan.

## 8. Kebutuhan Non-Fungsional

- **Performa:** inferensi dijalankan di worker terpisah dengan konkurensi terbatas; session model dibuat sekali saat startup.
- **Skalabilitas:** Skala awal sekitar 100-an pegawai (paling banyak ratusan), sehingga satu instance API dan satu face worker dijadikan titik awal (usulan, diverifikasi lewat benchmark saat PoC). API dibuat stateless agar bisa direplikasi bila diperlukan; antrean job (BullMQ) ditunda dan baru dipertimbangkan bila timeout muncul pada jam masuk.
- **Ketersediaan:** health dan readiness check, graceful shutdown, retry dengan backoff untuk panggilan ke face worker.
- **Keamanan:** TLS, hashing password dengan argon2, validasi input ketat, rate limiting, secret di secret manager.
- **Privasi:** kebijakan retensi, enkripsi data biometrik, consent, dan akses berbasis peran (lihat bagian 12).
- **Observability:** log terstruktur, metrik dasar (latensi, rasio penolakan per alasan), dan health check; tracing dan dashboard metrik lengkap menyusul bila skala bertambah.
- **Maintainability:** TypeScript, modul terpisah per domain, kontrak API terdokumentasi (OpenAPI), migrasi database terversi, cakupan tes untuk logika geofence dan keputusan absen.

## 9. Arsitektur dan Stack yang Disarankan

```
Mobile App → Reverse Proxy (Nginx) → Express API (modular monolith)
                                      ├─ PostgreSQL + PostGIS
                                      ├─ Redis (rate limit)
                                      ├─ Object Storage (rencana lanjutan; belum diaktifkan)
                                      └─ REST internal → Face Worker (Node + onnxruntime-node)
```

| Komponen | Pilihan | Alasan |
| --- | --- | --- |
| Runtime | Node.js LTS aktif + TypeScript | Tipe data menjaga kontrak API; cek versi LTS saat mulai |
| Framework | **Express 5.x** (ditetapkan) | Sesuai keputusan; cek versi stabil terbaru |
| Validasi | Zod | Skema tunggal untuk validasi dan tipe; bisa dibuat OpenAPI |
| Akses data | pg + SQL terparameterisasi (implementasi awal) | Query PostGIS, constraint, dan transaksi eksplisit; Kysely/Drizzle merupakan usulan sebelumnya yang belum digunakan |
| Database | PostgreSQL + PostGIS | Query radius langsung di database; pgvector hanya bila kelak butuh 1:N |
| Cache dan penyimpanan sementara | Redis (BullMQ ditunda) | Rate limit; nonce dan idempotency dipersistenkan di PostgreSQL |
| Face engine | onnxruntime-node dengan adaptor SCRFD + ArcFace | Kontrak deteksi/alignment/embedding tersedia; bobot, lisensi, dan akurasi operasional harus divalidasi sebelum dipakai |
| Liveness | Classifier passive PAD ONNX di server | Preprocessing, kelas live, dan threshold eksplisit; liveness aktif video/frame belum diimplementasikan |
| Penyimpanan file | Memori proses pada implementasi awal; MinIO/S3-compatible masih rencana | Tidak menyimpan foto mentah sebelum retensi dan kebutuhan bukti review diputuskan |
| Auth | JWT access singkat + refresh rotation, device binding | Refresh disimpan hashed di database agar bisa dicabut |
| Hardening Express | helmet, cors terbatas, express-rate-limit (store Redis), batas ukuran upload | Praktik standar |
| Upload | multer atau busboy dengan batas ukuran dan validasi tipe file | Cegah beban dan file berbahaya |
| Logging | pino | Cepat dan terstruktur |
| Observability | Metrik dasar dan health check (OpenTelemetry/Prometheus menyusul bila skala bertambah) | Metrik latensi dan rasio penolakan |
| Dokumentasi API | OpenAPI TypeScript tervalidasi pada implementasi awal | Kontrak untuk mobile tersedia; generasi seluruh skema dari Zod masih pekerjaan lanjutan |
| Testing | Vitest atau Jest, Supertest, Testcontainers | Tes integrasi dengan Postgres/Redis sungguhan |
| Deploy | Docker, CI/CD | Image terpisah untuk API dan face worker |

## 10. Model Data (ringkas)

| Entitas | Field utama |
| --- | --- |
| users | id, nomor induk pegawai, nama, email, password\_hash, employee\_category\_code (KPID/KI; wajib untuk absensi), role, unit\_id, status |
| employee\_categories | code (KPID/KI), nama, aktif |
| devices | id, user\_id, public\_key (Ed25519 PEM), platform (ANDROID), status, bound\_at |
| refresh\_sessions | id, user\_id, family\_id, token\_hash, expires\_at, revoked\_at |
| attendance\_challenges | id, user\_id, device\_id, purpose, nonce\_hash, created\_at, expires\_at, consumed\_at |
| offices | id, code (unik), nama, location (geography Point 4326; wajib sebelum aktif), radius\_m (50), max\_gps\_accuracy\_m, timezone, aktif |
| category\_office\_permissions | employee\_category\_code, office\_id; kombinasi unik dan foreign key ke kategori/lokasi; empat relasi awal sesuai bagian 3.1 |
| work\_schedules | id, office\_id atau unit\_id, jam\_masuk, jam\_pulang, toleransi\_menit |
| face\_templates | id, user\_id, embedding (terenkripsi), model\_version, quality\_score, created\_at, revoked\_at |
| attendances | id, user\_id, office\_id, employee\_category\_at\_event, office\_code\_at\_event, office\_location\_at\_event, radius\_m\_at\_event, type, server\_time, lat, lng, gps\_accuracy, distance\_m, face\_score, liveness\_score, status, device\_id, idempotency\_key |
| attendance\_attempts | id, user\_id, waktu, reason\_code, metadata (semua percobaan, termasuk gagal) |
| correction\_requests | id, user\_id, attendance\_id, alasan, lampiran, status, approver\_id |
| audit\_logs | id, actor\_id, aksi, target, waktu, detail (append-only) |

Catatan: simpan `model_version` pada setiap template; saat model atau preprocessing diganti, pegawai perlu re-enrollment pada implementasi awal karena foto mentah tidak disimpan.

## 11. Spesifikasi API (REST)

Prefix: `/api/v1`. Autentikasi memakai Bearer token kecuali disebutkan lain.

| Method | Endpoint | Peran | Fungsi |
| --- | --- | --- | --- |
| POST | /auth/login | Publik | Login |
| POST | /auth/refresh | Publik | Perbarui token |
| POST | /auth/logout | Pegawai | Cabut refresh token |
| POST | /auth/logout-all | Pegawai | Cabut seluruh sesi sendiri |
| POST | /auth/change-password | Pegawai | Validasi password saat ini, ubah password, cabut seluruh sesi |
| GET | /me | Pegawai | Profil, kategori pegawai, peran, dan status enrollment |
| POST | /devices/bind | Pegawai | Ajukan pengikatan perangkat |
| PATCH | /admin/devices/:id | Admin | Setujui atau cabut perangkat |
| GET | /offices | Pegawai | Hanya lokasi aktif yang diizinkan berdasarkan kategori terkini; sertakan kode, koordinat, radius 50 meter, dan batas akurasi |
| GET/POST | /admin/offices | Admin | Lihat dan tambah lokasi dengan validasi kebijakan radius |
| PATCH | /admin/offices/:id | Admin | Ubah konfigurasi atau nonaktifkan lokasi; perubahan diaudit |
| GET/POST | /admin/users | Admin | Lihat dan tambah pegawai beserta kategori KPID/KI |
| PATCH | /admin/users/:id | Admin | Ubah pegawai, termasuk kategori; perubahan kategori diaudit |
| POST | /face/enroll | Pegawai | Daftarkan wajah (multipart) |
| DELETE | /admin/users/:id/face | Admin | Reset data wajah |
| POST | /attendance/challenges | Pegawai | Buat nonce sekali pakai dengan device_id dan purpose; mode passive PAD server |
| GET | /attendance/attempts/:id | Pegawai | Status percobaan milik sendiri dan pemulihan hasil setelah timeout |
| POST | /attendance/check-in | Pegawai | Absen masuk |
| POST | /attendance/check-out | Pegawai | Absen pulang |
| GET | /attendance/history | Pegawai | Riwayat dengan filter tanggal |
| POST | /corrections | Pegawai | Ajukan koreksi |
| PATCH | /corrections/:id | Atasan | Setujui atau tolak |
| GET | /reports/attendance | Admin | Rekap; ekspor via parameter format |
| GET | /admin/audit-logs | Super Admin | Audit log |
| GET | /health, /ready | Internal | Pemeriksaan layanan |

**Field request check-in:** image (file), latitude, longitude, accuracy\_m, captured\_at, device\_id, nonce, is\_mock (informatif dari klien), liveness\_proof (informatif dari klien), header Idempotency-Key.

Aturan lokasi berlaku juga untuk request check-out. `office_id` opsional sebagai pilihan lokasi yang tetap divalidasi server. `employee_category` bukan field yang boleh ditetapkan lewat request absensi. Respons absensi berhasil menyertakan lokasi yang dipakai, jarak hasil server, radius yang diterapkan, dan waktu server. React Native memakai `/offices` untuk menampilkan lokasi yang tersedia; keputusan akhir tetap di backend.

**Kode error utama:** GEOFENCE\_OUT\_OF\_RANGE, GPS\_ACCURACY\_LOW, FACE\_NOT\_MATCHED, FACE\_QUALITY\_LOW, LIVENESS\_FAILED, DEVICE\_NOT\_BOUND, MOCK\_LOCATION\_DETECTED, DUPLICATE\_ATTENDANCE, REPLAY\_DETECTED, RATE\_LIMITED. Respons error memakai format seragam berisi kode, pesan, dan request id.

**Kode error otorisasi lokasi:** `EMPLOYEE_CATEGORY_INVALID` (403; kategori kosong/tidak aktif), `OFFICE_NOT_ALLOWED` (403; lokasi yang diminta tidak diizinkan), `OFFICE_UNAVAILABLE` (409; lokasi yang diizinkan belum aktif/siap), dan `GEOFENCE_OUT_OF_RANGE` (422; tidak berada dalam radius lokasi yang diizinkan). Jika tanpa `office_id` tidak ada lokasi aktif yang diizinkan, kembalikan `OFFICE_UNAVAILABLE`; jika ada tetapi semua di luar radius, kembalikan `GEOFENCE_OUT_OF_RANGE`. Penolakan dicatat pada attempt tanpa membuat absensi sah.

## 12. Keamanan dan Privasi (UU PDP)

- Data wajah adalah data biometrik: butuh dasar pemrosesan yang jelas, consent tercatat, dan tujuan penggunaan terbatas. Konsultasikan dengan bagian hukum atau DPO sebelum rilis.
- Simpan embedding terenkripsi; hindari menyimpan foto mentah lebih lama dari yang diperlukan (usulan: hapus setelah verifikasi selesai atau dalam jangka pendek yang ditetapkan kebijakan).
- Akses ke data biometrik dibatasi per peran, dan setiap akses tercatat di audit log.
- Komunikasi antar-service memakai token internal dan jaringan privat.
- Tersedia mekanisme penghapusan dan koreksi data atas permintaan pegawai.
- Backup terenkripsi dan uji pemulihan berkala.

## 13. Matriks Ancaman dan Mitigasi

| Ancaman | Mitigasi |
| --- | --- |
| Foto, layar, atau video wajah | Liveness pasif di server dan liveness aktif acak di mobile |
| Mock location / GPS spoofing | Flag mock dari OS, Play Integrity / App Attest, validasi akurasi, deteksi lompatan lokasi, sinyal tambahan (IP/jaringan) |
| Absen titip | Verifikasi wajah 1:1 dan device binding |
| Replay request | Nonce sekali pakai, timestamp, Idempotency-Key |
| Aplikasi dimodifikasi atau perangkat di-root | Device integrity attestation; tolak atau tandai untuk review |
| Pencurian template wajah | Enkripsi, akses terbatas, retensi singkat |
| Brute force login | Rate limit Redis per IP dan kegagalan per akun lintas IP; pembatasan 15 menit, bukan lockout progresif |
| Penyalahgunaan oleh admin | Audit log append-only, pemisahan peran, approval koreksi |

## 14. Fase dan Milestone (usulan kasar)

Durasi bergantung ukuran tim dan hanya sebagai titik awal diskusi.

| Fase | Cakupan | Estimasi |
| --- | --- | --- |
| 0. PoC dan kalibrasi | Pilih model, uji akurasi dengan data pilot, tetapkan threshold, uji liveness | 2–3 minggu |
| 1. MVP | Seluruh kebutuhan P0 | 4–6 minggu |
| 2. Hardening dan pilot | Kebutuhan P1, load test, uji spoofing, review keamanan dan PDP | 3–4 minggu |
| 3. Rollout | Bertahap per unit kerja, pemantauan rasio penolakan | Menyesuaikan |

## 15. Risiko, Asumsi, dan Pertanyaan Terbuka

**Risiko**

| Risiko | Mitigasi |
| --- | --- |
| Akurasi turun pada cahaya buruk atau kamera murah | Cek kualitas gambar, panduan di UI, uji pada perangkat target, jalur review manual |
| Lonjakan beban pada jam masuk | Benchmark waktu inferensi saat PoC, batasi konkurensi worker, load test dengan profil beban pagi; tambahkan antrean (BullMQ) bila terbukti perlu |
| False reject tinggi menimbulkan keluhan | Zona abu-abu dengan review atasan, kalibrasi threshold, jalur koreksi |
| Dependensi native (onnxruntime, sharp) bermasalah di versi Node tertentu | Kunci versi, uji di image Docker produksi sejak awal |
| Kepatuhan data biometrik | Libatkan hukum atau DPO sejak Fase 0 |

**Asumsi (perlu dikonfirmasi)**

- Pegawai memakai smartphone modern dengan kamera depan memadai dan koneksi internet saat absen.
- Satu akun dipakai pada satu perangkat aktif.
- Radius 50 meter, tiga kantor, dan matriks izin kategori-lokasi sudah disepakati; target performa, threshold wajah/GPS, dan estimasi durasi masih usulan.

**Pertanyaan terbuka**

1. Jumlah pegawai sekitar 100-an (paling banyak ratusan). Berapa jumlah pastinya dan perkiraan puncak absen serentak? Jumlah lokasi awal sudah ditetapkan tiga.
2. Berapa koordinat pusat absensi yang dikonfirmasi di masing-masing kantor? Ketiganya memakai zona waktu Asia/Jakarta.
3. Apakah perlu integrasi SSO atau data pegawai dari sistem kepegawaian yang sudah ada?
4. Hosting di server sendiri (on-premise) atau cloud? Ini memengaruhi pilihan layanan pendukung.
5. Apa kebijakan retensi foto dan embedding yang diizinkan?
6. Apakah ada kebutuhan shift, dinas luar, atau lokasi berbentuk poligon (bukan hanya lingkaran)?
7. Apakah perlu mode offline atau toleransi jaringan buruk?
8. Platform mobile sudah diputuskan: **Android saja**, menggunakan React Native.
9. Perpindahan kantor sudah diputuskan: **boleh masuk dan pulang di kantor berbeda yang diizinkan**.
10. Berapa batas akurasi dan usia maksimum sampel GPS yang layak setelah uji lapangan dengan radius tetap 50 meter?

## 16. Kriteria Penerimaan Lokasi dan Kategori (P0)

Skenario berikut wajib diverifikasi untuk **check-in dan check-out**, dengan prasyarat autentikasi, perangkat, jadwal, wajah, liveness, dan kualitas GPS lainnya valid:

| Skenario | Hasil yang diharapkan |
| --- | --- |
| KPID berada dalam radius kantor KPID | Lolos validasi lokasi |
| KPID berada dalam radius kantor utama DISKOMINFO | Lolos validasi lokasi |
| KPID meminta kantor KI meskipun berada dalam radiusnya | Ditolak dengan OFFICE_NOT_ALLOWED |
| KI berada dalam radius kantor KI | Lolos validasi lokasi |
| KI berada dalam radius kantor utama DISKOMINFO | Lolos validasi lokasi |
| KI meminta kantor KPID meskipun berada dalam radiusnya | Ditolak dengan OFFICE_NOT_ALLOWED |
| Jarak hasil perhitungan server tepat 50 meter dari lokasi yang diizinkan | Lolos validasi radius |
| Jarak hasil perhitungan server lebih dari 50 meter dari seluruh lokasi yang diizinkan | Ditolak dengan GEOFENCE_OUT_OF_RANGE |
| Kategori kosong, tidak dikenal, atau tidak aktif | Ditolak dengan EMPLOYEE_CATEGORY_INVALID |
| Klien memalsukan kategori, jarak, atau hasil validasi | Nilai tersebut tidak menjadi dasar keputusan; backend memakai data pengguna dan perhitungan server |
| Kategori diubah admin ketika access token lama masih berlaku | Percobaan berikutnya memakai kategori terkini dari database |
| Lokasi yang diizinkan dinonaktifkan atau belum memiliki koordinat valid | Lokasi tidak ditampilkan sebagai pilihan aktif dan tidak dapat dipakai absen |
| Ada beberapa lokasi yang memenuhi radius | Hanya lokasi yang diizinkan dipertimbangkan; pemilihan mengikuti bagian 7 |
| Pengguna berperan admin dengan kategori KPID atau KI | Izin lokasi absensinya tetap mengikuti kategori |
| Konfigurasi lokasi atau kategori pengguna berubah | Riwayat tetap menyimpan kondisi saat absensi terjadi |
| Masuk di kantor utama lalu pulang di kantor kategori sendiri, atau sebaliknya | Diizinkan bila check-in sah pada jadwal yang sama dan seluruh verifikasi check-out lolos |
| Binding perangkat dengan platform selain Android | Ditolak; target mobile saat ini hanya Android |

**Alasan keputusan:** kategori dan peran dipisahkan agar hak akses fitur tidak memperluas izin lokasi; relasi kategori-lokasi mencegah aturan tersebar di kode; pemeriksaan server mencegah bypass lewat aplikasi mobile; snapshot absensi menjaga riwayat tetap dapat diaudit.

**Batas revisi v0.2:** revisi ini menetapkan kebutuhan lokasi dan kategori yang disepakati dalam percakapan. Usulan review teknis lain (liveness, enrollment, idempotency, dan sebagainya) belum otomatis menjadi keputusan final dan perlu diselesaikan sebelum implementasi modul terkait.

## 17. Catatan Implementasi Awal v0.3

Bagian ini mencatat hasil implementasi awal, bukan menyatakan seluruh milestone PRD selesai. Panduan menjalankan, kontrak signature Android, dan keterbatasan operasional tersedia di `README.md`; kontrak API aktif tersedia pada `/api/v1/openapi.json`.

### 17.1 Keputusan Implementasi dan Alasan

| Area | Keputusan awal | Alasan |
| --- | --- | --- |
| Akses data | `pg` dengan SQL terparameterisasi dan migrasi SQL terversi | PostGIS, constraint, dan row lock dapat diekspresikan langsung; menghindari lapisan ORM tambahan pada proyek awal. Pengganti usulan Kysely/Drizzle, bukan penggunaan beberapa akses data sekaligus. |
| Nonce dan idempotency | Persisten di PostgreSQL; Redis untuk rate limit | Keputusan absensi dan perlindungan replay/duplikasi bertahan saat Redis restart. |
| Enrollment | 3–5 foto berbeda, passive PAD, template terenkripsi, status pending sampai admin lain memverifikasi identitas | Kecocokan wajah berikutnya memerlukan pembanding yang identitasnya benar sejak awal. |
| Perangkat | Ed25519 public key, signature payload, satu perangkat aktif yang disetujui admin lain | Device ID saja tidak membuktikan kepemilikan perangkat; belum mengklaim hardware attestation. |
| Worker | Node + ONNX Runtime; adaptor SCRFD 640 dengan landmark, ArcFace 512 dimensi, dan PAD sesuai manifest | Model dimuat sekali, dipisahkan dari API, dengan kontrak preprocessing dan checksum eksplisit. Model/izin penggunaan tidak disediakan otomatis. |
| Liveness awal | Passive PAD pada satu selfie; tanpa instruksi kedip/tengok | Satu foto tidak dapat membuktikan urutan gerakan. Liveness aktif memerlukan kontrak video/frame dan evaluasi terpisah. |
| Foto mentah | Hanya di memori proses; tanpa object storage pada tahap ini | Membatasi penyimpanan biometrik selama retensi belum disepakati. Konsekuensi: belum ada bukti foto untuk review manual. |
| Waktu dan jadwal | Tanggal WIB, jadwal aktual satu pegawai per tanggal, waktu penerimaan server, constraint unik pegawai/jadwal/jenis | Mencegah duplikasi dan menghindari latensi inferensi mengubah waktu absensi. Shift lintas tanggal belum didukung. |
| Keputusan wajah | Threshold wajib hasil konfigurasi; fail closed jika belum siap | Tidak menetapkan angka akurasi atau meloloskan absensi dengan model/threshold contoh. |
| OpenAPI | Dokumen TypeScript dengan validasi otomatis | Kontrak tersedia untuk tim mobile; generasi seluruh skema dari Zod belum selesai. |

### 17.2 Cakupan yang Sudah Dibangun

- Login, rotasi refresh token, deteksi reuse, logout/pencabutan sesi, pemeriksaan user aktif dan kategori terkini.
- Buat/list/ubah/nonaktifkan pegawai, kategori KPID/KI, unit, konfigurasi dan nonaktifkan tiga kantor yang di-seed, serta pembatasan kewenangan admin.
- Binding/persetujuan/pencabutan perangkat Android, pembuatan challenge bertujuan ENROLL/CHECK_IN/CHECK_OUT.
- Enrollment pending, approval identitas, enkripsi template, dan penghapusan template di database aktif.
- Pembuatan jadwal aktual, check-in/check-out, pemilihan kantor berizin, PostGIS radius 50 meter, pemeriksaan akurasi/usia GPS, signature, idempotency, dan penolakan replay.
- Pemeriksaan ulang kategori, perangkat, template, dan konfigurasi kantor sebelum commit setelah inferensi; constraint unik dan row lock mencegah absensi ganda.
- Riwayat, status attempt, audit append-only, log tanpa foto/template/token, health/readiness, Docker untuk dependensi lokal, dan workflow CI.
- Worker inference beserta pengujian ONNX Runtime dengan graph sintetis khusus tes. Pengujian ini memvalidasi kontrak/pipeline, bukan kualitas pengenalan wajah nyata.

### 17.3 Pekerjaan yang Masih Diperlukan

- Konfirmasi koordinat ketiga kantor serta kalibrasi ambang akurasi dan usia GPS di lapangan. Kantor tetap nonaktif sampai diisi admin.
- Pilih bobot model recognition dan PAD dengan lisensi penggunaan operasional yang sesuai, isi manifest, tetapkan threshold dari pilot, dan uji spoofing/perangkat serta beban pagi.
- Putuskan retensi biometrik dan backup, prosedur penghapusan/pemulihan, konfigurasi produksi, dan integrasi Android/Play Integrity.
- Penyelesaian administratif NEEDS_REVIEW, koreksi/manual, laporan/ekspor, impor, notifikasi, dan multi-shift belum diimplementasikan. NEEDS_REVIEW belum menghasilkan absensi sah.
- Penambahan lokasi baru beserta perubahan matriks izin belum diekspos sebagai API; implementasi saat ini memakai tepat tiga lokasi dan empat relasi awal yang disepakati.
- PRD ini menjadi acuan kebutuhan. Endpoint/fitur yang masih berupa rencana tidak boleh dilaporkan sebagai selesai hanya karena tercantum pada bagian spesifikasi.

### 17.4 Verifikasi Implementasi Awal

- Typecheck dan build TypeScript lulus.
- 10 tes unit/kontrak/worker serta 36 tes integrasi PostgreSQL/PostGIS dan Redis lulus. Pengujian mencakup matriks enam kombinasi kategori-kantor, batas radius, perpindahan kantor, replay, retry identik, request bersamaan, rotasi token, binding perangkat, enrollment pending/approval, dan perubahan kategori/perangkat saat inferensi.
- Migrasi dijalankan dua kali; pemanggilan ulang tidak mengubah migrasi yang sudah diterapkan.
- Docker image berhasil dibangun; Argon2, Sharp, dan ONNX Runtime berhasil dimuat di container Linux.
- Audit dependensi npm saat pemeriksaan melaporkan nol kerentanan.
- Smoke test lokal: `/health` 200, `/api/v1/openapi.json` 200 dengan 26 path, endpoint profil tanpa autentikasi 401. `/ready` 503 sesuai harapan karena model/threshold belum dikonfigurasi; database dan Redis terhubung.
- Hasil ini belum membuktikan akurasi pengenalan wajah, efektivitas anti-spoofing, ketepatan GPS lapangan, atau kesiapan produksi.

### 17.5 Struktur Kode dan Audit Refactor

Struktur aktual mengikuti modular monolith dalam `src/modules`: admin, attendance, auth, device, face, office, dan sso. Setiap domain memisahkan route, controller, schema validasi, service bisnis, serta model akses SQL. Konfigurasi berada pada `src/config`, koneksi/transaksi/audit database pada `src/database`, penanganan error HTTP pada `src/middleware`, dan utilitas lintas domain pada `src/shared`. Worker ONNX tetap pada `src/worker` dan tidak memuat lapisan HTTP/domain API.

Audit struktur menghapus ekspor compatibility lama pada root `src` dan implementasi penerbitan token yang terduplikasi. Pagination tidak lagi bergantung pada controller admin; validasi gambar dipakai bersama API dan worker. Aturan bisnis dan kontrak HTTP dipertahankan. `docs/architecture.md` menjelaskan alasan pemisahan dan aturan dependency; `npm run check:architecture` memeriksa batas modul dan siklus import statis. Build membersihkan output `dist` sebelum kompilasi agar file hasil build sebelum refactor tidak tertinggal.

Verifikasi setelah refactor: typecheck, formatting, pemeriksaan arsitektur, build lokal, 10 tes unit/kontrak/worker, 36 tes integrasi, migrasi ulang, dan smoke test HTTP lulus. Server lokal sudah dimuat ulang. Rebuild image Docker setelah refactor belum terverifikasi selesai karena instalasi dependensi dari registry berlangsung lambat; build tersebut dihentikan. Hasil Docker pada bagian 17.4 adalah hasil sebelum refactor.

### 17.6 Login Internal untuk Staging

Prioritas saat ini adalah login internal; SSO tetap nonaktif sampai Google Console dan kredensial integrasi tersedia. Callback SSO tidak diperlukan untuk login internal. Kontrak serta prosedur staging dan migrasi berada di `docs/internal-auth.md`.

- Access JWT maksimal 10 menit dengan verifikasi algoritme HS256, tipe, issuer, audience, waktu, dan claim identitas sesi. Sesi aktif serta role/kategori diperiksa kembali melalui database pada request terlindungi.
- Refresh rotation mempertahankan batas absolut 30 hari sejak login. Refresh token hanya disimpan sebagai hash; reuse mencabut seluruh keluarga sesi. Row lock pengguna mencegah logout bersamaan dengan refresh meninggalkan token anak aktif.
- Logout semua sesi dan perubahan password tersedia. Perubahan password membutuhkan password lama, password baru 15–128 karakter, hash Argon2id 64 MiB/tiga iterasi/parallelism 1, serta pencabutan seluruh sesi. Login memeriksa ulang hash dalam transaksi untuk menolak hasil verifikasi password lama yang sudah berubah.
- Batas operasi Argon2 empat per proses membatasi penggunaan memori. Login mempunyai batas IP dan kegagalan per akun lintas IP; refresh menggunakan kuota terpisah agar tidak menghabiskan kuota login jaringan kantor. Redis menyimpan penghitung, termasuk untuk beberapa proses API.
- Mode production menolak request bisnis tanpa HTTPS. Alamat proxy tepercaya diatur eksplisit melalui `TRUST_PROXY`; header forwarded dari koneksi tak tepercaya tidak dapat meloloskan syarat HTTPS. Konfigurasi proxy dan isolasi jaringan harus diuji di staging.
- `/ready/auth` memeriksa database/kolom autentikasi dan Redis tanpa mensyaratkan worker wajah. `/ready` tetap memeriksa kesiapan absensi termasuk worker. Model belum tersedia, sehingga kesiapan login tidak berarti absensi siap operasional.
- Pengujian regresi mencakup kegagalan kredensial generik, token salah/tanpa claim wajib/kedaluwarsa, batas kegagalan akun lintas IP, login sukses berulang, refresh pada IP bersama, expiry absolut, pencabutan sesi, perubahan password, serta race logout/refresh. Tidak ada perubahan skema pada hardening ini. Build Docker dan deployment HTTPS perlu diverifikasi ulang pada lingkungan staging sebenarnya.

Verifikasi lokal 20 Oktober 2026: 19 tes unit/kontrak/worker dan 48 tes integrasi lulus, bersama typecheck, formatting, pemeriksaan arsitektur 54 source tanpa siklus runtime, serta build. Audit npm melaporkan nol kerentanan saat pemeriksaan. Migrasi ulang berhasil tanpa menerapkan ulang file lama. Server hasil build dimuat ulang: `/health` dan `/ready/auth` 200, metode login local=true/sso=false, profil tanpa token 401, dan OpenAPI memuat 28 path. `/ready` tetap 503 karena worker/model wajah belum siap. Hasil lokal ini tidak menjamin tidak ada bug dan belum memvalidasi hosting staging atau akurasi biometrik.

### 17.7 Deployment Container Aplikasi

Sesuai arahan deployment, PostgreSQL/PostGIS dan Redis menggunakan layanan eksternal. Compose aplikasi hanya menjalankan API dan worker wajah opsional melalui profil `biometrics`; tidak menyediakan service atau volume database/Redis. Database dan Redis sementara pada CI hanya digunakan untuk isolasi tes integrasi. Container layanan lokal yang sudah ada tidak dihapus otomatis saat konfigurasi berubah.

API dan worker menggunakan image non-root yang sama, filesystem read-only, serta health check terpisah. Port API dipublikasikan hanya pada loopback host untuk reverse proxy HTTPS; worker hanya diakses melalui jaringan Compose. Migrasi tetap dijalankan terpisah sebelum aplikasi. Konfigurasi koneksi, proxy, model, dan langkah menjalankan container dijelaskan dalam `docs/docker.md`.

Verifikasi 20 Oktober 2026: konfigurasi Compose valid dengan service default hanya API dan profil biometrik menambahkan worker. Image terbaru berhasil dibangun setelah cache lokal paket ONNX dengan versi yang sama dipakai untuk mengatasi unduhan lambat. Smoke test Linux menjalankan hash/verifikasi Argon2, pemrosesan Sharp, serta import ONNX Runtime sebagai UID 1000 pada filesystem read-only. Container API sementara terhubung ke layanan database/Redis yang sudah berjalan di luar container aplikasi: `/ready/auth` 200 dan login HTTP mode production ditolak `HTTPS_REQUIRED`. Container smoke test sudah dihapus; container dan volume database/Redis lama tetap dipertahankan. Ini belum menguji model wajah operasional atau reverse proxy HTTPS staging.

### 17.8 Keputusan Geofencing dan Perbaikan Startup

Pengguna menetapkan PostGIS sebagai penentu radius setelah meninjau perubahan Redis GEO. Implementasi memakai `ST_DWithin` pada geography dengan radius 50 meter dan `ST_Distance` dengan spheroid WGS84. Titik dibentuk dari latitude/longitude asli pada query. Redis tetap digunakan untuk rate limiting; tidak diteruskan ke workflow geofencing dan tidak menyimpan key GEO.

Perbaikan DevOps untuk environment runtime Dokploy, `.env` opsional, biometrik yang dapat dinonaktifkan tanpa mematikan login, migrator dalam image, auto-migration opsional, pool/timeout, dan health check dipertahankan. PostgreSQL dan Redis tetap layanan eksternal. PostGIS harus tersedia pada server PostgreSQL eksternal; `004_postgis_geofencing.sql` mengaktifkan extension. Migration 001–003, kedua baseline, koordinat numeric, geography legacy, serta trigger kompatibilitas tidak diubah atau dihapus. Database yang sempat memakai baseline numeric dapat di-upgrade tanpa reset data. Pisahkan role migrasi dari runtime dan gunakan release migration pada produksi bila diperlukan.

Error lokal `HTTP listener failed` disebabkan port 3000 masih dipakai proses API lama. Logging listener sekarang memakai event `listening` pada HTTP server, sehingga gagal bind tidak lagi mencetak sukses startup. Error menyertakan kode seperti `EADDRINUSE` dan port. Kegagalan verifikasi skema menyebut migration yang tertunda/berubah tanpa mencetak credential.

Verifikasi 20 Oktober 2026: 33 tes unit/kontrak/worker dan 66 tes integrasi termasuk upgrade legacy lulus; typecheck, format, arsitektur 58 source tanpa siklus runtime, serta build lulus. Tes radius memproyeksikan titik dari koordinat asli pada empat arah, mencakup 49,75/49,99 meter yang diterima dan 50,01/50,20 meter yang ditolak. Tes proses membuktikan port terpakai menghasilkan `EADDRINUSE`, exit 1, dan tidak mencetak sukses startup. Migrasi 004 lokal berhasil dengan data tiga kantor tetap utuh. Image terbaru berhasil dibangun; container production non-root/read-only melewati auto-migration, `/ready/auth` 200, hash/verifikasi Argon2, pemrosesan Sharp, dan import ONNX Runtime. Model biometrik serta reverse proxy staging sebenarnya tetap memerlukan pengujian operasional.

### 17.9 Polygon Kantor dengan Batas 50 Meter

Pengguna menegaskan tiga lokasi dan alamat pada 21 Oktober 2026:

| Kode | Kantor | Alamat dari pengguna | Titik pusat absensi |
| --- | --- | --- | --- |
| DISKOMINFO_PROVSU | Dinas Komunikasi dan Informatika Provinsi Sumatera Utara | Jl. HM. Said No.27, Gaharu, Kec. Medan Tim., Kota Medan, Sumatera Utara 20233 | Menunggu pin/latitude-longitude terverifikasi |
| KPID_SUMUT | Komisi Penyiaran Indonesia Daerah Sumatera Utara | Jl. Adinegoro No.7, Gaharu, Kec. Medan Tim., Kota Medan, Sumatera Utara 20235 | Menunggu pin/latitude-longitude terverifikasi |
| KI_SUMUT | Komisi Informasi Sumatera Utara | Jl. Alfalah No.22, Suka Maju, Kec. Medan Johor, Kota Medan, Sumatera Utara 20146 | Menunggu pin/latitude-longitude terverifikasi |

KPID boleh absen di DISKOMINFO_PROVSU dan KPID_SUMUT; KI boleh absen di DISKOMINFO_PROVSU dan KI_SUMUT. Izin silang KI ke KPID dan KPID ke KI tetap ditolak. Ketentuan berlaku untuk masuk dan pulang, termasuk perpindahan kantor yang diizinkan.

Migration 005 dari perubahan Antigravity dipertahankan. Migration 006 menyimpan alamat, menetapkan radius 50 meter, memvalidasi polygon, serta membentuk ulang buffer saat pusat berubah. Endpoint admin dengan pasangan latitude/longitude membentuk polygon otomatis melalui geography buffer 50 meter, quad_segs=64. Area custom dapat mempersempit cakupan; seluruh interior ring dipertahankan dan polygon menyilang ditolak. Keputusan akhir selalu membutuhkan ST_Covers serta batas geodesi ST_DWithin 50 meter. Radius selain 50 ditolak. Audit mencatat konfigurasi tersimpan setelah perubahan.

Nama/alamat belum cukup menetapkan titik pusat pada ketelitian batas 50 meter. Pencarian publik mengonfirmasi alamat tetapi belum memberi titik pusat ketiganya yang dapat dipastikan. Tidak ada koordinat perkiraan atau (0,0) yang di-seed sebagai lokasi operasional. Kantor tanpa pusat dan kebijakan GPS tidak dapat diaktifkan. Pusat yang tepat perlu pin Google Maps atau latitude/longitude dari titik kantor yang ditentukan pengguna/admin.

Compose datastore kini hanya memuat PostgreSQL/PostGIS, password provisioning wajib diisi, dan port host dibatasi loopback. API dan database perlu jaringan privat bersama di Dokploy; Redis tetap layanan eksternal. Image PostgreSQL hasil build telah diuji startup segar dengan extension postgis dan postgis_topology aktif. Pemeriksaan akhir: 33 tes unit/kontrak/worker serta 69 tes integrasi termasuk matriks izin kategori, validasi polygon, geofencing 50 meter, dan upgrade legacy lulus; typecheck, format, arsitektur dan build TypeScript lulus. Container uji sudah dihapus. Model wajah, pin kantor nyata, dan jaringan/proxy server masih memerlukan konfigurasi operasional.


### Pusat kantor dari pin Google Maps (21 Oktober 2026)

Koordinat berikut menggunakan titik tempat pada tautan Google Maps yang diberikan pengguna, bukan pusat viewport peta. Urutan kolom: latitude, longitude.

| Kantor | Latitude | Longitude | Sumber |
| --- | --- | --- | --- |
| Diskominfo Provsu | 3.601785 | 98.682827 | [Pin Diskominfo](https://maps.app.goo.gl/VSY7gHx8Z6TsC2CA9) |
| KPID Sumut | 3.601287 | 98.6823199 | [Pin KPID](https://maps.app.goo.gl/QxJFYrK3XUDHjVPdA) |
| KI Sumut | 3.5464663 | 98.6946129 | [Pin KI](https://maps.app.goo.gl/DUhWXSKG119ffTfi8) |

Migration 007 mengisi pusat kantor yang belum memiliki koordinat maupun polygon. Trigger migration 006 otomatis membuat polygon buffer 50 meter. Koordinat atau polygon yang sudah dikonfigurasi admin dipertahankan; untuk kantor tersebut, admin perlu menyelaraskan pusat melalui endpoint PATCH kantor jika diperlukan. Jalankan migrasi dengan npm run db:migrate (lokal) atau npm run db:migrate:production (hasil build).

Migration ini tidak mengaktifkan kantor atau mengisi batas akurasi/umur lokasi GPS. Admin harus menentukan kebijakan GPS dan mengaktifkan kantor sebelum absensi digunakan. Kebijakan kategori tetap: KPID boleh di Diskominfo dan KPID; KI boleh di Diskominfo dan KI. Izin kategori diperiksa bersama polygon dan batas jarak geography 50 meter. Polygon antar kantor yang berdekatan dapat beririsan; sistem menentukan kantor dari lokasi dan izin kategori pengguna. Ketepatan pin terhadap titik absensi fisik tetap perlu diuji di lokasi.

Verifikasi setelah penetapan pin: 33 tes unit/kontrak/worker dan 70 tes integrasi lulus pada database PostGIS serta Redis sementara. Pengujian mencakup koordinat tiga kantor, polygon valid berjarak 50 meter, izin kategori, preservasi konfigurasi lama, dan migrasi berulang. Typecheck, format, pemeriksaan arsitektur, dan build TypeScript lulus. Migration 007 belum diterapkan pada database lokal/server pengguna; jalankan migrasi pada environment tujuan.


### 17.10 Perbaikan QA 22 Oktober 2026: checksum, enrollment, dan jadwal

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

Verifikasi 22 Oktober 2026: 44 tes unit/kontrak/worker serta 82 tes integrasi lulus pada PostgreSQL/PostGIS dan Redis sementara. Tes mencakup ledger LF/CRLF tanpa perubahan checksum lama, penolakan perubahan SQL, rollback migrasi saat jadwal lama lintas tanggal ditemukan, batas tanggal WIB/UTC, reset saat inferensi, enrollment paralel, dan perubahan status akun/perangkat/template sebelum penyimpanan. Typecheck, formatting, pemeriksaan arsitektur dan build TypeScript lulus. Database aplikasi lokal/server belum dimigrasikan; migrasi baru hanya diuji pada database sementara yang sudah dihapus.


### 17.11 Kesiapan API untuk panel admin web

Panel admin disepakati sebagai project web terpisah. API menambahkan sesi browser HttpOnly/CSRF dengan batas absolut 8 jam, Google native ID token dan Google web authorization-code/PKCE dengan callback API. Identitas Google harus dipetakan admin ke pegawai yang sudah ada; Google tidak menentukan role atau kategori. Endpoint absensi dan jadwal admin, detail pegawai, filter/pagination beserta total, approval list dan error per field tersedia tanpa mengubah alur Android. Jadwal berabsensi tidak boleh diubah. Data absensi kategori biasa dibatasi kategori pegawai terkini dan kategori pada event; riwayat lintas kategori hanya super admin. Migration 010 additive, flag fitur default nonaktif. Detail kontrak, environment, deployment dan batas fitur tercatat di docs/admin-panel-api.md. Integrasi Google nyata tetap memerlukan credential, domain dan pengujian staging.

Verifikasi kesiapan panel 22 Oktober 2026: 57 tes unit/kontrak/worker dan 98 tes integrasi lulus. Pengujian mencakup token Google dengan kunci RSA lokal, pemisahan sesi WEB/MOBILE, cookie Secure/HttpOnly, origin/CSRF, rotasi/reuse dan batas absolut sesi web 8 jam, callback terikat browser, akses lintas kategori, pagination, update jadwal beralasan serta penguncian jadwal berabsensi, dan preservasi sesi lama saat migration 010. Typecheck, format, arsitektur dan build lulus. Tes Google terkontrol bukan pengujian kredensial asli di staging. Migration 010 belum diterapkan ke database aplikasi.

### 17.12 Login pertama Google berdasarkan email pegawai

Revisi kebutuhan 22 Oktober 2026: data email, NIP, nama, dan penempatan berasal dari database instansi yang diprovisikan admin. Pada Android, backend dapat menautkan login Google pertama berdasarkan email dari ID token terverifikasi, jika `GOOGLE_EMAIL_LINKING_ENABLED=true`. Super admin terlebih dahulu mengizinkan akun aktif berkategori KPID/KI, role EMPLOYEE/VERIFIER, auth_mode SSO/BOTH, dan izin sekali pakai `google_email_linking_allowed=true`. Default flag global dan izin pegawai false menjaga perilaku akun lama. Izin dipakai dalam transaksi bersama pemetaan dan sesi; unlink tidak mengaktifkannya kembali.

Email wajib verified dan berada pada Gmail atau Google Workspace yang memiliki claim hd. Backend tidak menerima email bebas dari FE untuk autentikasi, tidak membuat pegawai baru, tidak menimpa nama/NIP/penempatan dari Google, dan tidak memindahkan tautan identitas. Setelah berhasil login, FE mengambil profil melalui GET /api/v1/me. Login berikutnya menggunakan issuer/sub, sehingga perubahan email Google tidak memindahkan identitas. Admin dan panel web tetap memerlukan pemetaan eksplisit. Migration 011 hanya menambah kolom izin default false; profil dan pemetaan lama dipertahankan. Detail konfigurasi dan endpoint ada di docs/admin-panel-api.md.

Verifikasi: 70 tes unit/kontrak/worker serta 114 tes integrasi lulus, termasuk upgrade schema dan baseline legacy pada database uji terpisah. Pencocokan token Google memakai kunci lokal/provider terkontrol, belum membuktikan login Google nyata di staging. Data pegawai asli belum diimpor.

### 17.13 Pengingat check-in melalui FCM

Aturan yang disepakati: batas tepat waktu 08.00 WIB; sesudahnya tetap hadir dengan label terlambat. Konfigurasi jadwal menggunakan starts_at pukul 08.00 WIB dan grace_minutes 0. Worker notifikasi menghitung pengingat lima menit sebelum batas starts_at + grace_minutes, sehingga pengingat untuk jadwal tersebut mulai dikirim 07.55 WIB. Tidak ditambahkan jam tutup check-in yang menolak pegawai terlambat.

Backend menyediakan POST/DELETE /api/v1/devices/:id/push-token. Registrasi token memerlukan JWT sesi MOBILE aktif, perangkat ACTIVE milik pengguna, dan signature Ed25519 atas user/perangkat/hash token. Token diikat pada keluarga sesi agar refresh rotation tetap berfungsi dan logout/revocation menghentikan kelayakan pengiriman. Project FCM mengikuti FE, yaitu absensi-439de, terpisah dari konfigurasi Google SSO. Private key hanya tersedia pada worker melalui file privat; tidak masuk Git/image/APK.

Migration 012 menambah token perangkat dan antrean persisten PostgreSQL tanpa mengganti data akun/sesi/jadwal. Worker terpisah menggunakan claim/lease, heartbeat, unique delivery per jadwal, retry transient terbatas dan pemeriksaan ulang kelayakan sebelum pengiriman. Check-in diterima membatalkan pengingat yang belum dikirim. Token invalid dibuang hanya jika nilainya belum berubah. Payload tidak memuat NIP, wajah atau koordinat; TTL dibatasi sisa waktu hingga deadline dan memuat expires_at untuk FE. Pengiriman at-least-once dan penerimaan Android tidak dapat dijamin tepat waktu; FE perlu menangani tag/ID notifikasi, izin Android dan deduplikasi.

FCM_ENABLED default false. Jalankan migration sebelum worker, pasang service account read-only, aktifkan profil Compose notifications atau service worker Dokploy tersendiri. Detail endpoint, signature, keluarga sesi, konfigurasi, monitoring dan rollback tersedia di docs/fcm.md. Data pegawai asli dan token perangkat nyata masih menunggu FE/pemilik data.

Verifikasi 22 Oktober 2026: 75 tes unit/kontrak/worker dan 136 tes integrasi lulus. Tes mencakup WIB 07.55/08.00, check-in yang sudah berhasil, sesi/perangkat dicabut, refresh rotation, token berubah saat pengiriman, retry, lease recovery, worker paralel, perubahan jam/tanggal jadwal dan preservasi migrasi. Typecheck, format, arsitektur, build, validasi Compose, image Docker dan audit dependency lulus. Kredensial nyata berhasil dimuat tanpa pengiriman; delivery FCM ke Android belum diuji karena registration token belum tersedia.

### 17.14 Konfigurasi awal pilot biometrik

Pemilik proyek mengizinkan threshold awal agar tiga peserta dapat mencoba enrollment dan absensi setelah mobile siap. Konfigurasi eksplisit tanpa secret disimpan pada config/biometric-pilot.env, khusus research-buffalo-sc-minifasnet-v2-v1: match 0.80, review 0.70, liveness 0.90, kualitas 1.00. Match mengikuti cutoff pemilik proyek; rentang review 0.10 di bawah match merupakan kebijakan pilot, tidak membuat attendance diterima. Liveness mensyaratkan skor softmax hidup minimal sembilan kali jumlah skor spoof; bukan probabilitas keaslian. Kualitas 1.00 memenuhi referensi manifest secara utuh: ukuran sisi wajah minimal 100 piksel dan varians Laplacian minimal 100 pada aligned face 112 x 112. Referensi manifest sendiri masih heuristik eksperimen.

Nilai ini belum dikalibrasi dan tidak dimuat otomatis di deployment. Operator menerapkannya secara eksplisit untuk pilot terisolasi; model, worker, kredensial, perangkat, kantor dan jadwal tetap diperlukan. Uji wajah asli lintas sesi, wajah berbeda serta spoof sebelum menyimpulkan kecocokan threshold. Detail dasar keputusan, sumber upstream, cara menerapkan, dan keterbatasan tersedia pada docs/biometric-local-research.md. Enrollment dalam implementasi saat ini masih PENDING dan memerlukan persetujuan admin; aktivasi enrollment mandiri yang dibahas belum diterapkan. Penyelesaian NEEDS_REVIEW absensi juga belum tersedia.

Verifikasi konfigurasi pilot: 79 tes unit/kontrak/worker lulus, termasuk batas tepat dan di bawah threshold liveness/kualitas serta versi model berbeda. Typecheck dan pemeriksaan checksum/inference startup model nyata lulus. Belum ada uji wajah peserta atau bukti akurasi produksi.
