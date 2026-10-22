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
  content: json({
    type: 'object',
    properties: {
      data: {},
      meta: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      request_id: str,
    },
  }),
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
    cookie?: boolean;
    result?: string;
  } = {},
) {
  return {
    summary,
    security: options.cookie ? [{ webRefresh: [] }] : options.public ? [] : [{ bearerAuth: [] }],
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
      [options.status ?? 200]: options.empty
        ? { description: 'Berhasil tanpa body.' }
        : options.result
          ? { description: 'Berhasil', content: json(ref(options.result)) }
          : response,
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
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      webRefresh: { type: 'apiKey', in: 'cookie', name: 'absensi_web_refresh' },
    },
    schemas: {
      Error: object(
        {
          error: object(
            {
              code: str,
              message: str,
              details: { type: 'array', items: object({ field: str, message: str }) },
            },
            ['code', 'message'],
          ),
          request_id: str,
        },
        ['error', 'request_id'],
      ),
      Login: object({ email: { ...str, format: 'email' }, password: { ...str, maxLength: 128 } }),
      WebSession: object({
        data: object({
          access_token: str,
          token_type: { const: 'Bearer' },
          expires_in: { type: 'integer', maximum: 600 },
          csrf_token: str,
        }),
      }),
      WebCsrf: object({ data: object({ csrf_token: str }) }),
      GoogleExchange: object({ challenge_id: uuid, id_token: { ...str, maxLength: 16384 } }),
      GoogleChallenge: object({
        data: object({ challenge_id: uuid, nonce: str, expires_at: timestamp }),
      }),
      GoogleStart: object({ data: object({ authorization_url: { ...str, format: 'uri' } }) }),
      SchedulePatch: object(
        {
          work_date: date,
          starts_at: timestamp,
          ends_at: timestamp,
          grace_minutes: { type: 'integer', minimum: 0, maximum: 120 },
          reason: { ...str, minLength: 5, maxLength: 500 },
        },
        ['reason'],
      ),
      Refresh: object({ refresh_token: str }),
      SsoIdentity: object(
        {
          user_id: uuid,
          subject: { ...str, maxLength: 255 },
          auth_mode: { enum: ['SSO', 'BOTH'] },
          issuer: { ...str, format: 'uri' },
          reason: { ...str, minLength: 5, maxLength: 500 },
        },
        ['user_id', 'subject', 'auth_mode', 'reason'],
      ),
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
        {
          ...Object.fromEntries(Object.entries(userProps).filter(([key]) => key !== 'password')),
          auth_mode: {
            type: 'string',
            enum: ['LOCAL', 'SSO', 'BOTH'],
            description: 'Hanya SUPER_ADMIN lain; perubahan mencabut sesi aktif pengguna.',
          },
          google_email_linking_allowed: {
            type: 'boolean',
            description:
              'Izin sekali pakai untuk login pertama Google via email terverifikasi; hanya SUPER_ADMIN lain.',
          },
        },
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
          work_date: {
            ...date,
            description:
              'Tanggal kerja Asia/Jakarta; starts_at dan ends_at wajib berada pada tanggal ini. Jadwal lintas tanggal belum didukung.',
          },
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
    '/auth/methods': {
      get: operation('Metode login yang dikonfigurasi: local, sso OIDC legacy, google, web', {
        public: true,
      }),
    },
    '/admin/sso/identities': {
      post: operation(
        'SUPER_ADMIN: petakan issuer/sub terverifikasi ke pegawai yang sudah ada; tidak boleh memetakan diri sendiri',
        { body: 'SsoIdentity', status: 201 },
      ),
      get: operation('SUPER_ADMIN: daftar identitas Google/OIDC pegawai', {
        parameters: [{ name: 'user_id', in: 'query', required: true, schema: uuid }],
      }),
    },
    '/admin/sso/identities/{id}': {
      delete: operation(
        'SUPER_ADMIN: cabut pemetaan dan sesi pegawai; pemetaan sendiri memerlukan admin lain',
        { id: true, body: 'Reason', status: 204, empty: true },
      ),
    },
    '/auth/web/login': {
      post: operation(
        'Login ADMIN/SUPER_ADMIN; Origin wajib. Set cookie HttpOnly; refresh token tidak ada di JSON.',
        {
          body: 'Login',
          public: true,
          result: 'WebSession',
          parameters: [{ name: 'Origin', in: 'header', required: true, schema: str }],
        },
      ),
    },
    '/auth/web/session': {
      post: operation('Pulihkan CSRF setelah reload; Origin wajib. Tidak merotasi sesi.', {
        cookie: true,
        result: 'WebCsrf',
        parameters: [{ name: 'Origin', in: 'header', required: true, schema: str }],
      }),
    },
    '/auth/web/refresh': {
      post: operation(
        'Rotasi sesi web; origin dan CSRF wajib. FE mengoordinasikan refresh termasuk antar-tab.',
        {
          cookie: true,
          result: 'WebSession',
          parameters: [
            { name: 'Origin', in: 'header', required: true, schema: str },
            { name: 'X-CSRF-Token', in: 'header', required: true, schema: str },
          ],
        },
      ),
    },
    '/auth/web/logout': {
      post: operation('Cabut keluarga sesi web dan hapus cookie', {
        cookie: true,
        status: 204,
        empty: true,
        parameters: [
          { name: 'Origin', in: 'header', required: true, schema: str },
          { name: 'X-CSRF-Token', in: 'header', required: true, schema: str },
        ],
      }),
    },
    '/auth/google/challenge': {
      post: operation('Nonce Google native satu kali, berlaku 5 menit', {
        public: true,
        status: 201,
        result: 'GoogleChallenge',
      }),
    },
    '/auth/google': {
      post: operation(
        'Tukar Google ID token Android menjadi token aplikasi; akun harus sudah dipetakan',
        { public: true, body: 'GoogleExchange' },
      ),
    },
    '/auth/web/google/start': {
      post: operation('Mulai Google authorization-code + PKCE; set cookie pengikat browser', {
        public: true,
        status: 201,
        result: 'GoogleStart',
        parameters: [{ name: 'Origin', in: 'header', required: true, schema: str }],
      }),
    },
    '/auth/web/google/callback': {
      get: {
        ...operation(
          'Callback Google; state, nonce, PKCE dan browser diperiksa. Redirect tetap tanpa token pada URL.',
          {
            public: true,
            parameters: [
              { name: 'state', in: 'query', required: true, schema: str },
              { name: 'code', in: 'query', required: true, schema: str },
            ],
          },
        ),
        responses: {
          '303': {
            description:
              'Ke ADMIN_WEB_ORIGIN/auth/callback; kegagalan ke /login?error=SSO_LOGIN_FAILED. Sesi web melalui cookie.',
          },
        },
      },
    },
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
      get: operation('Daftar pegawai dalam lingkup admin; data array dan meta limit/offset/total', {
        parameters: [
          ...pagination,
          ...['q', 'employee_category_code', 'role', 'active'].map((name) => ({
            name,
            in: 'query',
            schema: str,
          })),
        ],
      }),
      post: operation('Buat pegawai KPID/KI', { body: 'CreateUser', status: 201 }),
    },
    '/admin/users/{id}': {
      get: operation('Detail pegawai dalam lingkup admin; tidak memuat password/embedding', {
        id: true,
      }),
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
      get: operation('Daftar jadwal dalam cakupan admin; data array dan meta limit/offset/total', {
        parameters: [...range, ...pagination, { name: 'user_id', in: 'query', schema: uuid }],
      }),
      post: operation('Buat jadwal aktual satu pegawai per tanggal kerja WIB', {
        body: 'Schedule',
        status: 201,
      }),
    },
    '/admin/schedules/{id}': {
      patch: operation(
        'Ubah jadwal dengan alasan audit; jadwal berabsensi ditolak 409 SCHEDULE_LOCKED',
        { id: true, body: 'SchedulePatch' },
      ),
    },
    '/admin/attendances': {
      get: operation(
        'Daftar absensi sah. Admin kategori dibatasi kategori pegawai terkini DAN kategori pada event; riwayat perpindahan kategori tersedia untuk SUPER_ADMIN.',
        {
          parameters: [
            ...range,
            ...pagination,
            { name: 'user_id', in: 'query', schema: uuid },
            { name: 'office_id', in: 'query', schema: uuid },
            { name: 'type', in: 'query', schema: { enum: ['CHECK_IN', 'CHECK_OUT'] } },
            {
              name: 'status',
              in: 'query',
              schema: { enum: ['PRESENT', 'LATE', 'EARLY_LEAVE', 'ON_TIME'] },
            },
          ],
        },
      ),
    },
    '/schedules': { get: operation('Jadwal pegawai yang login', { parameters: range }) },
    '/devices': { get: operation('Daftar perangkat sendiri') },
    '/devices/bind': {
      post: operation('Ajukan perangkat dengan bukti kepemilikan private key', {
        body: 'DeviceBind',
        status: 201,
      }),
    },
    '/admin/devices': {
      get: operation('Daftar perangkat dalam lingkup admin; data array + meta', {
        parameters: [
          ...pagination,
          { name: 'user_id', in: 'query', schema: uuid },
          { name: 'status', in: 'query', schema: { enum: ['PENDING', 'ACTIVE', 'REVOKED'] } },
        ],
      }),
    },
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
      post: operation(
        'Daftarkan 3–5 foto; menunggu verifikasi admin. Reset/perubahan enrollment saat pemrosesan ditolak 409 FACE_ENROLLMENT_CHANGED; mulai ulang dengan challenge baru.',
        {
          multipart: 'Enrollment',
          status: 201,
        },
      ),
    },
    '/admin/face-enrollments': {
      get: operation(
        'Daftar enrollment dalam lingkup admin; default PENDING, tanpa foto/embedding; data array + meta',
        {
          parameters: [
            ...pagination,
            { name: 'user_id', in: 'query', schema: uuid },
            {
              name: 'status',
              in: 'query',
              schema: { enum: ['PENDING', 'ACTIVE', 'REVOKED'], default: 'PENDING' },
            },
          ],
        },
      ),
    },
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
