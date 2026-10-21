import { z } from 'zod';

export const pointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z
    .array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(4))
    .min(1),
});

export const officePolygonSchema = z.union([z.array(pointSchema).min(3), geoJsonPolygonSchema]);

export type OfficePolygonInput = z.infer<typeof officePolygonSchema>;

export const patchOfficeSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    polygon: officePolygonSchema.optional(),
    radius_m: z.literal(50).optional(),
    max_gps_accuracy_m: z.number().positive().max(50).optional(),
    max_location_age_s: z.number().int().min(1).max(120).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0)
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined));
