export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">The pull request accountability gate</p>
      <h1>
        Understand it.
        <br />
        Say it live.
        <br />
        Ship it.
      </h1>
      <p className="lede">
        Practice when it helps. When you&apos;re ready, answer focused questions
        on live video before the pull request can merge.
      </p>
      <div className="actions">
        <a className="button primary" href="/demo">
          Open the local demo
        </a>
        <a className="button" href="#security">
          Video security
        </a>
      </div>
      <section className="card" id="security">
        <p className="eyebrow">Private by architecture</p>
        <h2>Your video is locked down from capture to deletion.</h2>
        <p>
          Every recording chunk is encrypted in the browser. Only ciphertext
          reaches the private object store, and only a maintainer can decide the
          check.
        </p>
      </section>
    </main>
  );
}
