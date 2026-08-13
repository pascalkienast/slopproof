import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.S3_CONTROL_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const allowedOrigin = process.env.S3_ALLOWED_ORIGIN;
if (
  !endpoint ||
  !bucket ||
  !accessKeyId ||
  !secretAccessKey ||
  !allowedOrigin
) {
  throw new Error("Storage initialization environment is incomplete");
}

const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

let available = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    available = true;
    break;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        available = true;
        break;
      } catch {
        // The gateway may still be starting; retry without logging credentials.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
if (!available) throw new Error("S3 reference adapter did not become ready");

await client.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: [allowedOrigin],
          AllowedMethods: ["PUT"],
          AllowedHeaders: ["content-type"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 300,
        },
      ],
    },
  }),
);

client.destroy();
process.stdout.write(
  "Private evidence bucket and browser PUT CORS are ready.\n",
);
