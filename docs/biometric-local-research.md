# Worker biometrik untuk evaluasi lokal

Worker tersedia dalam repo API dan berjalan sebagai proses terpisah. Paket berikut menyiapkan model nyata, checksum, dan manifest untuk eksperimen lokal. Paket ini belum siap untuk absensi operasional: bobot detector/recognizer InsightFace dibatasi untuk riset nonkomersial, dan akurasi/PAD belum diuji pada peserta proyek.

## Setup

Prasyarat: Node.js 24 dan dependency `npm ci`; Windows menyediakan `tar`, Linux/macOS memerlukan `unzip`. Unduhan hanya terjadi ketika operator menjalankan perintah setup, bukan saat API/worker startup.

```powershell
npm run worker:setup:research
```

Script mengambil Buffalo SC dari release resmi InsightFace v0.7 dan MiniFASNetV2 ONNX dari release exporter yakhyo. SHA-256 arsip dan ketiga file model dipatok dalam `src/worker/research-models.ts`. Script mengekstrak hanya dua nama file yang ditentukan dan memverifikasi hash sebelum menyimpan. File berbeda yang sudah ada tidak ditimpa; periksa perbedaannya terlebih dahulu.

Empat file model/manifest riset berikut dipatok dalam Git untuk deployment yang dapat direproduksi. Hanya keempat file tersebut diizinkan oleh aturan ignore. Arsip ZIP, foto, model lain dan data pilot tetap diabaikan:

```text
models/research/
  buffalo_sc.zip
  detector.onnx
  recognizer.onnx
  pad.onnx
  manifest.json
```

Manifest dibuat otomatis: nama output model, normalisasi, kelas PAD, checksum, dan referensi lisensi sudah terisi. File recognizer MobileFaceNet menggunakan embedding ArcFace 512 dimensi. PAD menerima BGR float32 rentang 0–255, bukan dibagi 255, menggunakan crop 2.7 dan live class 1. Crop mengikuti implementasi exporter yang dirujuk; Sharp memakai resize linear pada crop ini. Pipeline JavaScript belum dibuktikan identik secara numerik dengan OpenCV pada seluruh kondisi gambar; evaluasi lapangan tetap diperlukan.

Atur `.env` lokal:

```dotenv
NODE_ENV=development
FACE_ALLOW_RESEARCH_MODELS=true
FACE_MANIFEST_PATH=./models/research/manifest.json
FACE_MODEL_VERSION=research-buffalo-sc-minifasnet-v2-v1
FACE_WORKER_URL=http://localhost:8000
FACE_WORKER_PORT=8000
```

`FACE_WORKER_TOKEN` harus terisi secret acak minimal 32 karakter, sama pada API dan worker. Pertahankan secret yang sudah tersedia. Menyiapkan worker tidak otomatis mengaktifkan penerimaan absensi. Untuk pilot terisolasi, gunakan konfigurasi awal yang dijelaskan di bagian berikut; deployment lain tetap harus memilih threshold secara eksplisit.

## Kebijakan awal pilot, 22 Oktober 2026

Pemilik proyek mengizinkan konfigurasi awal sebelum foto peserta tersedia. File `config/biometric-pilot.env` menyimpan nilai tanpa secret, khusus model `research-buffalo-sc-minifasnet-v2-v1`. Salin lima variabelnya ke `.env` API atau Environment API Dokploy, kemudian restart API. File ini tidak dimuat otomatis, tidak mengubah Compose, dan tidak mengizinkan model riset pada worker secara otomatis.

| Variabel | Nilai | Dasar keputusan |
| --- | --- | --- |
| FACE_MATCH_THRESHOLD | 0.80 | Cutoff cosine yang diminta pemilik proyek; juga digunakan untuk konsistensi enrollment. Belum dibuktikan pada peserta. |
| FACE_REVIEW_THRESHOLD | 0.70 | Pilihan kebijakan pilot: rentang 0.10 di bawah match ditahan untuk review. Bukan hasil benchmark model. |
| FACE_LIVENESS_THRESHOLD | 0.90 | Syarat konservatif pada keluaran softmax: skor kelas hidup minimal sembilan kali jumlah kedua kelas spoof. Bukan probabilitas bahwa orang benar-benar hidup. |
| FACE_QUALITY_THRESHOLD | 1.00 | Memenuhi kedua referensi manifest secara utuh: sisi wajah terkecil minimal 100 piksel pada gambar input dan varians Laplacian minimal 100 pada wajah aligned 112 x 112. |

Worker menghitung kualitas sebagai `min(1, face_size/100, sharpness/100)`, sehingga threshold 1.00 memiliki arti geometris/numerik yang jelas. Referensi 100 pada manifest sendiri masih heuristik eksperimen; belum ada bukti bahwa nilai tersebut cocok untuk semua kamera. Skor tepat di batas liveness/kualitas diterima; skor di bawah batas ditolak sebelum pencocokan absensi.

Implementasi [exporter MiniFASNetV2](https://github.com/yakhyo/face-anti-spoofing/blob/main/onnx_inference.py) memakai softmax dan memilih kelas terbesar, dengan kelas hidup pada indeks 1. Threshold 0.90 adalah kebijakan pilot proyek yang lebih ketat dari pemilihan kelas terbesar, bukan rekomendasi angka dari upstream. Ia tidak menggantikan pengujian foto cetak, layar, atau replay.

Hasil similarity di bawah 0.70 ditolak; rentang [0.70, 0.80) menjadi `NEEDS_REVIEW` dan tidak membuat attendance diterima; mulai 0.80 hanya lolos pencocokan jika pemeriksaan lain juga lolos. Alur penyelesaian review absensi belum tersedia: peserta perlu mengulang dengan selfie baru, bukan menganggap respons 202 sebagai hadir. Enrollment saat ini masih berstatus `PENDING` sampai disetujui admin; aktivasi enrollment mandiri belum diterapkan.

Nilai ini membuat pilot dapat dimulai, tetapi tidak menjamin wajah asli akan lolos. Jangan menurunkan batas hanya untuk meloloskan satu request. Saat tiga peserta siap, gunakan 3–5 foto enrollment berbeda dan sesi pengujian terpisah; catat salah tolak wajah sendiri, salah terima wajah teman, serta lolos/tolaknya foto cetak dan layar. Evaluasi PAD/kualitas terlebih dahulu, kemudian match/review. Pisahkan sampel penyesuaian dari sampel verifikasi dan simpan laporan di lokasi privat, tanpa foto atau embedding dalam Git/log aplikasi. Tidak ada klaim akurasi produksi dari konfigurasi ini.

## Validasi dan menjalankan

```powershell
npm run worker:check
npm run worker:dev
```

`worker:check` memeriksa checksum dan menjalankan inference startup untuk memastikan ukuran tensor detector, embedding 512 dimensi, dan indeks kelas PAD tersedia. Perintah ini tidak mengukur akurasi wajah atau keberhasilan menolak serangan.

Biarkan terminal worker terbuka. Dari terminal PowerShell lain, cek readiness tanpa menampilkan token:

```powershell
node --env-file=.env -e "fetch('http://localhost:8000/ready', {headers:{Authorization:'Bearer '+process.env.FACE_WORKER_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exitCode=r.ok?0:1}).catch(()=>{console.error('Worker unavailable');process.exitCode=1})"
```

Hasil yang diharapkan: HTTP `200` dengan `ready: true`. API dijalankan terpisah melalui `npm run dev`. Jika worker sudah berjalan di port 8000, jangan menjalankan proses worker kedua.

## Batas paket dan langkah berikutnya

- Manifest berlabel `RESEARCH_ONLY`. Loader menolaknya kecuali caller mengizinkan riset. Server dan CLI pada `NODE_ENV=production` memerlukan opt-in eksplisit `FACE_ALLOW_RESEARCH_MODELS=true` untuk evaluasi staging. Nilai `false` menolak model riset juga di development. Mode Node tidak perlu diubah.
- Jangan menghapus label riset untuk menjadikan paket ini model produksi. Penggunaan operasional membutuhkan izin bobot yang sesuai atau model pengganti beserta integrasi dan pengujian ulang.
- Template model ini tidak boleh dianggap kompatibel dengan model produksi lain. Perubahan bobot/preprocessing membutuhkan versi baru dan enrollment ulang.
- Selanjutnya uji foto enrollment dan foto sesi berbeda dari peserta yang menyetujui pengujian, pasangan orang berbeda, foto cetak/layar, variasi cahaya, dan perangkat Android target. Tiga orang cukup untuk pemeriksaan awal, bukan bukti akurasi produksi.
- Kalibrasi menetapkan threshold match, review, liveness, dan kualitas. Nilai deteksi 0.5/NMS 0.4 serta referensi kualitas pada preset adalah konfigurasi eksperimen, bukan threshold penerimaan absensi yang telah dibuktikan.

## Evaluasi staging Dokploy

Gunakan staging terisolasi dengan akun peserta uji yang menyetujui pengujian, bukan absensi operasional. Flag evaluasi tidak mengubah lisensi bobot. `NODE_ENV=production` mengatur perilaku runtime aplikasi dan tidak berarti eksperimen model harus dilarang seluruhnya.

1. Checkout branch `dev` yang mencakup empat file model/manifest. Target Docker `face-worker` memasukkannya ke image, sedangkan Compose tetap memasang direktori host ke `/app/models`. Default `FACE_MODELS_PATH=./models` menggunakan model dari checkout; jika memakai path eksternal seperti `/opt/absensi-models`, salin empat file ke subdirektori `research` dan pastikan user non-root dapat membacanya. Arsip serta foto peserta tidak masuk Git. `npm run worker:setup:research` hanya diperlukan untuk menyiapkan ulang file sesuai checksum, bukan saat startup.
2. Redeploy image dari branch `dev` yang sudah mendukung flag evaluasi.
3. Jika memakai Compose repo, isi environment deployment:

```dotenv
FACE_ALLOW_RESEARCH_MODELS=true
FACE_MODELS_PATH=/opt/absensi-models
FACE_WORKER_MANIFEST_PATH=/app/models/research/manifest.json
FACE_MODEL_VERSION=research-buffalo-sc-minifasnet-v2-v1
```

`FACE_WORKER_TOKEN` pada API dan worker harus sama, minimal 32 karakter. `BIOMETRIC_KEY_BASE64` pada API harus terisi key 32 byte yang di-encode base64. Jangan mengganti key yang sudah mengenkripsi template.

Jalankan dari root deployment di host server, menggunakan project Compose yang sama dengan Dokploy. Ganti `NAMA_PROJECT_DOKPLOY` dengan nama sebenarnya:

```sh
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml --profile biometrics up -d --build --wait face-worker
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml logs --tail=100 face-worker
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml exec face-worker node dist/worker/check-cli.js
docker compose -p NAMA_PROJECT_DOKPLOY -f compose.yaml exec face-worker node -e 'fetch("http://127.0.0.1:8000/ready",{headers:{authorization:"Bearer "+process.env.FACE_WORKER_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exitCode=r.ok?0:1}).catch(()=>process.exitCode=1)'
```

Nama project yang salah dapat membuat deployment kedua. Hindari menjalankan Compose dari terminal dalam container API. Jika environment API berubah, redeploy service API melalui Dokploy juga.

Jika deployment memakai Application Dockerfile, bangun image khusus dengan `docker build --target face-worker -t absensi-face-worker:TAG .` dan gunakan image tersebut pada service worker tersendiri. Command dan health check worker tersedia pada target ini. Isi environment:

```dotenv
NODE_ENV=production
FACE_ALLOW_RESEARCH_MODELS=true
FACE_MANIFEST_PATH=/app/models/research/manifest.json
FACE_WORKER_PORT=8000
```

Image target worker sudah berisi model, sehingga mount eksternal tidak wajib untuk Application Dockerfile. Jika operator sengaja mengoverride model, pasang direktori model yang benar ke `/app/models` secara read-only. Isi shared token yang sama dengan API. Hubungkan worker dan API ke jaringan privat yang sama; isi `FACE_WORKER_URL` API dengan hostname worker port 8000. Health check `/ready` port 8000 membutuhkan bearer token. Tidak perlu port atau domain publik untuk worker.

Readiness worker HTTP 200 membuktikan file model berhasil dimuat. Itu belum membuktikan endpoint absensi dapat menerima request: API tetap memerlukan empat threshold, versi model yang sama, key biometrik, perangkat disetujui, enrollment disetujui, kantor aktif, serta jadwal peserta. Threshold kosong tetap menghasilkan `FACE_NOT_CONFIGURED`; flag evaluasi tidak mengisi atau melewati threshold tersebut.

Setelah foto peserta tersedia, evaluasi konfigurasi awal pilot di atas dengan foto enrollment dan sesi uji terpisah. Catat distribusi similarity/kualitas/PAD serta salah terima/tolak, lalu dokumentasikan penyesuaian threshold. Jangan mengisi semua threshold dengan nol untuk mengejar keberhasilan request. Uji juga check-in/out, wajah orang berbeda, spoof, lokasi di luar batas, lokasi kantor kategori lain, pengulangan request, dan logout/perangkat dicabut. Data pilot terbatas belum membuktikan tingkat akurasi produksi.

Cutoff cosine 0.80 bukan persentase akurasi atau probabilitas identitas benar. Batas yang sama digunakan untuk konsistensi foto enrollment. Nilai ini belum dikalibrasi dan bisa menolak foto orang yang benar; verifikasi pada pilot sebelum memutuskan mempertahankannya. Threshold review harus lebih kecil dari match; threshold PAD dan kualitas mengukur hal berbeda dari cosine similarity.

Untuk menutup evaluasi, set `FACE_ALLOW_RESEARCH_MODELS=false` dan redeploy worker. Penggunaan paket riset akan kembali ditolak; login/admin API tetap berjalan. Jangan menghapus label riset pada manifest agar paket terlihat sebagai model operasional.

Sumber:

- [InsightFace: kebijakan bobot model](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses).
- [InsightFace v0.7: distribusi Buffalo SC](https://github.com/deepinsight/insightface/releases/tag/v0.7).
- [MiniFASNetV2: release ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/releases/tag/weights).
- [Pipeline ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/blob/main/onnx_inference.py).
- [Proyek upstream PAD](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing).
