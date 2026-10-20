import { z } from 'zod';
import { GEO_MAX_LATITUDE } from './office.geo.js';
export const patchOfficeSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    latitude: z.number().min(-GEO_MAX_LATITUDE).max(GEO_MAX_LATITUDE).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radius_m: z.literal(50).optional(),
    max_gps_accuracy_m: z.number().positive().max(50).optional(),
    max_location_age_s: z.number().int().min(1).max(120).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0)
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined));
