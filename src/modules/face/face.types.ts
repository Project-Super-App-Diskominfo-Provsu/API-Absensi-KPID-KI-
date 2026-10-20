export interface FaceObservation {
  embedding: number[];
  model_version: string;
  quality_score: number;
  liveness_score: number;
}
export interface FaceEngine {
  observe(image: Buffer, nonce: string): Promise<FaceObservation>;
  ready(): Promise<boolean>;
}
