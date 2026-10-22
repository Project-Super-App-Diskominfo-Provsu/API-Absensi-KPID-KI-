import type { Db } from '../../database/client.js';

export interface FaceTemplate {
  id: string;
  user_id: string;
  encrypted_embedding: string;
  model_version: string;
  quality_score: number;
  consent_version: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  created_at: string;
}

export async function findActiveEnrollmentUserForUpdate(db: Db, userId: string) {
  return db.query<{ face_enrollment_version: number }>(
    'SELECT face_enrollment_version FROM users WHERE id=$1 AND active FOR UPDATE',
    [userId],
  );
}

export async function incrementEnrollmentVersion(db: Db, userId: string) {
  return db.query(
    'UPDATE users SET face_enrollment_version=face_enrollment_version+1 WHERE id=$1',
    [userId],
  );
}

export async function findActiveOrPendingTemplate(db: Db, userId: string) {
  return db.query<{ id: string }>(
    "SELECT id FROM face_templates WHERE user_id=$1 AND status IN ('ACTIVE','PENDING')",
    [userId],
  );
}

export async function findActiveFaceTemplate(db: Db, userId: string) {
  return db.query<{ id: string; encrypted_embedding: string; model_version: string }>(
    "SELECT id,encrypted_embedding,model_version FROM face_templates WHERE user_id=$1 AND status='ACTIVE'",
    [userId],
  );
}

export async function insertFaceTemplate(
  db: Db,
  userId: string,
  encryptedEmbedding: string,
  modelVersion: string,
  qualityScore: number,
  consentVersion: string,
) {
  return db.query<{ id: string; status: string; model_version: string }>(
    `INSERT INTO face_templates(user_id,encrypted_embedding,model_version,quality_score,consent_version)
    VALUES($1,$2,$3,$4,$5) RETURNING id,status,model_version`,
    [userId, encryptedEmbedding, modelVersion, qualityScore, consentVersion],
  );
}

export async function findPendingFaceEnrollments(
  db: Db,
  isSuperAdmin: boolean,
  categoryCode: string | null,
) {
  return db.query<{
    id: string;
    user_id: string;
    model_version: string;
    quality_score: number;
    status: string;
    created_at: string;
    name: string;
  }>(
    `SELECT f.id,f.user_id,f.model_version,f.quality_score,f.status,f.created_at,u.name FROM face_templates f JOIN users u ON u.id=f.user_id
    WHERE f.status='PENDING' AND ($1::boolean OR (u.employee_category_code=$2 AND u.role IN ('EMPLOYEE','VERIFIER'))) ORDER BY f.created_at LIMIT 100`,
    [isSuperAdmin, categoryCode],
  );
}

export async function findFaceTemplateById(db: Db, id: string) {
  return db.query<{ id: string; user_id: string }>(
    'SELECT id,user_id FROM face_templates WHERE id=$1',
    [id],
  );
}

export async function updateFaceTemplateApproval(
  db: Db,
  id: string,
  status: 'ACTIVE' | 'REVOKED',
  approverId: string,
) {
  return db.query<{ id: string }>(
    "UPDATE face_templates SET status=$2,approved_by=$3,revoked_at=CASE WHEN $2='REVOKED' THEN now() END WHERE id=$1 AND status='PENDING' RETURNING id",
    [id, status, approverId],
  );
}

export async function deleteFaceTemplatesByUserId(db: Db, userId: string) {
  return db.query('DELETE FROM face_templates WHERE user_id=$1', [userId]);
}
