# Kontrak integrasi panel admin dan Google login

Keputusan implementasi 22 Oktober 2026. Panel web dibuat sebagai project terpisah; API ini tetap pemilik data dan otorisasi. Semua endpoint berikut memakai prefix /api/v1. Seluruh operasi administratif memerlukan role ADMIN atau SUPER_ADMIN, kecuali pengelolaan kantor, unit, audit global dan pemetaan SSO yang memerlukan SUPER_ADMIN.

## Deployment dan sesi browser

Gunakan HTTPS dan dua subdomain same-site, misalnya https://admin-staging.absensi.example.go.id serta https://api-staging.absensi.example.go.id. Ini contoh nama, bukan domain yang sudah diprovisikan. Cookie SameSite=Strict membutuhkan deployment same-site; dua project tidak harus memiliki registrable domain berbeda. Untuk pengembangan HTTP, gunakan localhost dengan port berbeda, bukan mencampur localhost dan 127.0.0.1.

Aktifkan WEB_AUTH_ENABLED=true dan isi ADMIN_WEB_ORIGIN dengan origin persis tanpa trailing slash/path. HTTP hanya diizinkan untuk localhost di luar production. Browser otomatis mengirim Origin pada request POST; gunakan fetch credentials: include. CORS mengizinkan credentials hanya pada origin yang dikonfigurasi. Endpoint web juga memeriksa Origin secara mandiri. HTTPS di reverse proxy memerlukan TRUST_PROXY yang sesuai.

Refresh token web berada pada cookie host-only absensi_web_refresh: HttpOnly, SameSite=Strict, Path=/api/v1/auth/web, Secure pada production. Access token hanya di memori browser. Access token berlaku maksimal 10 menit; sesi web memiliki batas absolut 8 jam. Rotasi tidak memperpanjang batas absolut tersebut. Sesi Android tetap maksimal 30 hari dan refresh melalui JSON. Kanal refresh WEB dan MOBILE tidak dapat saling digunakan. Redis/rate limit tetap fail-closed.

## Login lokal dan pemulihan sesi

1. POST /auth/web/login dengan JSON email dan password. Hanya ADMIN/SUPER_ADMIN aktif dengan auth_mode LOCAL/BOTH yang diterima. Respons data berisi access_token, token_type, expires_in dan csrf_token; tidak ada refresh_token pada JSON.
2. Panggil API bisnis dengan Authorization: Bearer <access_token>. Jangan menyimpan token pada localStorage atau sessionStorage.
3. Setelah reload, POST /auth/web/session dengan credentials: include. Respons data.csrf_token dipakai untuk POST /auth/web/refresh melalui header X-CSRF-Token. Respons refresh berisi access token baru, CSRF baru, dan cookie yang dirotasi.
4. Koordinasikan refresh menjadi satu operasi, termasuk antar-tab. Reuse refresh token lama mencabut keluarga sesi. Tab yang memegang CSRF lama dapat memulihkan CSRF kembali melalui /auth/web/session; jangan melakukan refresh paralel.
5. POST /auth/web/logout dengan cookie, Origin dan X-CSRF-Token mencabut keluarga sesi dan menghapus cookie. Endpoint /auth/logout-all yang sudah ada tetap dapat digunakan dengan Bearer token untuk mencabut semua sesi.

POST /auth/web/session hanya membaca sesi dan mengembalikan CSRF pada origin terpercaya. Refresh/logout memeriksa CSRF yang diikat HMAC ke refresh token. Browser tidak perlu membaca cookie HttpOnly. Cookie dengan nama ganda ditolak. Jika refresh gagal 401, kembali ke login; 403 CSRF_INVALID memerlukan pemulihan CSRF, bukan login berulang otomatis.

## Google Cloud dan Android native

Buat OAuth client Android (package name dan SHA-1 build yang benar), serta Web application client dalam project Google yang sama. GOOGLE_WEB_CLIENT_ID menjadi audience ID token. Isi GOOGLE_ANDROID_CLIENT_IDS dengan daftar Android OAuth client IDs yang diizinkan, dipisah koma, agar authorized presenter (azp) juga dapat diverifikasi. Client ID bukan secret. Jangan menaruh client secret di Android atau browser.

Aktifkan GOOGLE_ENABLED=true. Alur native tidak memerlukan GOOGLE_REDIRECT_URI maupun GOOGLE_CLIENT_SECRET selama login web belum diaktifkan.

1. Android meminta POST /auth/google/challenge. Respons data: challenge_id, nonce, expires_at; berlaku 5 menit.
2. Android menggunakan Sign in with Google native/Credential Manager, serverClientId=GOOGLE_WEB_CLIENT_ID, dan nonce persis dari API.
3. Kirim POST /auth/google dengan JSON challenge_id dan id_token melalui HTTPS.
4. Backend memverifikasi signature RS256 Google, issuer, audience, expiry/issue time, nonce, dan azp bila ada. Challenge hanya dapat digunakan sekali, termasuk bila verifikasi gagal.
5. Setelah identitas dipetakan dan akun aktif/auth_mode SSO atau BOTH, backend menerbitkan JWT serta refresh token MOBILE aplikasi. Token Google tidak digunakan sebagai Bearer token API bisnis.

## Google login web dan callback

Dengan WEB_AUTH_ENABLED=true dan GOOGLE_ENABLED=true, isi GOOGLE_CLIENT_SECRET dan GOOGLE_REDIRECT_URI=https://DOMAIN-API/api/v1/auth/web/google/callback. Daftarkan URL tersebut persis pada Authorized redirect URIs Web OAuth client Google. Rahasia hanya di runtime API/Dokploy. Untuk alur ini tidak diperlukan Google JavaScript SDK atau origin JavaScript OAuth; CORS API tetap perlu dikonfigurasi seperti di atas.

1. Panel POST /auth/web/google/start dengan credentials: include. Backend menyimpan state, nonce dan PKCE; cookie HttpOnly sementara mengikat browser.
2. Panel menavigasikan window ke data.authorization_url. Gunakan navigasi browser, bukan embedded WebView.
3. Google mengembalikan browser ke callback API. Backend memeriksa state, nonce, PKCE, expiry, cookie browser dan identitas terdaftar.
4. Jika berhasil dan role ADMIN/SUPER_ADMIN, API menyetel cookie refresh lalu redirect 303 ke ADMIN_WEB_ORIGIN/auth/callback. URL tidak mengandung access token atau refresh token.
5. Halaman /auth/callback memanggil /auth/web/session lalu /auth/web/refresh untuk memperoleh access token di memori.
6. Kegagalan menuju ADMIN_WEB_ORIGIN/login?error=SSO_LOGIN_FAILED. FE menampilkan pesan generik dan pilihan login ulang; tidak ada redirect URL bebas dari request.

Penyedia OIDC generik lama (/auth/sso/start dan /auth/sso/exchange) tetap tersedia sesuai konfigurasi SSO_ENABLED, terpisah dari GOOGLE_ENABLED. Jangan mengaktifkan kedua mode tanpa kebutuhan. GET /auth/methods menyatakan konfigurasi local, sso, google dan web, bukan jaminan konektivitas ke Google.

## Pemetaan akun dan kewenangan

Tidak ada registrasi otomatis. Untuk Google native Android, penautan pertama berdasarkan email terverifikasi tersedia jika `GOOGLE_EMAIL_LINKING_ENABLED=true`. SUPER_ADMIN lain terlebih dahulu mengizinkan pegawai melalui `PATCH /admin/users/:id` dengan `auth_mode: BOTH` (atau SSO) dan `google_email_linking_allowed: true`. Akun wajib aktif, role EMPLOYEE/VERIFIER, dan kategori KPID/KI. Default izin false mempertahankan akun lama; LOCAL tetap menolak login Google. Perubahan pengaturan ini mencabut sesi aktif pengguna.

Backend hanya memakai email dari ID token Google yang sudah diverifikasi signature, issuer, audience, nonce, dan masa berlakunya. Email harus `email_verified=true` serta merupakan Gmail atau Google Workspace dengan claim `hd`. Google account dengan email pihak ketiga tanpa `hd` memerlukan pemetaan eksplisit. Pencocokan email memakai lowercase persis, tanpa menghapus titik atau suffix plus. Identitas Google tidak boleh mengganti pemetaan yang sudah ada. Izin sekali pakai dikonsumsi dalam transaksi bersama pemetaan dan penerbitan sesi; setelah unlink admin, akun tidak otomatis tertaut lagi tanpa izin baru.

Setelah login, FE memakai access token aplikasi untuk `GET /me`. Nama, NIP (`employee_number`), kategori penempatan (`employee_category_code`), role, dan unit berasal dari database instansi, bukan profil Google atau payload FE. Login berikutnya memakai pasangan issuer/sub yang sudah tersimpan, bukan mencocokkan ulang email. Perubahan profil Google tidak menimpa data pegawai. FE harus memperbarui profilnya dari API, bukan menjadikan cache lokal sebagai dasar otorisasi.

Admin, SUPER_ADMIN, dan login panel web tetap memerlukan pemetaan eksplisit melalui `POST /admin/sso/identities` dengan user_id, issuer=https://accounts.google.com, subject dari claim sub, auth_mode=SSO atau BOTH, dan reason. Issuer harus termasuk penyedia yang dikonfigurasi. Pemetaan sendiri dilarang; gunakan super admin lain. Admin awal tetap dapat diprovisikan melalui CLI dan login lokal. Jangan menggunakan email sebagai subject atau meminta pengguna membagikan ID token di chat/log.

Rollout ini memerlukan migration `011_google_email_linking.sql`. Jalankan migrasi sebelum memakai runtime baru; default flag dan izin per pegawai tetap false. Penautan otomatis yang berhasil dicatat sebagai `GOOGLE_IDENTITY_AUTO_LINKED` tanpa menyimpan token Google di audit. Lihat [panduan verifikasi identitas Google](https://developers.google.com/identity/sign-in/web/backend-auth) untuk alasan membatasi email yang dipercaya.

Admin kategori mengelola pegawai dengan kategori sama dan role EMPLOYEE/VERIFIER. SUPER_ADMIN mengelola seluruh kategori. Data absensi admin kategori memerlukan kategori pegawai terkini DAN employee_category_at_event yang sama. Riwayat lintas perpindahan kategori hanya tersedia bagi SUPER_ADMIN, sehingga perpindahan kategori tidak membocorkan data kategori sebelumnya kepada admin baru.

## Endpoint panel dan filter

| Endpoint | Filter query / aturan |
| --- | --- |
| GET /admin/users | q (nama/nomor/email, pencarian literal), employee_category_code, role, active=true/false, limit, offset |
| GET /admin/users/:id | Detail pegawai dalam kewenangan; tanpa password hash atau embedding |
| GET /admin/attendances | from dan to wajib (tanggal WIB inklusif); user_id, office_id, type, status, limit, offset |
| GET /admin/schedules | from dan to wajib; user_id, limit, offset |
| PATCH /admin/schedules/:id | work_date, starts_at, ends_at, grace_minutes opsional; minimal satu perubahan; reason 5–500 karakter wajib |
| GET /admin/devices | user_id, status=PENDING/ACTIVE/REVOKED, limit, offset |
| GET /admin/face-enrollments | user_id, status=PENDING/ACTIVE/REVOKED (default PENDING), limit, offset; tanpa foto/embedding |
| GET /admin/audit-logs | SUPER_ADMIN; limit, offset |

Endpoint daftar di atas tetap mengembalikan data berupa array dan kini menambahkan meta.limit, meta.offset, meta.total. Limit default 25, maksimum 100; offset maksimum 100000. Total tetap benar ketika offset melewati halaman terakhir. Urutan data tetap dan mempunyai id sebagai pembeda. GET /admin/units dan /admin/offices tetap berupa daftar kecil tanpa pagination. Semua filter memakai parameter SQL terikat; filter tidak memperluas cakupan kategori.

Contoh respons daftar:

~~~json
{"data":[],"meta":{"limit":25,"offset":100,"total":3}}
~~~

Tanggal laporan memakai Asia/Jakarta. CHECK_IN memiliki status PRESENT/LATE; CHECK_OUT memiliki EARLY_LEAVE/ON_TIME. Laporan ini hanya memuat absensi sah, tidak menyimpulkan alpha/izin/cuti dan tidak memasukkan NEEDS_REVIEW sebagai kehadiran.

Jadwal yang sudah memiliki check-in atau check-out ditolak dengan 409 SCHEDULE_LOCKED meskipun yang mengubah adalah SUPER_ADMIN. Update jadwal mengunci pegawai dan jadwal di dalam transaksi, sama dengan alur pencatatan absensi, serta mencatat before/after dan reason pada audit. Koreksi historis harus melalui workflow terpisah yang belum diimplementasikan. Jadwal tetap satu per tanggal WIB dan tidak lintas tengah malam.

## Error formulir

Error tetap berbentuk error.code, error.message dan request_id. Validasi Zod menambahkan error.details berupa array field dan message. Tidak ada nilai input/password yang dipantulkan. FE memakai field untuk menempatkan pesan pada input dan code untuk keputusan alur. Error database/konflik tetap berupa pesan generik.

~~~json
{"error":{"code":"VALIDATION_ERROR","message":"Data permintaan tidak valid.","details":[{"field":"email","message":"Invalid email address"}]},"request_id":"UUID"}
~~~

## Batas pekerjaan ini

Tidak mengubah matriks kantor, geofence 50 meter, izin KI pada irisan DISKOMINFO/KPID, atau signature Android. Koreksi manual di luar attempt valid, ekspor/impor dan dashboard agregat belum tersedia. Penyelesaian NEEDS_REVIEW sudah tersedia melalui GET/PATCH `/api/v1/admin/attendance-reviews/:id` dan daftar GET `/api/v1/admin/attendance-reviews`; lihat [kontrak review](attendance-review.md). Enrollment baru langsung ACTIVE setelah validasi tanpa persetujuan admin; review template lama tetap tersedia. Foto mentah tidak disimpan. Google nyata masih memerlukan kredensial, consent configuration, domain/callback dan build Android yang benar; tes lokal memakai kunci RSA lokal dan provider terkontrol. Jangan menyebut login Google sudah tervalidasi di staging sebelum diuji memakai kredensial asli.

Migration 010 menambahkan tipe sesi (row lama default MOBILE) dan tabel flow Google tanpa mengubah data pegawai atau absensi. Jalankan migrasi melalui build baru sebelum start. Default WEB_AUTH_ENABLED=false dan GOOGLE_ENABLED=false mempertahankan deployment lama. Jangan rollback ke runtime lama ketika sesi WEB sudah aktif: versi lama belum memeriksa tipe sesi. Cabut sesi WEB melalui prosedur operasional sebelum rollback versi; tabel/kolom additive tidak perlu dihapus.
