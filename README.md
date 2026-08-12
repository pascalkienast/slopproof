# SlopProof

Stand: 2026-08-12  
Status: lokaler MVP einschließlich Compose-Medien-Smoke test-grün; produktive
GitHub-Control-/OAuth-Implementierung vorhanden, realer GitHub-App-Smoke,
physischer Smartphone-Smoke und produktive Modelladapter noch offen

## Kurzform

SlopProof ist ein selbst hostbares Open-Source-Gate für Pull Requests. Es prüft
nicht, wie Code entstanden ist. Es verlangt, dass ein Contributor die konkrete
Änderung vor dem Merge erklären kann.

Der Check bietet zwei gleich sichtbare Einstiege:

1. `Practice your understanding` bereitet den Patch optional als Lernraum auf. Der
   Contributor sieht veränderte Bereiche, Risiken, Abhängigkeiten, Tests und
   Übungsfragen.
2. `Prove your understanding` kann jederzeit direkt gestartet werden und
   übergibt per QR-Code an ein Smartphone. Dort
   beantwortet der Contributor ein risikoadaptives Set patchbezogener Fragen
   in einem ununterbrochenen Live-Video.

Ein multimodales LLM kann Video, Transkript, ausgewählte Frames, Patchkontext
und Rubrik vergleichen. Im MVP ist dieser Befund ausschließlich assistierend:
Jeder Proof geht an einen berechtigten Maintainer, und nur dessen Entscheidung
kann den Check freigeben. Kalibriertes Auto-Pass ist ein späterer Ausbau nach
Shadow-Betrieb und Dogfood.

> **Prove you know what you ship.**

## Produktprinzipien

- SlopProof bewertet Patchverständnis, keine vermutete KI-Nutzung.
- Practice macht den Ablauf fair: Menschen mit unterschiedlicher Erfahrung
  erhalten denselben vorbereitenden Zugang zum Patch. Es ist niemals eine
  Voraussetzung für Proof; erfahrene Contributors und kleine PRs dürfen den
  Lernraum vollständig überspringen.
- Proof bleibt überraschend. Practice zeigt Lernziele, aber nicht die späteren
  Live-Fragen.
- Das Fragenbudget richtet sich nach semantischer Breite und Risiko. Kleine
  Patches erhalten meist eine Frage, mittlere zwei bis drei, große oder
  sicherheitskritische vier bis fünf oder eine Empfehlung zum Aufteilen.
- `One take` bezeichnet eine zusammenhängende Aufnahme. Die Fragen erscheinen
  darin nacheinander.
- Jeder Versuch gehört zu einem Autor, Repository, Pull Request und Head-SHA.
  Ein neuer Push invalidiert laufende und bestandene Versuche.
- Das Smartphone erzeugt pro Versuch einen Data Encryption Key und
  verschlüsselt jeden Aufnahmechunk authentifiziert, bevor er das Gerät
  verlässt. Der direkte Multipart-Upload enthält ausschließlich Ciphertext;
  im Bucket entsteht niemals ein temporäres Klartextvideo.
- Video und Derivate werden nach kurzer Frist gelöscht. Zugriff auf
  entschlüsselte Evidenz erhalten nur berechtigte Maintainer im Reviewpfad.
- SlopProof führt im MVP keinen Code aus dem Pull Request aus.
- Betreiber wählen Modellanbieter und Deployment selbst. SlopProof begrenzt
  Medienzugriff technisch, verspricht aber keine fremden Providerbedingungen.
- Objektspeicher und Key Wrapping sind austauschbare Infrastrukturadapter.
  Das Compose-Profil verwendet derzeit VersityGW als S3-kompatibles Beispiel;
  MinIO ist weder Voraussetzung noch Produktabhängigkeit. Ein externer
  KMS-Dienst ist nicht verpflichtend; das
  Self-Host-Profil kann ein lokales asymmetrisches Schlüsselpaar verwenden,
  dessen privater Schlüssel ausschließlich dem Worker als Secret vorliegt.

## Aktiver Scope

Der erste reale Schnitt umfasst:

- GitHub-Webhook-, OAuth-, PR- und Check-Ports mit lokalem Fake-Adapter sowie
  getrenntem produktivem Octokit-Control-Prozess;
- optionalen Practice-Deep-Dive;
- risikoadaptive Fragenplanung;
- QR-/Handoff-Flow zum Smartphone;
- Kamera-/Mikrofon-Preflight und ununterbrochene Videoaufnahme;
- clientseitige, attempt-spezifische Chunkverschlüsselung vor dem direkten
  Upload; ausschließlich Ciphertext im Objektspeicher;
- Transkription, begrenzte Frame-Auswahl und multimodale LLM-Auswertung;
- verpflichtendes Maintainer-Review mit assistierendem Modellbefund;
- präzise Retry-Gründe, Push-Invalidierung, Audit Log und Löschjob.

Nicht Teil dieses Schnitts sind frei wählbare Antwortmodalitäten, öffentliche
Evidenz, biometrische Identifikation, Blickverfolgung, Raumscan, dauerhaftes
Contributor-Scoring und Ausführung von PR-Code.

## Lokaler Start

Das Referenzprofil benötigt Docker Compose. Es startet Web, Worker, PostgreSQL,
VersityGW hinter dem austauschbaren S3-Port sowie lokale Fake-Adapter für
GitHub, Transkription und multimodale Auswertung:

```bash
docker compose up --build
```

Danach liegt der Golden Path unter
[`http://localhost:3000/demo`](http://localhost:3000/demo). Migration und drei
synthetische Pull Requests werden beim Start automatisch angelegt. Das
Compose-Profil veröffentlicht seine Ports standardmäßig ausschließlich auf
`127.0.0.1`, weil der Demo-Login absichtlich keine produktive Identität ersetzt.
`LOCAL_BIND_ADDRESS=0.0.0.0` darf deshalb nicht zusammen mit `DEMO_MODE=true`
für ein erreichbares Deployment verwendet werden.

Für die Entwicklung ohne Container ist Node 24 und pnpm 10.8 erforderlich:

```bash
pnpm install --frozen-lockfile
pnpm dev:keys
pnpm verify
```

Das lokale Profil setzt `DEPLOYMENT_PROFILE=local` und bleibt dadurch trotz
optimiertem Next-Produktionsbuild bei den internetfreien Fake-Adaptern. Ein
produktiver Prozess muss ausdrücklich `DEPLOYMENT_PROFILE=production` setzen;
die vier Prozesskonfigurationen für Web, Media-Worker, GitHub-Control und
Migration werden dann getrennt und fail-closed validiert. Aus dem vorhandenen
lokalen Secretbestand lassen sie sich ohne Ausgabe von Werten in ein neues,
geschütztes Verzeichnis kompilieren:

```bash
source "$HOME/.secrets/slopproof.env"
pnpm production:env -- /absolute/path/to/new-output-directory
```

Der Compiler überschreibt keine vorhandenen Dateien. Er
verwendet ausschließlich kanonische Laufzeitnamen, übernimmt den privaten
GitHub-App-Key nur als Container-Dateipfad und gibt Worker-Providerkeys weder
an Web noch GitHub-Control weiter.

PostgreSQL-Integrationstests erwarten zusätzlich `TEST_DATABASE_URL`. Der
Playwright-Lauf erwartet eine migrierte, gesäte Webinstanz; die CI bildet diese
Reihenfolge vollständig ab.

Ein echter Smartphone-Test braucht eine vom Telefon erreichbare HTTPS-URL,
passende S3-CORS-/Public-Endpunkte und eine echte Authentisierung. Der lokale
Demo-Modus ist dafür nicht als öffentliches Deployment gedacht. Weil der
öffentliche Storage-Origin Teil der Content-Security-Policy ist, muss das Image
nach einer Änderung von `S3_PUBLIC_ENDPOINT` neu gebaut werden.

## Implementierte Grenzen

- `apps/web`: Demo- und Mobile-Flow, Session/CSRF, One-Time-Handoff, direkter
  verschlüsselter Multipart-Upload sowie Maintainer-Review;
- `apps/worker`: Worker-only Entschlüsselung, FFprobe-Grenze, Fake-Provider,
  verschlüsselte Frame-Derivate, Policy-Anwendung, privater Reviewstream und
  Retention;
- `packages/media`: versioniertes `SP-RC1`-Protokoll mit AES-256-GCM,
  RSA-OAEP-256, HMAC-Manifest und generischem S3-Part-Packing;
- `packages/domain`, `packages/db`, `packages/policy`: SHA-gebundene
  Zustandsmaschine, Transaktionen, Constraints und ausschließlich manuelle
  Entscheidung;
- `apps/github-control` und `packages/github`: signierter bounded Webhook,
  kurzlebige repositorygebundene App-Tokens, echte PR-/Check-Ports, durable
  Reconciliation und weiterhin ein internetfreier Fake-Pfad;
- `packages/analysis`, `packages/questions`: begrenzte Diffanalyse sowie
  getrennte Practice- und Proof-Pläne.

Der aktuelle Abnahmebefund und verbleibende externe Smokes stehen in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Kanonische Unterlagen

- [[01-architektur-und-live-challenge|Systemarchitektur und Live-Video-Protokoll]]
- [[02-mvp-implementation-guide|Implementation Guide für den Live-Video-MVP]]
- [[03-ausbauplan-nach-live-video-mvp|Ausbauplan nach dem MVP]]
- [[04-brand-marketing-interface|Finales Brand-, Marketing- und Interface-System]]
- [[05-brand-v2-civic-interface|Designentscheidung und verworfene V2-Richtung]]
- [[06-live-video-mvp-and-brand-v3|Produkt- und Brandentscheidung V3]]
- [[slopproof-brand-ui-concept-v3.html|Aktiver klickbarer Prototyp]]
- [[archive/README|Archiv früherer HTML-Explorationen]]

## Projektstatus

- Produkt- und Designkonzept sowie lokaler MVP konsolidiert;
- Golden Path mit Fake-Adaptern, realer Browserverschlüsselung,
  Maintainerentscheidung und physischer Evidence-Löschung im Compose-
  Referenzprofil verifiziert;
- die produktive GitHub-App-Implementierung ist lokal und mit PostgreSQL-Races
  abgenommen; reale App-Interoperabilität, echte Modellqualität und ein
  physischer Smartphone-Smoke sind bewusst noch nicht bestätigt;
- noch kein GitHub-Repository angelegt;
- `slopproof.paskie.me` liefert bereits eine temporäre HTTPS-Landingpage; die
  produktive Anwendung ist dort noch nicht umgeschaltet;
- Arbeitsname: `SlopProof`.
