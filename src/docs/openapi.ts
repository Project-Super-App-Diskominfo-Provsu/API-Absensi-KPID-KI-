const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const object = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' },
  uuid = { type: 'string', format: 'uuid' },
  date = { type: 'string', format: 'date' },
  timestamp = { type: 'string', format: 'date-time' };
const pagination = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
];
const idParam = { name: 'id', in: 'path', required: true, schema: uuid };
const range = [
  { name: 'from', in: 'query', required: true, schema: date },
  { name: 'to', in: 'query', required: true, schema: date },
];
const response = {
  description: 'Berhasil. Data berada pada properti data.',
  content: json({ type: 'object', properties: { data: {}, request_id: str } }),
};
function operation(
  summary: string,
  options: {
    body?: string;
    multipart?: string;
    id?: boolean;
    parameters?: unknown[];
    status?: number;
    public?: boolean;
    empty?: boolean;
  } = {},
) {
  return {
    summary,
    security: options.public ? [] : [{ bearerAuth: [] }],
    ...(options.body ? { requestBody: { required: true, content: json(ref(options.body)) } } : {}),
    ...(options.multipart
      ? {
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema: ref(options.multipart) } },
          },
        }
      : {}),
    parameters: [...(options.id ? [idParam] : []), ...(options.parameters ?? [])],
    responses: {
      [options.status ?? 200]: options.empty ? { description: 'Berhasil tanpa body.' } : response,
      ...(options.multipart
        ? { '202': { description: 'PROCESSING atau NEEDS_REVIEW; belum menjadi absensi sah.' } }
        : {}),
      default: {
        description: 'Error terstruktur; HTTP 400/401/403/404/409/422/429/503.',
        content: json(ref('Error')),
      },
    },
  };
}
const userProps = {
  employee_number: { ...str, maxLength: 50 },
  name: { ...str, maxLength: 200 },
  email: { ...str, format: 'email' },
  password: { ...str, minLength: 15, maxLength: 128 },
  employee_category_code: { enum: ['KPID', 'KI'] },
  role: { enum: ['EMPLOYEE', 'VERIFIER', 'ADMIN', 'SUPER_ADMIN'], default: 'EMPLOYEE' },
  unit_id: { type: ['string', 'null'], format: 'uuid' },
  active: { type: 'boolean' },
};
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'API Absensi KPID/KI Sumatera Utara',
    version: '0.1.0',
    description:
      'Implementasi awal P0. Geofencing polygon PostGIS dengan batas maksimum 50 meter dari pusat kantor. Model/PAD dan threshold wajib dikonfigurasi sebelum absensi. Endpoint administratif yang mengubah lokasi hanya untuk SUPER_ADMIN.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: object({ error: object({ code: str, message: str }), request_id: str }, [
        'error',
        'request_id',
      ]),
      Login: object({ email: { ...str, format: 'email' }, password: { ...str, maxLength: 128 } }),
      Refresh: object({ refresh_token: str }),
      ChangePassword: object({
        current_password: { ...str, minLength: 1, maxLength: 128 },
        new_password: { ...str, minLength: 15, maxLength: 128 },
      }),
      CreateUser: object(userProps, [
        'employee_number',
        'name',
        'email',
        'password',
        'employee_category_code',
      ]),
      UpdateUser: object(
        Object.fromEntries(Object.entries(userProps).filter(([key]) => key !== 'password')),
        [],
      ),
      OfficePatch: object(
        {
          name: str,
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          polygon: {
            description:
              'Polygon opsional untuk mempersempit area. Jika pusat kantor diubah tanpa polygon, server membentuk buffer 50 meter otomatis. Interior ring GeoJSON dipertahankan; polygon tidak valid ditolak.',
            oneOf: [
              {
                type: 'array',
                minItems: 3,
                items: {
                  type: 'object',
                  properties: {
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 },
                  },
                  required: ['latitude', 'longitude'],
                },
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'Polygon' },
                  coordinates: { type: 'array' },
                },
                required: ['type', 'coordinates'],
              },
            ],
          },
          radius_m: { const: 50 },
          max_gps_accuracy_m: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
          max_location_age_s: { type: 'integer', minimum: 1, maximum: 120 },
          active: { type: 'boolean' },
        },
        [],
      ),
      Unit: object({ name: str }),
      Schedule: object(
        {
          user_id: uuid,
          work_date: date,
          starts_at: timestamp,
          ends_at: timestamp,
          grace_minutes: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
        },
        ['user_id', 'work_date', 'starts_at', 'ends_at'],
      ),
      DeviceBind: object({
        public_key: {
          ...str,
          description: 'Ed25519 public key PEM. Private key tetap di perangkat.',
        },
        platform: { const: 'ANDROID' },
        signature: { ...str, description: 'Base64 Ed25519 signature; lihat README untuk payload.' },
      }),
      DeviceReview: object({
        status: { enum: ['ACTIVE', 'REVOKED'] },
        reason: { ...str, minLength: 5, maxLength: 500 },
      }),
      Challenge: object({
        device_id: uuid,
        purpose: { enum: ['CHECK_IN', 'CHECK_OUT', 'ENROLL'] },
      }),
      Enrollment: object({
        images: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: { type: 'string', format: 'binary' },
        },
        device_id: uuid,
        nonce: str,
        signature: str,
        consent: { const: 'true' },
        consent_version: str,
      }),
      FaceReview: object({
        status: { enum: ['ACTIVE', 'REVOKED'] },
        identity_verified: { type: 'boolean' },
        reason: { ...str, minLength: 5, maxLength: 500 },
      }),
      Reason: object({ reason: { ...str, minLength: 5, maxLength: 500 } }),
      Attendance: object(
        {
          image: { type: 'string', format: 'binary', description: 'JPEG/PNG, maksimum 5 MiB.' },
          latitude: {
            ...str,
            description: 'Latitude WGS84 dalam derajat desimal, antara -90 dan 90.',
          },
          longitude: str,
          accuracy_m: str,
          captured_at: timestamp,
          device_id: uuid,
          nonce: str,
          signature: { ...str, description: 'Base64 signature payload kanonis; lihat README.' },
          office_id: uuid,
          is_mock: { enum: ['true', 'false'], default: 'false' },
        },
        [
          'image',
          'latitude',
          'longitude',
          'accuracy_m',
          'captured_at',
          'device_id',
          'nonce',
          'signature',
        ],
      ),
    },
  },
  paths: {
    '/auth/login': { post: operation('Login', { body: 'Login', public: true }) },
    '/auth/refresh': {
      post: operation('Rotasi refresh token; token lama tidak dapat digunakan ulang', {
        body: 'Refresh',
        public: true,
      }),
    },
    '/auth/logout': { post: operation('Cabut keluarga sesi aktif', { status: 204, empty: true }) },
    '/auth/logout-all': {
      post: operation('Cabut seluruh sesi milik pengguna', { status: 204, empty: true }),
    },
    '/auth/change-password': {
      post: operation('Ubah password dan cabut seluruh sesi; login ulang setelah berhasil', {
        body: 'ChangePassword',
        status: 204,
        empty: true,
      }),
    },
    '/me': { get: operation('Profil terkini dan status enrollment') },
    '/offices': { get: operation('Lokasi aktif yang diizinkan kategori pegawai') },
    '/admin/offices': { get: operation('Daftar ketiga kantor, termasuk yang belum aktif') },
    '/admin/offices/{id}': {
      patch: operation(
        'SUPER_ADMIN: konfigurasi atau nonaktifkan kantor; geofence poligon PostGIS',
        {
          body: 'OfficePatch',
          id: true,
        },
      ),
    },
    '/admin/users': {
      get: operation('Daftar pegawai dalam lingkup admin', { parameters: pagination }),
      post: operation('Buat pegawai KPID/KI', { body: 'CreateUser', status: 201 }),
    },
    '/admin/users/{id}': {
      patch: operation('Ubah pegawai dan kategori; tidak boleh mengubah akun sendiri', {
        body: 'UpdateUser',
        id: true,
      }),
    },
    '/admin/units': {
      get: operation('Daftar unit'),
      post: operation('SUPER_ADMIN: tambah unit', { body: 'Unit', status: 201 }),
    },
    '/admin/schedules': {
      post: operation('Buat jadwal aktual satu pegawai per tanggal kerja WIB', {
        body: 'Schedule',
        status: 201,
      }),
    },
    '/schedules': { get: operation('Jadwal pegawai yang login', { parameters: range }) },
    '/devices': { get: operation('Daftar perangkat sendiri') },
    '/devices/bind': {
      post: operation('Ajukan perangkat dengan bukti kepemilikan private key', {
        body: 'DeviceBind',
        status: 201,
      }),
    },
    '/admin/devices': { get: operation('Daftar perangkat dalam lingkup admin') },
    '/admin/devices/{id}': {
      patch: operation('Setujui atau cabut perangkat', { id: true, body: 'DeviceReview' }),
    },
    '/attendance/challenges': {
      post: operation('Buat challenge sekali pakai, berlaku 90 detik', {
        body: 'Challenge',
        status: 201,
      }),
    },
    '/face/enroll': {
      post: operation('Daftarkan 3–5 foto; menunggu verifikasi identitas admin', {
        multipart: 'Enrollment',
        status: 201,
      }),
    },
    '/admin/face-enrollments': { get: operation('Daftar enrollment menunggu persetujuan') },
    '/admin/face-enrollments/{id}': {
      patch: operation('Setujui identitas atau tolak enrollment', {
        id: true,
        body: 'FaceReview',
        status: 204,
        empty: true,
      }),
    },
    '/admin/users/{id}/face': {
      delete: operation('Hapus template biometrik; memerlukan enrollment ulang', {
        id: true,
        body: 'Reason',
        status: 204,
        empty: true,
      }),
    },
    '/attendance/check-in': {
      post: operation('Absen masuk', {
        multipart: 'Attendance',
        status: 201,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { ...str, minLength: 16, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
          },
        ],
      }),
    },
    '/attendance/check-out': {
      post: operation('Absen pulang; memerlukan check-in', {
        multipart: 'Attendance',
        status: 201,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { ...str, minLength: 16, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
          },
        ],
      }),
    },
    '/attendance/attempts/{id}': {
      get: operation('Status dan hasil percobaan sendiri', { id: true }),
    },
    '/attendance/history': {
      get: operation('Riwayat absensi sah; batas tanggal WIB inklusif', {
        parameters: [...range, ...pagination],
      }),
    },
    '/admin/audit-logs': {
      get: operation('SUPER_ADMIN: audit log append-only', { parameters: pagination }),
    },
  },
};
