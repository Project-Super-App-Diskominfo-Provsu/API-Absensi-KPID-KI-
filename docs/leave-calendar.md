# Izin, kalender dan jadwal kerja

Migration `013_holidays_and_leaves.sql` memperkenalkan kalender dan izin. Migration `014_correct_2026_holidays.sql` memperbaiki label/tanggal seed yang keliru dan melengkapi kalender 2026 berdasarkan [SKB yang dipublikasikan Sekretariat Negara](https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026). Jangan mengedit migration 013 yang sudah diterapkan.

## Rollout dan preservasi data

Jalankan migrasi sebelum runtime baru, menggunakan `npm run db:migrate` di lokal atau `npm run db:migrate:production` dalam image. Migrasi 014 mengubah hanya tiga label/type seed yang persis sesuai nilai salah, menambahkan tanggal yang belum ada, dan mempertahankan ID serta override operator. Jadwal, attendance, akun dan template biometrik tidak diubah. Karena override operator dipertahankan, DBA/admin perlu memeriksa kalender khusus instansinya sendiri.

Jadwal yang sudah dibuat menggunakan kalender lama tidak otomatis dihapus atau digeser. Periksa jadwal pada hari libur yang dikoreksi, terutama 24 Desember 2026. Endpoint patch jadwal bukan endpoint penghapusan. Jangan menghapus jadwal yang mempunyai attendance. Jika perlu pembatalan jadwal tanpa attendance, sepakati pekerjaan administrasi terpisah yang dapat diaudit; jangan menganggap generator menghapus jadwal lama. `ON CONFLICT DO NOTHING` mempertahankan jadwal sebelumnya.

Rollback image tidak membatalkan migrasi kalender. Koreksi kalender bersifat additive dan kompatibel dengan runtime sebelumnya; pertahankan datanya. Mengembalikan label salah bukan bagian rollback. Jika tanggal perlu direvisi lagi, gunakan perubahan admin atau migrasi koreksi yang ditinjau.

## Aturan izin

- Pengajuan harus milik akun aktif. Pengajuan bersamaan diserialisasi dengan lock baris pengguna sebelum pemeriksaan overlap dan insert; writer aplikasi harus mengikuti urutan pengguna lalu permohonan.
- Rentang PENDING/APPROVED yang beririsan tidak boleh diajukan kembali melalui API. Untuk data lama yang sudah overlap, persetujuan ulang memeriksa izin APPROVED lain agar hanya satu dapat disetujui.
- Admin tidak boleh meninjau permohonan sendiri, termasuk SUPER_ADMIN. Gunakan admin lain yang berwenang.
- Admin kategori hanya dapat meninjau kategori penempatan yang sama. Admin tanpa kategori tidak mendapat akses seluruh data. SUPER_ADMIN dapat meninjau lintas kategori, tetap tanpa persetujuan sendiri.
- SAKIT/IZIN/CUTI sehari penuh tidak boleh disetujui jika ada attendance pada salah satu tanggal rentangnya: HTTP 409 `LEAVE_ATTENDANCE_CONFLICT`. Permohonan tetap PENDING, admin dapat menolak dan pegawai mengajukan rentang yang benar. Izin sebagian hari belum diimplementasikan.
- Izin disetujui memblokir CHECK_IN pada tanggal terkait. CHECK_OUT tetap dapat menutup CHECK_IN lama jika data legacy sudah mempunyai izin yang berkonflik; aturan pasangan check-in/out dan validasi lain tetap berlaku.
- DINAS_LUAR mempertahankan perilaku sebelumnya: tidak memblokir attendance, tetapi tidak membebaskan pemeriksaan lokasi, wajah, perangkat atau jadwal. Tidak ada absensi otomatis atau izin absen dari lokasi sembarang.
- Filter kategori jenis izin pada `GET /api/v1/admin/leaves?category=CUTI` diterapkan terpisah dari kategori penempatan KPID/KI.

Lock aplikasi bukan pengganti otorisasi database: role runtime dan operasi manual harus dibatasi. Tidak ditambahkan constraint overlap baru yang berpotensi menolak seluruh migrasi karena data lama; jika ada writer eksternal di luar API, perlindungan lintas writer perlu dirancang terpisah.

## Jadwal dan notifikasi

Default jadwal tetap mengikuti implementasi: Senin–Kamis 08.00–16.30 WIB, Jumat 08.00–17.00 WIB; akhir pekan memerlukan jadwal eksplisit. Hari kalender dihitung independen dari timezone host; iterasi generator menggunakan tanggal UTC agar DST host tidak menggeser tanggal WIB yang diminta. Ini tidak mengubah timezone bisnis atau aturan toleransi.

Generator melewati hari libur jika `skip_holidays=true`. Notifikasi memeriksa hari libur dan semua jenis izin APPROVED saat enqueue dan sebelum send. Job lama yang tidak lagi layak menjadi SKIPPED dengan alasan HOLIDAY/ON_LEAVE. Perubahan sesudah pengiriman mulai masih dapat beririsan dengan panggilan provider; tidak ada jaminan pembatalan push yang sudah diterima FCM.

Periksa setelah rollout: kalender 2026 benar, pengajuan ganda bersamaan menghasilkan satu keberhasilan dan satu 409, persetujuan sendiri ditolak, checkout lama tetap dapat diselesaikan, serta job pengingat lama tidak dikirim setelah izin disetujui. Pengujian otomatis menggunakan database terpisah dan sender FCM terkontrol, bukan perangkat nyata.
