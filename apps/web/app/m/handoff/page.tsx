import { Suspense } from "react";
import { MobileProof } from "./proof";

export default function MobileHandoffPage() {
  return (
    <Suspense
      fallback={<main className="mobile-shell">Opening secure handoff…</main>}
    >
      <MobileProof />
    </Suspense>
  );
}
