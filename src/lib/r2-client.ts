import "server-only";
import { S3Client } from "@aws-sdk/client-s3";
import { R2QuotaError, r2Identity } from "./r2-quota";

export function r2Client(): S3Client {
  const { account } = r2Identity();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new R2QuotaError(503, "R2 storage is not configured.");
  // Every attempt needs its own reservation. The SDK must not retry invisibly.
  return new S3Client({ region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`, forcePathStyle: true,
    maxAttempts: 1, credentials: { accessKeyId, secretAccessKey } });
}
