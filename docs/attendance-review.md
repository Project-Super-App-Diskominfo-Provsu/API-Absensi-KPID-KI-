# Enrollment mandiri dan penyelesaian review absensi

Ketentuan berikut berlaku mulai perubahan 26 Oktober 2026 dan menggantikan panduan lama yang menyebut enrollment baru selalu PENDING atau NEEDS_REVIEW belum mempunyai penyelesaian admin.

## Alur mobile setelah login

1. Login berhasil dan ambil profil dari `GET /api/v1/me`; nama, NIP dan penempatan tetap berasal dari database instansi.
2. Periksa perangkat melalui alur `/devices`; enrollment tetap membutuhkan perangkat ACTIVE dan private key Ed25519 yang cocok. Pengajuan perangkat baru masih memerlukan persetujuan admin. Perubahan ini hanya menghilangkan persetujuan enrollment, tidak mengubah otorisasi perangkat.
3. Jika belum mempunyai template aktif, tampilkan pendaftaran wajah pada dashboard. Minta challenge ENROLL, ambil 3–5 foto kamera berbeda, tampilkan persetujuan pemrosesan dan kirim signature sesuai kontrak yang ada ke `POST /api/v1/face/enroll`.
4. API tetap memeriksa akun, perangkat, challenge sekali pakai, signature, file, satu wajah, kualitas, liveness, versi model, konsistensi antar foto, serta reset/concurrent enrollment. Respons berhasil HTTP 201 mempunyai `data.status=ACTIVE`. Tidak ada mode auto-approve tambahan di environment.
5. Template berupa embedding terenkripsi; foto mentah tidak disimpan. `approved_by` tetap NULL karena aktivasi mandiri bukan persetujuan petugas. Audit `FACE_ENROLL_ACTIVATED` mencatat metode SELF_ENROLLMENT.
6. Setelah sukses, refresh profil dan izinkan alur absensi. Pendaftaran ulang tetap membutuhkan reset admin. Akun Google/email terdaftar membuktikan akses akun, bukan hubungan wajah dengan NIP; aktivasi mandiri adalah kebijakan yang dipilih pemilik proyek.

Template PENDING lama tidak dipromosikan massal. Endpoint review enrollment lama tetap tersedia untuk admin; alternatifnya reset lalu peserta mendaftar ulang. Template ACTIVE lama dan key enkripsi tidak diubah.

## Respons absensi yang memerlukan review

Jika similarity berada pada rentang `[review,match)`, sementara seluruh validasi lain berhasil, API mengembalikan HTTP 202:

```json
{"data":{"attempt_id":"UUID_ATTEMPT","status":"NEEDS_REVIEW","reason_code":"FACE_REVIEW_REQUIRED"}}
```

Belum ada attendance sah pada tahap ini. FE menampilkan status menunggu review dan memeriksa `GET /api/v1/attendance/attempts/:id` ketika halaman diperbarui atau melalui polling terbatas. Tidak ada FCM khusus hasil review pada perubahan ini.

Backend menyimpan snapshot validasi yang diperlukan untuk review: jadwal, kategori saat kejadian, kantor, koordinat/akurasi/waktu capture, perangkat, ID template, skor wajah/kualitas/liveness dan kebijakan model. Tidak menyimpan foto, embedding tambahan, nonce atau signature di bukti review. Tidak ada endpoint untuk admin mengubah koordinat, waktu, skor atau snapshot tersebut.

## Endpoint admin

Semua endpoint memakai autentikasi aplikasi yang sama. JWT admin dapat dipakai melalui kontrak bearer yang ada; jika memakai panel web, perlindungan origin/CSRF sesi web tetap berlaku.

| Endpoint | Kegunaan |
| --- | --- |
| GET /api/v1/admin/attendance-reviews | Antrean/riwayat; status=PENDING/APPROVED/REJECTED, user_id, limit dan offset |
| GET /api/v1/admin/attendance-reviews/:attempt_id | Bukti dan status review |
| PATCH /api/v1/admin/attendance-reviews/:attempt_id | Keputusan final APPROVED/REJECTED |

Default daftar PENDING, limit 25, maksimum 100; response `data` berupa array dan `meta` memuat limit/offset/total. ADMIN kategori hanya melihat dan memproses pegawai EMPLOYEE/VERIFIER dengan kategori saat kejadian serta kategori sekarang yang sama dengan kewenangannya. SUPER_ADMIN dapat lintas kategori. Review sendiri selalu dilarang.

Contoh persetujuan:

```json
{
  "status": "APPROVED",
  "reason": "Identitas pegawai telah diverifikasi langsung oleh petugas",
  "identity_verified": true
}
```

`identity_verified=true` hanya boleh diberikan setelah admin melakukan pemeriksaan identitas yang nyata. Aplikasi tidak menyimpan foto sehingga panel tidak mempunyai foto bukti untuk dibandingkan. Checkbox ini bukan hasil face recognition tambahan dan tidak boleh otomatis diisi true oleh FE tanpa tindakan petugas.

Contoh penolakan:

```json
{
  "status": "REJECTED",
  "reason": "Identitas tidak dapat diverifikasi oleh petugas"
}
```

Alasan 5–500 karakter wajib untuk kedua keputusan. Persetujuan juga wajib identity_verified=true. Respons keputusan HTTP 200 memuat `data.attempt_id`, `data.status` APPROVED/REJECTED dan `data.attendance` (null untuk penolakan). Keputusan ulang atau bersamaan yang kalah menerima HTTP 409 REVIEW_ALREADY_RESOLVED; gunakan GET detail untuk mengetahui keputusan yang sudah tersimpan.

## Aturan persetujuan

Persetujuan hanya menggantikan keputusan pencocokan pada rentang review. API memeriksa kembali akun aktif, template yang sama, versi/threshold model, perangkat aktif, izin kantor kategori, polygon dan jarak 50 meter, akurasi/lokasi terhadap waktu request asli, jadwal yang sama, izin/cuti serta keunikan pasangan check-in/out. Tidak mengonsumsi ulang challenge atau menjalankan inference baru.

Waktu attendance adalah `received_at` request asli, bukan waktu admin menekan setuju. PRESENT/LATE dan EARLY_LEAVE/ON_TIME dihitung dari waktu asli tersebut. Review yang dilakukan setelah jendela freshness GPS tidak otomatis ditolak sebagai lokasi usang: umur lokasi dinilai terhadap waktu capture request asli. Perubahan konfigurasi/jadwal/kategori/template setelah capture dapat membuat persetujuan ditolak dan review tetap PENDING agar admin dapat menolaknya dengan alasan.

Jika sudah ada attendance sah untuk slot yang sama dari request berikutnya, persetujuan ditolak DUPLICATE_ATTENDANCE. CHECK_OUT tetap memerlukan CHECK_IN. Keputusan dan insert attendance berada dalam satu transaksi dengan lock pengguna lalu attempt, sehingga request bersamaan tidak membuat attendance ganda. Jadwal historis, biometrik gagal/liveness gagal, lokasi di luar area dan attempt REJECTED/ERROR tidak dapat dijadikan attendance melalui endpoint ini.

Setelah APPROVED, attempt menjadi ACCEPTED. `response.data` pada endpoint attempt memuat hasil attendance dengan `verification_status=ACCEPTED` dan `verification_method=ADMIN_REVIEW`; histori attendance dan laporan admin mencatat event normal dengan skor asli dan metadata kebijakan review. Penolakan membuat attempt REJECTED dengan reason_code ATTENDANCE_REVIEW_REJECTED tanpa attendance. Audit mencatat actor, target, alasan dan attendance ID untuk persetujuan.

## Migrasi dan rollout

Jalankan migration `015_attendance_reviews.sql` sebelum runtime baru. Lokal: `npm run db:migrate`; image: `npm run db:migrate:production`, atau migrasi startup yang sudah dikonfigurasi. Tidak ada environment/secret baru. Deploy runtime baru setelah menghentikan dan menyelesaikan request enrollment/capture pada versi lama agar satu rollout tidak menghasilkan perilaku campuran.

Migrasi hanya menambah tabel/index review; tidak mengubah template, attendance, akun atau attempt lama. Attempt NEEDS_REVIEW dari versi lama tidak mempunyai snapshot validasi; SUPER_ADMIN dapat melihat dan menolaknya, tetapi persetujuan menerima REVIEW_EVIDENCE_UNAVAILABLE. Jangan menebak atau merekonstruksi bukti dari koordinat/wajah yang tidak pernah disimpan. Pegawai perlu mencoba lagi jika waktu/jadwal memungkinkan; koreksi historis di luar attempt valid memerlukan alur terpisah yang belum diimplementasikan.

Rollback image tidak menghapus tabel atau keputusan yang sudah dibuat. Runtime lama tidak menyediakan penyelesaian review dan kembali memakai enrollment PENDING. Pertahankan seluruh data/migration ledger; jangan menurunkan status template atau menghapus attendance yang sudah diterima. Tidak ada migrasi down destruktif pada rollout ini.
