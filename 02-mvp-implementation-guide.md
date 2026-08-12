# SlopProof MVP: Implementation Guide

Stand: 2026-08-12  
Status: umgesetzter Bauplan für `Practice → Live Video Proof`; bestätigte
Abnahmegrenzen stehen in `IMPLEMENTATION_STATUS.md`  
Zielgruppe: Coding-Agent mit anschließendem menschlichem Review

## 0. Auftrag

Baue den kleinsten vollständigen SlopProof-Flow, der einen Pull Request
analysiert, Practice anbietet, einen mobilen Live-Video-Proof aufnimmt, ihn
geschützt verarbeitet und den SHA-gebundenen GitHub Check aktualisiert.

Dieses Dokument ist der aktive Implementierungsauftrag. Frühere, breiter
angelegte Konzeptpläne sind keine Grundlage mehr.

Der Coding-Agent muss:

1. die Phasen in Reihenfolge umsetzen;
2. nach jeder Phase Tests, Typecheck und Lint ausführen;
3. `IMPLEMENTATION_STATUS.md` mit Befund, Abweichungen und offenen Risiken
   pflegen;
4. externe Grenzen mit Zod validieren;
5. Zustandswechsel und externe Effekte idempotent bauen;
6. Geheimnisse, Evidenz und personenbezogene Daten aus Logs, Fixtures,
   Screenshots und Git-Historie fernhalten;
7. keine produktive GitHub App, Domain, Cloudressource oder Providerrechnung
   ohne ausdrückliche Freigabe erzeugen.

## 1. Fertiger Nutzerfluss

1. Eine GitHub App empfängt ein PR-Event.
2. SlopProof speichert den aktuellen Head-SHA und setzt
   `SlopProof / understanding required` auf `in_progress`.
3. Ein Worker analysiert einen begrenzten Diff und erstellt Lernziele,
   Übungsfragen, Risikosignale und einen Proof-Plan.
4. Der Contributor kann `Practice your understanding` öffnen.
5. Der Contributor kann Practice überspringen und `Prove your understanding`
   direkt öffnen; dafür ist kein Practice-Zustand erforderlich.
6. `Prove your understanding` erzeugt einen kurzlebigen QR-Handoff.
7. Das Smartphone prüft Kamera, Mikrofon und Codec.
8. Beim serverseitigen Start erscheinen nacheinander die Fragen des
   risikoadaptiven Sets.
9. Der Browser zeichnet einen ununterbrochenen Take auf, verschlüsselt jeden
   MediaRecorder-Chunk vor dem Upload und lädt ausschließlich Ciphertext direkt
   in privaten Objektspeicher.
10. Der Worker erzeugt Transkript und eine kleine begründete Frame-Auswahl.
11. Ein multimodales LLM bewertet Antwort, Patchbezug und Rubrik strukturiert.
12. Jeder Proof geht mit dem assistierenden Modellbefund an
    Maintainer-Review.
13. Nur eine gültige Maintainerentscheidung für den aktuellen SHA setzt den
    Check grün.
14. Ein Push invalidiert den Nachweis. Evidenz wird nach kurzer Frist gelöscht.

## 2. Nichtziele

- keine Erkennung von KI-generiertem Code;
- keine frei wählbaren Antwortmodalitäten im normalen MVP-Flow;
- keine biometrische Identifikation oder Ausweiskontrolle;
- kein Gaze Tracking, Raumscan oder Screen Recording;
- kein öffentlicher Zugriff auf Video, Transkript oder Modellbegründung;
- kein dauerhaftes Contributor-Ranking;
- keine Ausführung von PR-Code;
- keine Microservices, Kubernetes-, Redis- oder Python-Zweitarchitektur;
- kein Auto-Pass oder Auto-Fail im MVP;
- keine persistente Klartextaufnahme im Browser, Objektspeicher oder Worker.

## 3. Technischer Rahmen

- Node.js 24 LTS;
- TypeScript strict;
- pnpm Workspaces;
- Next.js als Web-/API-Schale;
- separater Node-Worker;
- Octokit;
- PostgreSQL und Drizzle;
- `pg-boss`;
- privater Objektspeicher hinter einem Storage-Port, zunächst mit
  S3-kompatiblem Adapter;
- austauschbarer Key-Wrapping-Provider mit lokalem Self-Host-Adapter und
  optionalen externen KMS-Adaptern;
- Zod an allen externen Grenzen;
- FFmpeg/ffprobe nur im Worker;
- Pino mit Redaction;
- Vitest, Testcontainers und Playwright;
- OpenTelemetry erst nach stabilem Kernflow.

## 4. Repository-Struktur

```text
slopproof/
  apps/
    web/
    worker/
  packages/
    config/
    domain/
    policy/
    db/
    github/
    analysis/
    questions/
    media/
    providers/
    observability/
    testkit/
  infra/
    docker/
  docs/
  .github/workflows/
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
```

Regeln:

- `apps/*` verdrahten Transport und Prozesse;
- `domain` kennt weder Next.js noch Octokit, S3 oder konkrete Provider;
- `providers` enthält kleine Ports und Adapter, kein Agent-Framework;
- direkte Imports zwischen Apps sind verboten;
- Zeit, UUIDs, Zufall, GitHub, Storage, Key Wrapping und Modelle sind
  injizierbar.

## 5. Umgebungsvariablen

Gemeinsamer Kern:

```text
DATABASE_URL
APP_BASE_URL
SESSION_SECRET
GITHUB_APP_ID
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
EVIDENCE_STORAGE_PROVIDER
KEY_WRAPPING_PROVIDER
TRANSCRIPTION_PROVIDER
MULTIMODAL_JUDGE_PROVIDER
PROVIDER_API_KEY
LOG_LEVEL
```

Der erste S3-kompatible Storage-Adapter benötigt zusätzlich:

```text
S3_ENDPOINT
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
```

Der lokale Key-Wrapping-Adapter benötigt:

```text
KEY_WRAPPING_PUBLIC_KEY_PATH
KEY_WRAPPING_PRIVATE_KEY_PATH
```

Ein externer KMS-Adapter darf stattdessen providerabhängige Variablen wie
`KMS_PROVIDER` und `KMS_KEY_ID` verlangen. Jeder Prozess validiert beim Start
nur die gemeinsame und für seine aktiven Adapter erforderliche Konfiguration.
Fehler nennen Variablennamen, aber nie Werte.

Die `S3_*`-Variablen konfigurieren das Protokoll des ersten Storage-Adapters,
nicht ein bestimmtes Produkt. MinIO, ein anderer selbst gehosteter
S3-kompatibler Dienst oder ein externer Bucket müssen denselben Contract
erfüllen. MinIO-spezifische Imports außerhalb des Adapters sind verboten.

`KEY_WRAPPING_PROVIDER=local` ist das einfache Self-Host-Profil. Dabei liegen
öffentliches und privates Material in getrennten Dateien; nur der Worker erhält
den privaten Schlüssel als read-only Secret. Ein externer KMS ist optional.
Schlüsselmaterial selbst gehört niemals in eine Umgebungsvariable oder in die
Datenbank. Für das private lokale Schlüsselmaterial braucht das
Self-Host-Runbook ein getrenntes, verschlüsseltes Backup und einen getesteten
Restore-Pfad; sein Verlust macht vorhandene Evidence absichtlich unlesbar.

## 6. Domainzustände

Implementiere `AttemptStatus` als explizite Zustandsmaschine:

```ts
type AttemptStatus =
  | "preparing"
  | "ready"
  | "active"
  | "uploading"
  | "processing"
  | "review_required"
  | "passed"
  | "retry_required"
  | "technical_retry"
  | "expired"
  | "invalidated";
```

Jeder Übergang prüft:

- Ausgangszustand;
- aktuellen Head-SHA;
- Serverzeit;
- Actor und Berechtigung;
- erforderliche Artefakte;
- Idempotency Key.

Terminale Zustände werden nicht still überschrieben.

## 7. Datenbank

### Kerntabellen

`installations`

- GitHub Installation ID, Accountmetadaten, Status;
- keine persistierten Installation Tokens.

`repositories`

- Installation, GitHub Repository ID, Owner, Name, Default Branch;
- aktuelle Policyversion.

`repository_policies`

- versionierte validierte Policy als JSONB;
- Hash, Ersteller, Aktivierungszeit;
- append-only Versionen.

`pull_requests`

- Repository, GitHub PR ID und Nummer, Autor-ID, Status.

`pull_request_revisions`

- PR, Head-SHA, Base-SHA, Zeitpunkte;
- eindeutig pro PR und Head-SHA.

`webhook_deliveries`

- Delivery-ID unique, Event, Payloadhash, Verarbeitungsstatus;
- Payload nur minimiert beziehungsweise kurzlebig.

`analysis_snapshots`

- Revision, Analyzer-Version, Diffhash, Risikosignale, Status.

`practice_sessions`

- Revision, Nutzer, Start/Ende, Version;
- keine freien Antworten als Proof-Evidenz.

`proof_plans`

- Revision, Planversion, Risikoerklärung, Fragenbudget, Hash, Status.

`proof_questions`

- Plan, Reihenfolge, Typ, Text, Diff-Anker, Rubrik, Pflichtflag.

`attempts`

- Revision, Autor, Proof-Plan, Status, Start/Ablauf, Noncehash;
- höchstens ein aktiver Attempt pro Autor und Revision.

`recording_objects`

- Attempt, Object Key, gewrappter Data Key, Wrapping-Key-Referenz,
  Kryptoprotokollversion, Algorithmus, Größe, Dauer, Codec, Manifesthash,
  Löschfrist und Löschstatus.

`transcripts`

- Attempt, Provider-/Schemaversion, verschlüsselter Inhalt, Zeitmarken,
  Löschfrist.

`frame_selections`

- Attempt, Zeitmarke, Begründung, verschlüsseltes Derivat, Löschfrist.

`evaluations`

- Attempt, Provider, Modell, Prompt-, Schema- und Rubrikversion;
- strukturierter Befund und Rohantwort verschlüsselt beziehungsweise minimiert;
- unique über Attempt und vollständige Versionskombination.

`review_decisions`

- Attempt, Maintainer-ID, `pass|retry`, Reason Code, Begründung, Zeit;
- append-only.

`check_runs`

- Revision, GitHub Check Run ID, Status, Conclusion, letzte Synchronisierung.

`audit_events`

- Actor, Aktion, Objekt-ID, Zeit, Metadaten ohne Evidenzinhalt.

`deletion_jobs`

- Objektklasse, Objekt-ID, Deadline, Versuche, Ergebnis.

### Migrationen

- Jede Migration besitzt Up-Pfad und Testfixture.
- Constraints stehen in PostgreSQL, nicht nur in TypeScript.
- Indizes decken Webhook-Dedupe, aktive Attempts, Reviewqueue und Löschdeadline.

## 8. Queue-Verträge

Empfohlene Jobnamen:

```text
github.ingest-pr
github.reconcile-check
analysis.prepare-revision
proof.expire-attempt
media.finalize-upload
media.extract-transcript
media.select-frames
evaluation.run
evaluation.apply-policy
evidence.delete
evidence.audit-retention
```

Jeder Handler:

- validiert Payload mit Zod;
- nutzt fachlichen Idempotency Key;
- lädt aktuellen Zustand vor Seiteneffekten;
- klassifiziert Fehler als retryable oder terminal;
- loggt nur IDs und Fehlerklassen;
- darf nach Wiederholung denselben Endzustand erzeugen.

## 9. GitHub-App-Adapter

### Webhookroute

- Raw Body lesen;
- HMAC timing-safe prüfen;
- Delivery-ID, Event und Payloadschema validieren;
- Delivery atomar reservieren;
- Job enqueuen;
- schnell mit 2xx antworten.

### Installation Tokens

- nur bei Bedarf erzeugen;
- im Arbeitsspeicher kurz cachen;
- nie in DB oder Logs schreiben;
- Rechte vor jedem sensiblen API-Aufruf auf Installation und Repository binden.

### Check-Ausgabe

Öffentlich erlaubt:

- `understanding required`, `processing`, `review required`, `passed`,
  `action required`, `invalidated`;
- exakter Head-SHA;
- Link zur SlopProof-Oberfläche;
- knappe, nicht sensible Handlungsanweisung.

Nicht erlaubt:

- Fragen, Antworten, Transkript, Video-URL;
- Modellscore oder private Reviewbegründung;
- Spekulation über Toolnutzung oder Identität.

## 10. Diff- und Risikoanalyse

### Begrenzung

- Dateianzahl, Patchbytes und Einzeldateigröße deckeln;
- Binärdateien, Generated Files und Lockfiles markieren;
- Symlinks und ungewöhnliche Pfade als Daten behandeln;
- keine Checkout- oder Ausführungsschritte.

### Ausgabe

```ts
type AnalysisSnapshot = {
  summary: string;
  changedAreas: ChangedArea[];
  behavioralChanges: BehavioralChange[];
  risks: RiskSignal[];
  testSignals: TestSignal[];
  generatedFiles: string[];
  limitsHit: string[];
};
```

Die Analyse muss Belege auf Datei und Hunk zurückführen. Behauptungen ohne
sichtbaren Anchor werden nicht zur Frage.

## 11. Practice

### Inhalte

- Patchkarte;
- Verhalten und Abhängigkeiten;
- Risikostellen;
- Test- und Rollbackpfade;
- Übungsfragen;
- sichtbarer Übergang `I'm ready to prove it`.

### Datenschutz

- Antworten standardmäßig nur in der Session;
- keine Weitergabe an den Proof-Judge;
- keine Bewertung der Lernzeit oder Klickmuster;
- Practice-Nutzung darf höchstens aggregiert gemessen werden.

### DoD

- mindestens drei deterministische Fake-Patches rendern sinnvoll;
- Tastaturbedienung und mobile Lesbarkeit funktionieren;
- Practice verrät keine Proof-Frage;
- ein deaktiviertes Practice blockiert Proof nicht.
- Proof ist ohne angelegte oder abgeschlossene Practice-Session startbar.

## 12. Proof-Planer

### Inputs

- Analysis Snapshot;
- Repository-Policy;
- deterministischer serverseitiger Seed;
- Versionen von Planner und Fragentemplates.

### Budget

Der Planer berechnet einen nachvollziehbaren Risk Vector. Testfälle decken ab:

- kleiner lokaler Fix → 1 Frage;
- mittlere Änderung über mehrere Komponenten → 2–3;
- Auth-/Migration-/Concurrency-Patch → 4–5;
- 10.000 LOC Generated Output → kein künstlich großes Budget;
- unprüfbarer Mega-PR → Split-Empfehlung.

### Fragenqualität

Eine Proof-Frage:

- bezieht sich auf eine konkrete Verhaltensänderung;
- verlangt Erklärung, Vorhersage oder Abwägung;
- hat eine überprüfbare Rubrik;
- ist ohne Trivia über Dateinamen beantwortbar;
- doppelt keine andere Frage im Set;
- übernimmt keine Instruktion aus dem PR als Systembefehl.

Der Plan wird vor Attemptstart gespeichert und danach nicht verändert.

## 13. Login, Session und Autorisierung

- opake serverseitige Sessions;
- `HttpOnly`, `Secure`, `SameSite=Lax` oder strenger;
- CSRF-Schutz bei Mutationen;
- OAuth-State und PKCE, wo unterstützt;
- GitHub User Tokens nicht dauerhaft speichern;
- PR-Autor darf nur eigenen Proof starten;
- Maintainerberechtigung frisch über Installation/GitHub prüfen und kurz cachen;
- Supportrollen erhalten keinen impliziten Medienzugriff.

## 14. QR-Handoff

Der Desktop fordert einen Handoff an. Der Server erstellt:

- zufälligen Token mit mindestens 128 Bit Entropie;
- gehashten Token in der DB;
- Bindung an Attempt-Vorbereitung, Autor, Revision und Browser-Session;
- kurze TTL, zum Beispiel fünf Minuten;
- einmaligen Exchange.

Der QR-Code enthält ausschließlich die öffentliche HTTPS-URL mit Token. Nach
Exchange wird der Token verbraucht. Screenshots eines alten QR-Codes dürfen
keine neue Session öffnen.

Nach erfolgreichem Exchange erhält die autorisierte Mobile-Session zusätzlich
versioniertes öffentliches Wrapping-Material. Es enthält weder einen privaten
Wrapping-Schlüssel noch einen entschlüsselten Data Encryption Key und ist an
Provider-Key-ID, Attempt, Head-SHA und kurze TTL gebunden.

## 15. Mobile Preflight und Aufnahme

### Preflight

- HTTPS-/Secure-Context prüfen;
- Kamera und Mikrofon explizit anfordern;
- unterstützten MediaRecorder-Codec wählen;
- lokale Speicher- und Netzgrenzen erläutern;
- Fragenzahl, maximale Dauer, Zugriff und Löschfrist anzeigen;
- Testclip optional lokal prüfen und sofort verwerfen.

### Aufnahmezustand

- `ready → orientation → answering → transition → completed`;
- Frage `n/m` und Serverdeadline sichtbar;
- kein Pause-/Schnitt-/Re-record innerhalb desselben Attempts;
- kurze Verbindungsunterbrechung mit begrenztem Chunkpuffer überstehen;
- Tab-Hintergrund, Reload und Permission-Entzug als technische Ereignisse
  behandeln, nicht als Täuschung.

### Upload

- pro Attempt im Browser einen zufälligen Data Encryption Key mit Web Crypto
  erzeugen;
- jeden MediaRecorder-Chunk vor Verlassen des Browsers mit einem versionierten
  AEAD-Verfahren verschlüsseln;
- pro Key eine garantiert eindeutige Nonce verwenden, abgeleitet aus einem
  zufälligen Attempt-Präfix und monotonem Chunkindex;
- Protokollversion, Attempt-ID, Head-SHA, Chunkindex und Codec als Additional
  Authenticated Data binden;
- nur Ciphertext-Chunks fortlaufend nummerieren und hashen;
- Multipart-Upload attempt-gebunden signieren;
- den Data Encryption Key mit dem öffentlichen Material des konfigurierten
  Key-Wrapping-Providers verpacken und nur den gewrappten Wert übertragen;
- maximale Gesamtdauer und Größe serverseitig erzwingen;
- Finalisierung erst nach Prüfung eines authentifizierten Manifests mit
  Reihenfolge, Nonces, Ciphertext-Hashes und Größen;
- verwaiste Parts automatisch löschen.

Ein Klartextchunk darf nie in IndexedDB, Local Storage, Cache Storage oder
einem Multipart-Part persistiert werden. Kurzzeitiger Klartext im flüchtigen
MediaRecorder-/Web-Crypto-Speicher ist unvermeidbar und wird nach erfolgreicher
Verschlüsselung nicht weiter referenziert.

## 16. Verschlüsselung und Storage

### Kryptoverträge

```ts
interface ClientRecordingCrypto {
  createDataKey(): Promise<ClientDataKey>;
  encryptChunk(
    input: PlainChunk,
    context: ChunkCryptoContext,
  ): Promise<EncryptedChunk>;
  wrapDataKey(
    key: ClientDataKey,
    material: PublicWrappingMaterial,
  ): Promise<WrappedKey>;
  authenticateManifest(
    manifest: RecordingManifest,
    key: ClientDataKey,
  ): Promise<AuthenticatedManifest>;
}

interface EvidenceKeyService {
  getPublicWrappingMaterial(attemptId: string): Promise<PublicWrappingMaterial>;
  unwrapForJob(
    ref: WrappedKeyRef,
    purpose: DecryptionPurpose,
  ): Promise<PlaintextKeyHandle>;
  destroyMetadata(attemptId: string): Promise<void>;
}

interface EvidenceDecryptor {
  decryptForJob(
    ref: EvidenceRef,
    key: PlaintextKeyHandle,
    purpose: DecryptionPurpose,
  ): Promise<ReadableStream>;
}
```

### Regeln

- authentifizierte Verschlüsselung;
- zufälliger, im Smartphone-Browser erzeugter Key pro Attempt;
- eindeutige Nonce und attempt-/SHA-gebundene AAD pro Chunk;
- Key Wrapping mit versioniertem öffentlichen Provider-Material, logisch und
  in seinen Berechtigungen vom Objektstore getrennt;
- unverschlüsselte Aufnahmebytes und der ungewrappte Data Key verlassen den
  Mobile-Client nicht; übertragen werden Ciphertext, gewrappter Schlüssel und
  nicht geheime Protokollmetadaten;
- Bucket blockiert Public ACLs;
- Downloads nur über serverautorisierte kurzlebige Streams;
- Object Keys verraten weder Repository noch Nutzername;
- Rohvideo und Derivate tragen dieselbe Retentionklasse.

### Negativtests

- DB-Dump ohne privaten Wrapping-Schlüssel kann Video nicht entschlüsseln;
- Bucket-Credentials allein reichen nicht zur Wiedergabe;
- im Bucket existiert zu keinem Zeitpunkt ein Klartext-Part;
- wiederverwendete Nonce, vertauschter Chunk, falsche AAD oder manipuliertes
  Manifest werden abgelehnt;
- abgelaufener Reviewlink scheitert;
- Maintainer eines anderen Repositories erhält 403;
- Logs enthalten keinen Wrapped Key, Presigned URL oder Medieninhalt.

## 17. Medienworker

1. verschlüsseltes Objekt autorisiert streamen;
2. Hash, Größe, Dauer und Codec prüfen;
3. gegen Video-/Container-Bomben begrenzen;
4. Transkript mit Zeitmarken erstellen;
5. nur wenige Frames anhand dokumentierter Gründe auswählen;
6. Derivate verschlüsselt speichern;
7. temporäre Klartextdateien sofort löschen;
8. Evaluation enqueuen.

FFmpeg läuft ohne Netzwerk, mit CPU-, Speicher-, Zeit- und Dateigrenzen. Der
Worker erhält keine GitHub-Secrets.

## 18. Providerverträge

### Transkription

```ts
interface TranscriptionProvider {
  transcribe(input: AudioInput, ctx: ProviderContext): Promise<TranscriptV1>;
}
```

### Multimodales LLM

```ts
interface MultimodalJudgeProvider {
  evaluate(
    input: ProofEvaluationInputV1,
    ctx: ProviderContext,
  ): Promise<ProofEvaluationV1>;
}
```

`ProofEvaluationV1` ist ein striktes Zod-Schema. Unbekannte Felder, fehlende
Rubriken oder nicht belegte Patchreferenzen führen zu technischem Retry oder
Review. Auch ein vollständig valides `pass` ist im MVP nur eine Empfehlung für
Maintainers.

Betreiber konfigurieren den Provider. Die UI behauptet keine allgemeinen
No-Training- oder Retentionbedingungen. SlopProof dokumentiert stattdessen,
welche Daten technisch übergeben werden.

## 19. Prompt- und Injection-Grenzen

- Systeminstruktionen sind statisch und versioniert;
- PR-Text, Dateiinhalte und Antworten stehen in klar markierten Datenfeldern;
- Provider erhält keine Tools;
- keine URL aus dem Patch wird aufgerufen;
- keine Instruktion aus Codekommentaren ändert Rubrik oder Ausgabeformat;
- Ausgabe muss Schema und bekannte Question IDs erfüllen;
- Modellbegründung wird nicht ungeprüft öffentlich angezeigt.

Fixtures enthalten Prompt-Injection-Versuche in Dateinamen, Kommentaren,
README, Frageantwort und Transkript.

## 20. Entscheidungs-Policy

Der MVP unterstützt ausschließlich `maintainer_review`:

- jede technisch valide Evaluation landet in der Reviewqueue;
- der LLM-Befund ist assistierend und darf keinen Check abschließen;
- `pass`, `review_required` und `retry` sind Empfehlungen, keine
  Zustandsmutation;
- ausschließlich eine frisch autorisierte Maintaineraktion erzeugt die
  fachliche Entscheidung `pass` oder `retry`;
- Providerfehler führen zu technischem Retry oder Review, nie zu einem
  fachlichen Fail.

`calibrated_auto_pass` ist absichtlich kein gültiger MVP-Policywert. Seine
spätere Einführung benötigt Shadow-Daten, Dogfood, eine neue Policyversion und
eine separat freigegebene Kalibrierung für Provider, Modell, Prompt, Schema,
Planner und Rubrik.

## 21. Maintainer-Review

Die Oberfläche braucht:

- Queue nach Repository und Alter;
- SHA- und Invalidierungsstatus;
- Fragen, Rubrik, Video, Transkript und Frames synchron;
- klar getrennten Modellbefund;
- `pass` und `retry` mit Reason Code;
- Warnung bei inzwischen geändertem Head-SHA;
- sichtbare Löschdeadline.

Vor Wiedergabe wird die Berechtigung frisch geprüft. Jeder Medienzugriff und
jede Entscheidung erzeugt ein Audit Event.

## 22. Retention

### Standard

- 24 Stunden ab Abschluss;
- frühere Löschung nach bestätigtem Maintainer-Pass möglich;
- begrenzte Verlängerung bei offenem Review;
- Storage-Lifecycle etwas später als Applikationsdeadline als Backstop.

### Löschreihenfolge

1. Reviewlinks widerrufen;
2. Original und Derivate löschen;
3. temporäre Providerreferenzen schließen;
4. verschlüsselte Payloads minimieren;
5. Key-Metadaten zerstören;
6. Audit Event ohne Inhalt schreiben.

Retention-Tests verwenden eine kontrollierbare Uhr und prüfen Wiederholung,
Teilversagen und verwaiste Multipart-Uploads.

## 23. Weboberflächen

### Landingpage

Die visuelle Referenz ist `slopproof-brand-ui-concept-v3.html`. Produktcopy und
Grenzen werden aus `04-brand-marketing-interface.md` übernommen.

### Contributor Desktop

- Checkstatus;
- Practice/Proof als zwei gleich sichtbare Wege, `Practice` klar als optional
  und `Prove` klar als direkt startbar markiert;
- Practice-Diffkarte;
- QR-Handoff;
- aktueller SHA und Invalidierung verständlich, aber nicht als Marketingclaim.

### Contributor Mobile

- Preflight;
- Datenschutzhinweis;
- Aufnahme mit `Frage n/m`;
- Uploadfortschritt;
- `Reviewing your explanation` ohne Prozentwert.

### Maintainer

- evidenzzentrierte Arbeitsoberfläche;
- keine öffentliche Galerie;
- keine erfundene Verständniszahl;
- klarer Zugriffspfad und sichtbare Retention.

### Accessibility

- WCAG-AA-Kontrast;
- Fokuszustände und Tastaturbedienung;
- Untertitel/Transkript im Review;
- Reduced Motion;
- privater Accommodation-Pfad, dessen konkrete alternative Nachweise erst nach
  separater Produkt- und Threat-Model-Entscheidung aktiviert werden.

## 24. Securitybaseline

- CSP, HSTS, sichere Cookies, CSRF-Schutz;
- Rate Limits für Handoff, Start, Upload und Review;
- Content-Length- und Codecgrenzen;
- SSRF-sichere Provideradapter;
- keine Secrets im Clientbundle;
- Dependency- und Container-Scanning;
- getrennte Rollen für Web, Worker, Storage und privates Wrapping-
  Schlüsselmaterial;
- Backupstrategie ohne entschlüsselbare Medienkopien;
- dokumentierter Incident-Pfad für Evidence Access und Retentionfehler.

## 25. Tests

### Unit

- Zustandsmaschine;
- Fragenbudget;
- Policy;
- Timer und Ablauf;
- Tokenverbrauch;
- Nonce-Eindeutigkeit, AAD und Manifestauthentifizierung der
  Clientverschlüsselung;
- Provider-Schemas;
- Redaction.

### Integration mit Testcontainers

- DB-Constraints und Migrationen;
- `pg-boss`-Idempotenz;
- Contract-Tests des S3-kompatiblen Storage-Adapters mit ausschließlich
  verschlüsselten Parts und privaten ACLs; ein Testprofil darf einen beliebigen
  austauschbaren S3-kompatiblen Referenzdienst verwenden;
- lokaler Key-Wrapping-Adapter und optionaler KMS-Adapter;
- Löschjobs;
- Webhook-Dedupe.

### Contract

- GitHub-Payloadfixtures;
- Transkriptionsadapter;
- multimodale LLM-Ausgabe;
- Storage-/Key-Wrapping-Fehlerklassen.

### Playwright

- Practice Desktop;
- QR-Handoff mit Testtoken;
- mobile Preflight-/Fake-MediaRecorder-Journey;
- mehrere Fragen in einem Take;
- Push-Invalidierung;
- Maintainer-Review;
- 390 px ohne horizontalen Overflow.

### Security-Negativtests

- falsche Webhooksignatur;
- wiederverwendeter Handoff-Token;
- fremder Autor startet Attempt;
- fremder Maintainer öffnet Video;
- alter SHA erhält keinen Pass;
- manipuliertes Chunkmanifest;
- Prompt Injection;
- Key-Wrapping-/Provider-/Löschfehler.

## 26. CI

Jeder Pull Request führt aus:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm audit:boundaries
```

Playwright und Container-Smokes können in einem separaten Job laufen. Fixtures
verwenden ausschließlich synthetische Medien.

## 27. Lokale Entwicklung

Docker Compose startet:

- PostgreSQL;
- einen S3-kompatiblen Referenz-Objektspeicher; das aktuelle Defaultprofil nutzt
  VersityGW hinter dem generischen Storage-Port;
- lokales Key Wrapping aus getrennten, gemounteten Testschlüsseln ohne
  separaten KMS-Prozess;
- Web;
- Worker;
- Fake-GitHub- und Fake-Provideradapter.

Der lokale Golden Path darf ohne Internet funktionieren. Ein Seed erzeugt drei
PRs: klein, mittel und risikoreich. Damit werden Fragenbudget, Practice,
Mehrfragenaufnahme, Policypfad und Retention reproduzierbar demonstriert.

Weder MinIO noch der lokale Key-Wrapping-Adapter dürfen in Domaincode oder
persistierte Datenmodelle einsickern. Ein Wechsel des S3-kompatiblen Dienstes
oder zu einem externen KMS ändert nur Konfiguration und Provideradapter.

## 28. Deployment

Erster produktionsnaher Aufbau:

- ein Webcontainer;
- ein Workercontainer;
- PostgreSQL, selbst gehostet oder verwaltet;
- privater Objektspeicher über den S3-kompatiblen Adapter, selbst gehostet oder
  extern;
- lokaler Key-Wrapping-Provider mit privatem Worker-Secret oder optional ein
  externer KMS-Adapter;
- HTTPS und feste öffentliche App-URL.

Web und Worker erhalten getrennte Credentials. Nur der Worker darf Evidence
entschlüsseln; das Web fordert kurzlebige autorisierte Streams an.

## 29. Observability

### Logs

Erlaubt:

- Request-/Job-ID;
- Attempt-, Revision- und Repository-ID;
- Zustände, Dauer, Bytezahl, Fehlerklasse.

Verboten:

- Tokens und Secrets;
- Presigned URLs;
- Fragenantworten und Transkript;
- Frames und Videos;
- Schlüsselmaterial;
- vollständige Providerpayloads.

### Metriken

- Webhook- und Checklatenz;
- Planungsdauer und Fragenbudgetverteilung;
- Handoff-/Aufnahme-/Uploaderfolg;
- Providerfehler;
- Review- und Overridequote;
- Retention-Lag;
- unautorisierte Access-Versuche.

## 30. Phasengates

### Gate A — Workspace

- Monorepo startet;
- Lint, Typecheck, Unit Tests und Build grün;
- Dependencygrenzen getestet.

### Gate B — Domain und DB

- Zustandsmaschine vollständig;
- Migrationen und Constraints grün;
- kontrollierbare Zeit und IDs.

### Gate C — Fake GitHub

- PR-Event erzeugt Revision und Check;
- Duplikat ist no-op;
- neuer SHA invalidiert alten Attempt.

### Gate D — Analyse, Practice, Proof-Plan

- drei Seed-PRs erzeugen begründete verschiedene Fragenbudgets;
- Practice zeigt keine Proof-Fragen;
- Mega-PR kann Split empfehlen.

### Gate E — Handoff und Aufnahme

- Token ist einmalig;
- Mobile-Flow zeichnet mehrere Fragen in einem Take auf;
- technischer Abbruch endet nachvollziehbar.

### Gate F — Evidence Security

- clientseitige Chunkverschlüsselung, direkter Multipart-Upload und Key
  Wrapping funktionieren;
- kein Klartext-Part erreicht den konfigurierten Objektspeicher;
- DB oder Bucket allein entschlüsseln nichts;
- Access Audit und Retentiontests grün.

### Gate G — Provider und Policy

- Fake-Transkription und Fake-LLM liefern versionierte Schemas;
- Injection-Fixtures bleiben Daten;
- jede Providerempfehlung endet in `maintainer_review` und kann den Check nicht
  selbst freigeben.

### Gate H — Maintainer und Check

- Reviewzugriff ist repositorygebunden;
- Entscheidung aktualisiert nur den aktuellen SHA;
- öffentliche Ausgabe enthält keine Evidenz.

### Gate I — End-to-End

- lokaler Golden Path läuft vollständig;
- Desktop und 390-px-Mobile sind ohne JS-Fehler und Overflow;
- Retention löscht Original, Derivate und Key-Metadaten;
- `IMPLEMENTATION_STATUS.md` ist aktuell.

## 31. Abnahmeliste

- [ ] Practice ist optional und vom Proof-Datensatz getrennt.
- [ ] Proof lässt sich ohne Practice-Session direkt aus dem Check starten.
- [ ] Fragenbudget ist risikoadaptiv und begründet.
- [ ] Mehrere Fragen laufen in einem ununterbrochenen Take.
- [ ] Attempt ist an Autor, PR und Head-SHA gebunden.
- [ ] Push invalidiert laufenden und bestandenen Proof.
- [ ] Jeder Aufnahmechunk wird im Smartphone-Browser vor dem direkten Upload
      attempt-spezifisch verschlüsselt.
- [ ] Im Bucket oder persistenten Browserstorage entsteht niemals
      Klartextvideo.
- [ ] Nur berechtigte Maintainer können Evidence streamen.
- [ ] Multimodales LLM vergleicht Patch, Rubrik, Transkript und Frames.
- [ ] Providerfehler erzeugt keinen fachlichen Fail.
- [ ] Nur eine Maintainerentscheidung kann den Check freigeben.
- [ ] Öffentlicher Check enthält keine private Evidenz.
- [ ] PR-Code wird nicht ausgeführt.
- [ ] 24h-Retention und Lifecycle-Backstop funktionieren.
- [ ] Logs und Telemetrie sind evidence-frei.
- [ ] Fake-GitHub-/Fake-Provider-Flow läuft offline.
- [ ] Alle Tests, Typecheck, Lint und Build sind grün.

## 32. Übergabeprompt für den Coding-Agenten

> Implementiere den SlopProof-Live-Video-MVP nach
> `02-mvp-implementation-guide.md`. Lies davor `README.md`,
> `01-architektur-und-live-challenge.md`,
> `04-brand-marketing-interface.md` und
> `06-live-video-mvp-and-brand-v3.md` vollständig. Arbeite die Phasengates in
> Reihenfolge ab und pflege `IMPLEMENTATION_STATUS.md`. Verwende zunächst nur
> lokale Fake-Adapter und synthetische Medien. Lege keine externe GitHub App,
> Cloudressource oder kostenpflichtige Providerkonfiguration an. Weiche nicht
> auf Papier, Live-Text, Audio-only oder PR-Codeausführung aus. Stoppe bei einer
> ungeklärten Sicherheits-, Provider- oder Produktgrenze und dokumentiere den
> konkreten Blocker.
