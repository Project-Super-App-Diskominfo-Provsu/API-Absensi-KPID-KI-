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

- Manifest berlabel `RESEARCH_ONLY`. Loader menolaknya kecuali caller mengizinkan riset; server dan CLI hanya mengizinkan ketika `NODE_ENV` bukan `production`. Jangan mengubah environment server untuk melewati batas tersebut.
- Jangan menghapus label riset untuk menjadikan paket ini model produksi. Penggunaan operasional membutuhkan izin bobot yang sesuai atau model pengganti beserta integrasi dan pengujian ulang.
- Template model ini tidak boleh dianggap kompatibel dengan model produksi lain. Perubahan bobot/preprocessing membutuhkan versi baru dan enrollment ulang.
- Selanjutnya uji foto enrollment dan foto sesi berbeda dari peserta yang menyetujui pengujian, pasangan orang berbeda, foto cetak/layar, variasi cahaya, dan perangkat Android target. Tiga orang cukup untuk pemeriksaan awal, bukan bukti akurasi produksi.
- Kalibrasi menetapkan threshold match, review, liveness, dan kualitas. Nilai deteksi 0.5/NMS 0.4 serta referensi kualitas pada preset adalah konfigurasi eksperimen, bukan threshold penerimaan absensi yang telah dibuktikan.

Sumber:

- [InsightFace: kebijakan bobot model](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses).
- [InsightFace v0.7: distribusi Buffalo SC](https://github.com/deepinsight/insightface/releases/tag/v0.7).
- [MiniFASNetV2: release ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/releases/tag/weights).
- [Pipeline ONNX exporter](https://github.com/yakhyo/face-anti-spoofing/blob/main/onnx_inference.py).
- [Proyek upstream PAD](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing).
