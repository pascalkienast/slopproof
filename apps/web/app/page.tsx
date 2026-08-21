export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">A check on the current patch</p>
      <h1>
        Understand it.
        <br />
        Say it live.
        <br />
        Ship it.
      </h1>
      <p className="lede">
        Practice if you want. Then answer a short set of patch questions on live
        video before the pull request can merge.
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
        <p className="eyebrow">Video security</p>
        <h2>The recording is encrypted, then deleted.</h2>
        <p>
          Each recording chunk is encrypted in the browser. The object store
          gets ciphertext. A maintainer can review the check.
        </p>
      </section>
    </main>
  );
}
