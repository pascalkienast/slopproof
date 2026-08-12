# SlopProof MVP and Production Readiness Status

Stand: 2026-08-13

## Abnahmeurteil

Der lokale, offlinefähige MVP-Schnitt ist als zusammenhängender Web-, Worker-,
PostgreSQL- und Adapterflow implementiert und im Compose-Referenzprofil
abgenommen. Fake-GitHub und Fake-Modellprovider sind bewusst lokal; Auth-,
SHA-, Zustands-, Browser-Krypto-, Multipart-, Review-, Policy- und
Retentiongrenzen sind reale Implementierungsteile.

Der Stand ist noch **nicht vollständig produktionsreif**. Der vollständige containerisierte
Medienrundlauf `Browser → S3-Referenzspeicher → Worker/FFmpeg → Review →
physische Löschung` ist mit synthetischer Kamera und synthetischem Mikrofon
grün. Die produktive GitHub-Control- und OAuth-Implementierung steht; ihre
Interoperabilität mit der real installierten App ist noch nicht live bestätigt.
Ein physischer Smartphone-Smoke über öffentliches HTTPS sowie produktive
Modellprovider bleiben offen.

## Phasengates

| Gate                              | Status                              | Befund                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Workspace                     | bestanden                           | pnpm-Workspace, Next-Web, separater Worker, Node-24-Containerziel, CI und Boundary-Audit stehen. Das Containerimage läuft laut Dockerfile als unprivilegierter `node`-User.                                                                                                                                    |
| B — Domain und DB                 | bestanden                           | Explizite 11-Status-Zustandsmaschine, eingefrorene Repository-Policy, Transaktionen, Constraints, Session-/Handoff-/Uploadzustand und kanonische Evidence-Deadline sind implementiert.                                                                                                                         |
| C — Fake GitHub                   | bestanden                           | Signaturprüfung, Delivery-Dedupe, Current-SHA-Invalidierung, Checkadapter und die Kette `Webhook → Analysejob → Proof-Plan → Attempt` laufen lokal.                                                                                                                                                            |
| D — Analyse, Practice, Proof-Plan | bestanden                           | Begrenzte Diffanalyse, drei Risikobudgets, Mega-/Split-Pfad, optionale Practice und davon getrennte Proof-Fragen sind deterministisch umgesetzt.                                                                                                                                                               |
| E — Handoff und Aufnahme          | bestanden mit externem Restnachweis | One-Time-Handoff, repository-/autor-/SHA-gebundene Session, Kamera-/Codec-Preflight, echte MediaRecorder-/WebCrypto-Implementierung sowie technischer Abort und Ersatzversuch stehen. Ein vollständiger Take lief im 390-px-Browser mit Fake-Medien; der physische Telefon-Smoke bleibt offen.                 |
| F — Evidence Security             | bestanden                           | `SP-RC1`, clientseitige AEAD-Verschlüsselung, RSA-OAEP-Wrapping, HMAC-Manifest, generisches Multipart-Packing, worker-only Streaming-Entschlüsselung, verschlüsselte Frame-Derivate und kurzlebige Review-Capabilities sind implementiert, negativ getestet und im S3-/FFmpeg-Compose-Rundlauf bestätigt.      |
| G — Provider und Policy           | bestanden                           | Versionierte Fake-Transkription und Fake-Auswertung, Injection-Abwehr, verschlüsselte Providerpayloads und manuelle Policy sind umgesetzt. Jede Providerempfehlung endet zwingend in `review_required`.                                                                                                        |
| H — Maintainer und Check          | bestanden                           | Repositorygebundener Reviewzugriff, Current-SHA-Prüfung, append-only Entscheidung, Reviewkontext mit Zeitmarken/Frames und manuelle Check-Reconciliation stehen.                                                                                                                                               |
| I — End-to-End                    | bestanden mit externem Restnachweis | Produktionsbuild, Worker-Health, PostgreSQL-Produktfluss, vier Playwright-Flows und der vollständige Browser-/Ciphertext-/Worker-/Review-/Check-/Löschpfad im Compose-Referenzprofil sind grün. Offen bleiben ein physisches Smartphone und der Lifecycle-Backstop des später gewählten produktiven Speichers. |

## Verifizierter Stand

- ESLint: grün;
- TypeScript strict: grün;
- Unit-/Contracttests im Gate-2-Snapshot: 46 Dateien, 300 Tests grün;
- Provider-Live-Smoke-Verträge: 13 Tests grün, ohne Live-Aufruf;
- PostgreSQL-Integration im Gate-2-Snapshot: 10 Dateien, 67 Tests grün,
  darunter 39 produktive
  GitHub-Persistenz-, Replay- und Lifecycle-Race-Tests;
- Playwright gegen Produktionsbuild: 4 von 4 Flows grün;
- Next-Web-, Node-Worker- und GitHub-Control-Build: grün;
- Package-Boundary-Audit: grün;
- `docker compose config`: grün;
- Integrationsteardown: Domain- und pg-boss-Zustand anschließend leer;
- Demo-Migration und Seed: grün; Seed zweimal ausgeführt und strukturell auf
  Idempotenz, Policy-Bindung sowie numerische GitHub-IDs geprüft;
- effektive Compose-Grenze geprüft: Web mountet nur den öffentlichen Wrapping-
  Key, Worker nur den privaten Key und den Provider-Payload-Key.
- vollständiger 390-px-Browser-Smoke mit Fake-Kamera/-Mikrofon: direkter
  Ciphertext-Multipart-Upload, vollständige Authentifizierung und
  FFprobe-Auswertung, Fake-Transkript/Frame/Evaluation, `review_required` und
  private Wiedergabe über eine einmalige Worker-Capability;
- expliziter Maintainer-Pass erzeugte genau eine append-only Entscheidung für
  den aktuellen SHA und einen öffentlichen erfolgreichen Check ohne Evidence;
- die eingefrorene Early-Delete-Policy löschte Recording und Frame-Derivat
  physisch aus dem Bucket und schredderte Manifest, Wrapped-Key-Metadaten,
  Transkript und Evaluation; der Bucket war danach leer;
- der Worker blieb im korrigierten Medienpfad ohne Neustart und hinterließ keine
  Klartext-Mediendatei in seinem temporären Dateisystem.

## Production-V1-Gates

Der produktive Ausbau wird getrennt vom weiterhin offlinefähigen Fake-Compose-
Golden-Path abgenommen. Ein grünes MVP-Gate wird nicht als Nachweis für einen
externen Provider oder eine reale GitHub-Interaktion wiederverwendet.

| Gate                          | Status                              | Befund                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline und Preflight    | bestanden                           | Mac-Workspace und Bootstrap-Release auf der VM sind inhaltlich synchron. Der vollständige lokale Lauf ist grün: Format, ESLint, TypeScript, 129 Unit-, 19 PostgreSQL-Integrations- und 4 Playwright-Tests, Build, Compose-Config und Boundary-Audit. Der Browserlauf wurde reproduzierbar gegen eine isolierte, zweimal idempotent gesäte Datenbank ausgeführt. Ein eigener Repository-Secret-Audit prüft bekannte Schlüsselmarker und – wenn die lokale Secret-Datei bewusst geladen wird – exakte Laufzeitwerte, ohne Werte auszugeben. Lokale Package-Stores, Ausgaben, Backups, `.env`-Dateien und Schlüsseldateien sind aus Git- und Docker-Kontext ausgeschlossen.                                                                                                                                                                                                                                                                                                                                                                            |
| 1 — Produktionskonfiguration  | bestanden                           | Ein zwingendes `local\|production`-Profil, getrennte Web-/Media-Worker-/GitHub-Control-/Migration-Konfigurationen, kanonische Providerfelder und wertfreie Fehler sind implementiert. Production verweigert Demo/Fakes, HTTP-/Loopback-Public-Endpoints, Platzhalter, kurze Secrets, Legacy-Namen und prozessfremde Secrets. Der Compiler mappt R2 blind nach Vertrag, validiert und installiert vorhandene GitHub-/RSA-3072-Keydateien unverändert in ein geschütztes externes Staging und überschreibt nichts. 13 nicht-netzwerkende Capability-Vertragstests decken Hetzner Text/JSON, Hetzner Vision und OpenRouter STT ab; echte, potenziell kostenpflichtige Calls bleiben strikt hinter `LIVE_SMOKE=1` und wurden in diesem Gate nicht wiederholt. Der lokale Fake-Compose-Pfad bleibt unter Node 24 grün.                                                                                                                                                                                                                                   |
| 2 — GitHub App und OAuth      | bestanden mit externem Restnachweis | Ein getrennter GitHub-Control-Prozess mintet kurzlebige repositorygebundene Installation-Tokens aus einem validierten App-PEM, liest PR-Zustand und bounded Patches ohne Checkout, reconciliert Check Runs über eine transaktionale DB-Outbox und heilt Rate-Limit-, Crash- und Replayfälle dauerhaft. Raw-Body-HMAC, Delivery-Lease/Dedupe, `pull_request`- und App-Lifecycle-Events, `(Head, Base)`-Invalidierung sowie bounded, CAS-geschützte Installations-Recovery sind PostgreSQL-negativ getestet. OAuth verwendet State, PKCE, one-time DB-Flows, strikte Redirects, rotierte Sessions und einen kurzlebig versiegelten GitHub-Token-Cookie; Contributor- und Maintainerzugriffe werden repositorygebunden und Maintainerrechte vor jedem privaten Zugriff live geprüft. Das lokale Fake-Profil bleibt internetfrei. Offen ist ausschließlich der Live-Smoke mit einer tatsächlich installierten GitHub App.                                                                                                                               |
| 3 — Generation Context        | bestanden                           | Octokit-/Production-Revisionen werden ausschließlich aus dem unveränderlichen `github_revision_sources`-Snapshot geladen; LocalFake materialisiert denselben strikt validierten Offline-Vertrag. Der autoritative bounded Analyzer erzeugt danach in derselben Transaktion genau einen unveränderlichen `GenerationContextV1`, dessen Head/Base, Source-Hash, Snapshot, Anchor-IDs und vollständige Anchor-Deskriptoren PostgreSQL-seitig gebunden sind. Kanonisches Kontextmaterial und Provider-Material werden bytegenau gehasht und auf 512 KiB begrenzt; Lockfiles, generierter Code, Archive, LFS, Git-Symlinks, Submodule und ungewöhnliche Pfade bleiben metadata-only. Proof-Pläne/Fragen binden den persistierten Context und werden bei Replays exakt verglichen. Es gibt keinen Clone, keine Repository-Suche und keinen Blob-Download; die GitHub-Steuerung liest ausschließlich bounded PR-Dateien und exakte Tree-Metadaten. Unit-, Fresh-PostgreSQL-0000–0011-, LocalFake-Produktflow-, Type-, Lint- und Build-Nachweise sind grün. |
| 4 — Learning, Practice, Proof | bestanden                           | Drei getrennte, worker-only Learning-, Practice- und Proof-Ports nutzen versionierte Zod-Verträge, servereigene IDs/Hashes/Deadlines und entweder drei vollständig offline laufende LocalFake-Adapter oder getrennte Hetzner-Modelle. Provideroutput wird strikt an den unveränderlichen GenerationContext und dessen exakte Anchor-Deskriptoren gebunden, höchstens einmal kontrolliert repariert und danach durch einen ankergebundenen, sichtbar degradierten deterministischen Fallback ersetzt. Proof wird vor Learning eingefroren; serverseitig geladene Proof-Texte verlassen den Worker nie und blockieren kollidierende Learning-/Feedback-Inhalte vor Persistenz, ohne Practice-Daten an Proof-Provider oder Judge zu geben. Learning, Antworten und Feedback sind AES-GCM-verschlüsselt, kurzlebig, repository-/author-/current-SHA-gebunden und über one-time Capabilities, CSRF, Rate-Limits und atomare JTI-Claims geschützt. V2-Proof wird atomar in den served Plan gespiegelt und erst danach an einen Attempt gebunden; nur Maintainer können weiter entscheiden. Fresh-PostgreSQL-0000–0012, Retry/Crash/Replay/Retention, Legacy-Fallback, +16-Minuten-Recovery, Unit-, Type-, Lint-, Build-, Boundary- und Secret-Nachweise sind grün. |
| 5 — Transkription             | offen                               | Der Fake-Provider ist verdrahtet; echte bounded-RAM-Transkription fehlt noch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6 — Multimodaler Judge        | offen                               | Strikte Verträge und manuelle Policy stehen; echte Framebytes und der produktive Judge fehlen noch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7 — Produktions-Compose       | offen                               | Gehärtete Topologie, Healthchecks, Ressourcen- und Secret-Grenzen müssen noch als eigenes Profil umgesetzt werden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8 — Cloudflare R2             | offen                               | Private Runtime-Anbindung, Browser-CORS und Lifecycle-Backstop sind noch nicht live nachgewiesen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 9 — Deployment und Caddy      | offen                               | Der vorhandene Bootstrap bleibt unverändert; produktiver Service und Reverse-Proxy-Umschaltung sind noch nicht erfolgt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10 — Gesamtakzeptanz          | offen                               | Lokale und Live-Smokes werden erst nach den vorherigen Gates versionsgebunden wiederholt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Sicherheits- und Self-Host-Grenzen

- Aufnahmechunks werden im Smartphone-Browser vor dem Netzwerk
  authentifiziert verschlüsselt; Medienbytes laufen nicht durch die Web-API.
- Der Worker schreibt kein temporäres Klartextvideo auf Disk, sondern pipet
  entschlüsselte Bytes unter Ressourcenlimits an FFmpeg/ffprobe.
- Ausgewählte Frames werden unmittelbar als AES-GCM-Ciphertextderivate
  gespeichert. Transkript, Evaluation und privater Reviewkontext bleiben
  verschlüsselt beziehungsweise kurzlebig autorisiert.
- Web und Worker teilen keinen privaten Wrapping-Key. Ein kompromittierter
  Bucket oder die Datenbank allein reicht nicht zur Entschlüsselung.
- Kein externer KMS ist erforderlich. Das Self-Host-Profil nutzt ein lokales
  RSA-3072-Schlüsselpaar; externe KMS-Adapter bleiben optional.
- Der Storage-Port ist produktneutral. Compose verwendet VersityGW als eine
  S3-kompatible Referenz; MinIO ist weder Abhängigkeit noch feste Architektur.
- Es gibt kein Auto-Pass oder Auto-Fail. Ausschließlich ein berechtigter
  Maintainer kann den aktuellen Check freigeben.
- Retention löscht Objekt, Derivate und Key-Metadaten idempotent; fehlgeschlagene
  Jobs werden neu eingeplant und verwaiste Multipart-Uploads aktiv abgebrochen.

## Offene externe Nachweise

1. Einen echten Smartphone-Smoke über eine vom Telefon erreichbare HTTPS-URL,
   passenden Public-S3-Endpunkt und CORS durchführen.
2. Storage-native Lifecycle-Regeln als zusätzlichen Backstop mit dem gewählten
   produktiven Objektspeicher verifizieren; der Anwendungspfad ist bereits
   getestet.
3. Die produktive GitHub-App-Implementierung ist ohne Netzwerk mit Octokit-
   Contracttests und echten PostgreSQL-Races abgenommen. Ihre Interoperabilität
   mit einer tatsächlich installierten App sowie echte Providerqualität bleiben
   bis zu den späteren Live-Smokes unbestätigt.
4. Der lokale Host läuft mit Node 23.9.0 und meldet deshalb einen Engine-Hinweis;
   Zielruntime, CI und Dockerfile sind auf Node 24 festgelegt.
