# Worker biometrik untuk evaluasi lokal

Worker tersedia dalam repo API dan berjalan sebagai proses terpisah. Paket berikut menyiapkan model nyata, checksum, dan manifest untuk eksperimen lokal. Paket ini belum siap untuk absensi operasional: bobot detector/recognizer InsightFace dibatasi untuk riset nonkomersial, dan akurasi/PAD belum diuji pada peserta proyek.

## Setup

Prasyarat: Node.js 24 dan dependency `npm ci`; Windows menyediakan `tar`, Linux/macOS memerlukan `unzip`. Unduhan hanya terjadi ketika operator menjalankan perintah setup, bukan saat API/worker startup.

```powershell
npm run worker:setup:research
```

Script mengambil Buffalo SC dari release resmi InsightFace v0.7 dan MiniFASNetV2 ONNX dari release exporter yakhyo. SHA-256 arsip dan ketiga file model dipatok dalam `src/worker/research-models.ts`. Script mengekstrak hanya dua nama file yang ditentukan dan memverifikasi hash sebelum menyimpan. File berbeda yang sudah ada tidak ditimpa; periksa perbedaannya terlebih dahulu.

Hasil lokal, diabaikan oleh Git dan Docker build context:

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

`FACE_WORKER_TOKEN` harus terisi secret acak minimal 32 karakter, sama pada API dan worker. Pertahankan secret yang sudah tersedia. Empat threshold API tetap kosong sampai ada hasil kalibrasi; menyiapkan worker tidak mengaktifkan penerimaan absensi.

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

1. Jalankan `npm run worker:setup:research` di komputer pengembangan. Kirim empat file `detector.onnx`, `recognizer.onnx`, `pad.onnx`, dan `manifest.json` dari `models/research` ke direktori server khusus, misalnya `/opt/absensi-models/research`. Gunakan transfer file privat. Bobot dan foto peserta tidak dimasukkan Git. Pastikan user non-root container dapat membaca direktori serta file tersebut.
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

Jika deployment memakai Application Dockerfile, buat service worker tersendiri dengan image API yang sama, start command `node dist/worker/server.js`, dan environment:

```dotenv
NODE_ENV=production
FACE_ALLOW_RESEARCH_MODELS=true
FACE_MANIFEST_PATH=/app/models/research/manifest.json
FACE_WORKER_PORT=8000
```

Pasang `/opt/absensi-models` ke `/app/models` secara read-only dan isi shared token yang sama. Hubungkan worker dan API ke jaringan privat yang sama; isi `FACE_WORKER_URL` API dengan hostname worker yang dapat dijangkau pada port 8000. Atur health check service worker ke `/ready` port 8000 dengan bearer token; jangan mewarisi health check image API port 3000. Tidak perlu port atau domain publik untuk worker.

Readiness worker HTTP 200 membuktikan file model berhasil dimuat. Itu belum membuktikan endpoint absensi dapat menerima request: API tetap memerlukan empat threshold, versi model yang sama, key biometrik, perangkat disetujui, enrollment disetujui, kantor aktif, serta jadwal peserta. Threshold kosong tetap menghasilkan `FACE_NOT_CONFIGURED`; flag evaluasi tidak mengisi atau melewati threshold tersebut.

Setelah foto peserta tersedia, lakukan pilot dengan foto enrollment dan sesi uji terpisah, catat distribusi similarity/kualitas/PAD serta salah terima/tolak, lalu tetapkan threshold uji yang terdokumentasi. Jangan mengisi semua threshold dengan nol untuk mengejar keberhasilan request. Setelah itu uji check-in/out, wajah orang berbeda, spoof, lokasi di luar batas, lokasi kantor kategori lain, pengulangan request, dan logout/perangkat dicabut. Data pilot terbatas belum membuktikan tingkat akurasi produksi.

Permintaan pemilik proyek menetapkan `FACE_MATCH_THRESHOLD=0.80` sebagai batas awal. Ini cutoff cosine similarity, bukan persentase akurasi atau probabilitas identitas benar. Skor di bawah 0.80 tidak membuat attendance event diterima; skor pada rentang review menghasilkan `NEEDS_REVIEW`, bukan absensi berhasil. Skor 0.80 atau lebih hanya lolos pencocokan jika pemeriksaan lain juga lolos. Batas yang sama digunakan untuk konsistensi foto enrollment. Nilai ini belum dikalibrasi dan bisa menolak foto orang yang benar; verifikasi pada pilot sebelum memutuskan mempertahankannya. Threshold review harus lebih kecil dari 0.80, sedangkan threshold PAD dan kualitas tetap harus ditentukan secara terpisah.

Untuk menutup evaluasi, set `FACE_ALLOW_RESEARCH_MODELS=false` dan redeploy worker. Penggunaan paket riset akan kembali ditolak; login/admin API tetap berjalan. Jangan menghapus label riset pada manifest agar paket terlihat sebagai model operasional.

Sumber:

- [InsightFace: kebijakan bobot model](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses).
- [InsightFace v0.7: distribusi Buffalo SC](https://github.com/deepinsight/insightface/releases/tag/v0.7).
- [MiniFASNetV2: release ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/releases/tag/weights).
- [Pipeline ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/blob/main/onnx_inference.py).
- [Proyek upstream PAD](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing).
