export type PostUploadStatus = "processing" | "review_required" | "passed";

const STATUS_COPY: Record<
  PostUploadStatus,
  { eyebrow: string; heading: string; nextStep: string }
> = {
  processing: {
    eyebrow: "Proof submitted",
    heading: "Your proof is in.",
    nextStep:
      "You can close this page. The result will appear on your pull request when it is ready.",
  },
  review_required: {
    eyebrow: "Proof submitted",
    heading: "Your proof is in.",
    nextStep:
      "You can close this page. The result will appear on your pull request when it is ready.",
  },
  passed: {
    eyebrow: "Proof complete",
    heading: "Your proof passed.",
    nextStep: "You can close this page and return to your pull request.",
  },
};

export function PostUploadStatusCard({
  status,
  detail,
}: {
  status: PostUploadStatus;
  detail: string;
}) {
  const copy = STATUS_COPY[status];

  return (
    <section
      aria-live="polite"
      className="recording-card reviewing-card"
      role="status"
    >
      <p className="eyebrow">{copy.eyebrow}</p>
      <h1>{copy.heading}</h1>
      <p>{detail}</p>
      <p>{copy.nextStep}</p>
    </section>
  );
}
