import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const requiredNames = [
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_CONTROL_ENDPOINT",
];

for (const name of requiredNames) {
  if (!process.env[name]) {
    throw new Error(`Missing required test-storage variable: ${name}`);
  }
}

const client = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_CONTROL_ENDPOINT,
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const bucket = process.env.S3_BUCKET;
let lastError;

try {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }), {
          abortSignal: AbortSignal.timeout(1_500),
        });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 409) throw error;
      }

      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(1_500),
      });
      console.log("Test object-storage bucket is ready.");
      process.exitCode = 0;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 30) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
} finally {
  client.destroy();
}

if (lastError) {
  throw new Error("Test object-storage bucket did not become ready in time.", {
    cause: lastError,
  });
}
