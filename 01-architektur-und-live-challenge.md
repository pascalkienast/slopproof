# SlopProof: Systemarchitektur und Live-Video-Protokoll

Stand: 2026-08-12  
Status: kanonischer Architekturvertrag des implementierten lokalen MVP

## 1. Produktgrenze

SlopProof setzt einen Required Check auf einen Pull Request. Der Contributor
kann den Patch zunächst in `Practice your understanding` durcharbeiten. Für
`Prove your understanding` beantwortet er ein begrenztes, risikoadaptives
Fragenset in einer ununterbrochenen Videoaufnahme. Beide Wege sind direkt
erreichbar; ein Proof-Start setzt weder eine Practice-Session noch einen
Practice-Fortschritt voraus.

SlopProof prüft damit eine beobachtbare Leistung: Kann der Contributor
Verhalten, Risiken und Tests des konkreten Patches erklären? Das System leitet
daraus weder die Herkunft des Codes noch die Identität oder Integrität einer
Person ab.

## 2. Unverhandelbare Invarianten

### Patchbindung

- Ein Versuch gehört zu `installation`, `repository`, `pull_request`,
  `head_sha` und `github_user_id`.
- Ein Push auf den Pull Request invalidiert offene, laufende und bestandene
  Versuche für den alten Head-SHA.
- Nur die GitHub App darf den Check für einen SHA auf `success` setzen.

### Serverautorität

- Der Server bestimmt Start, Ablauf, Fragenreihenfolge und Statuswechsel.
- Handoff-Token, Uploadpfade und Medienreferenzen sind kurzlebig,
  attempt-gebunden und nicht wiederverwendbar.
- Der Client darf weder Timer noch Fragebudget oder Ergebnis festlegen.

### Getrennte Lern- und Proof-Pfade

- Practice darf Lernziele, Risikostellen und Übungsfragen zeigen.
- Practice und Proof verwenden getrennte Seeds und Fragepools.
- Practice-Aktivität beeinflusst das Proof-Urteil nicht und wird nicht als
  Verhaltenssignal ausgewertet.
- Practice ist optional. Weder Backend noch UI dürfen Proof von einer
  abgeschlossenen Practice-Session abhängig machen.

### Private Evidenz

- Video, Audio, Transkript, Frames und Modellbegründung erscheinen nie im
  öffentlichen Check oder PR-Kommentar.
- Das Smartphone verschlüsselt jeden Aufnahmechunk authentifiziert, bevor er
  das Gerät verlässt. Der direkte Upload und sämtliche Multipart-Parts im
  Objektspeicher enthalten ausschließlich Ciphertext.
- Ein vollständiges oder partielles Klartextvideo darf weder im Bucket noch in
  persistentem Browserstorage entstehen. Klartext existiert nur kurzzeitig im
  flüchtigen Browser- beziehungsweise autorisierten Worker-Speicher.
- Reviewzugriff ist berechtigungsgeprüft, kurzlebig und auditierbar.
- Retention wird aktiv durch Jobs und zusätzlich durch eine Storage-Lifecycle-
  Regel durchgesetzt.

### Begrenzte Automatisierung

- Ein multimodales LLM erhält nur Patchausschnitte, Rubrik und eine
  jobgebundene Medienreferenz beziehungsweise abgeleitete Daten.
- PR-Inhalte gelten als untrusted data und dürfen keine Systeminstruktionen,
  Tools oder Providerkonfiguration überschreiben.
- Der Modellbefund ist im MVP ausschließlich assistierend. Jeder fachlich
  vollständige Proof geht an Maintainer-Review.
- Nur ein berechtigter Maintainer entscheidet `pass` oder `retry` und darf
  dadurch den Check für den aktuellen SHA freigeben.
- Kalibriertes Auto-Pass gehört in einen späteren Ausbau nach Shadow-Betrieb,
  Dogfood und gesonderter Freigabe.

### Kein PR-Code im MVP

SlopProof liest begrenzte Diff- und Repositorydaten, führt aber weder Build,
Tests noch Skripte aus dem Pull Request aus. Fork-Inhalte bleiben feindliche
Eingabe.

## 3. Systemübersicht

```text
GitHub App
  └─ Webhook-Ingestion
       ├─ Delivery-Deduplizierung
       ├─ PR-Revision + Head-SHA
       └─ Required Check: understanding required
                         │
                         ▼
                  Diff-/Risk-Analyzer
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     Practice-Deep-Dive       Proof-Planer
     Lernziele/Übungen        Rubriken/Fragenbudget
                                    │
                                    ▼
                            QR-/Mobile-Handoff
                                    │
                                    ▼
                         ununterbrochene Aufnahme
                                    │
                                    ▼
                   verschlüsselter privater Speicher
                                    │
                                    ▼
               Transkript + begrenzte Frame-Extraktion
                                    │
                                    ▼
                          multimodale LLM-Auswertung
                                    │
                                    ▼
                    assistierender strukturierter Befund
                                    │
                                    ▼
                           Maintainer-Review
                                    │
                                    ▼
                         SHA-gebundener Check
```

## 4. Komponenten

### `apps/web`

- GitHub-OAuth beziehungsweise App-Login;
- Practice-Oberfläche;
- Desktop-Handoff und QR-Code;
- mobile Preflight-, Aufnahme- und Uploadoberfläche;
- Maintainer-Review;
- API-Transport und serverseitige Berechtigungsprüfungen.

Die Fachlogik für Zustände, Fragenbudget, Verschlüsselung und Policy liegt
nicht in React-Komponenten oder Route Handlern.

### `apps/worker`

- Diffaufbereitung und Risikoanalyse;
- Practice- und Proof-Planung;
- Medienvalidierung;
- Transkription und begrenzte Frame-Auswahl;
- multimodale Bewertung;
- Check-Reconciliation;
- Retention und Löschjobs.

### Domain-Pakete

- `domain`: Aggregate, Zustandsmaschine, Invarianten;
- `policy`: Repositorykonfiguration und Entscheidungsregeln;
- `github`: Octokit, Webhooks, Checks, Installation Tokens;
- `media`: Upload, Verschlüsselung, Normalisierung, Löschung;
- `providers`: Verträge für Transkription und multimodale Modelle;
- `db`: Drizzle-Schema und Transaktionen;
- `observability`: strukturierte Logs, Metriken und Audit Events.

### Infrastruktur

- PostgreSQL als System of Record;
- `pg-boss` für Jobs in derselben Datenbank;
- privater Objektspeicher hinter einem kleinen Storage-Port; der erste Adapter
  spricht S3-kompatible APIs;
- austauschbarer Key-Wrapping-Provider für per-attempt Data Keys;
- GitHub App mit minimalen Rechten;
- genau ein Web-Prozess und mindestens ein Worker-Prozess.

Redis, Kubernetes, Microservices und ein zweites Backend sind für den MVP nicht
erforderlich.

MinIO ist keine Architekturvoraussetzung, sondern nur eine mögliche
S3-kompatible Implementierung des Storage-Ports. Das aktuelle lokale
Docker-Compose-Profil verwendet VersityGW als austauschbare Referenz. Ebenso ist
kein separater KMS-Dienst vorgeschrieben: Das einfache Self-Host-Profil darf ein
lokales asymmetrisches Schlüsselpaar verwenden. Das öffentliche Wrapping-
Material darf das Web ausliefern; der private Schlüssel wird ausschließlich
dem Worker als read-only Secret bereitgestellt. Externe KMS-Adapter bleiben
eine optionale Betriebsvariante.

## 5. GitHub-App-Fluss

### Berechtigungen

- Pull requests: read;
- Contents: read;
- Checks: write;
- Metadata: read.

### Relevante Events

- `pull_request.opened`;
- `pull_request.reopened`;
- `pull_request.ready_for_review`;
- `pull_request.synchronize`;
- `pull_request.closed`;
- `installation` und `installation_repositories`.

### Ingestion

1. Raw Body vor dem Parsen mit dem Webhook-Secret prüfen.
2. Delivery-ID atomar deduplizieren.
3. Payload mit Zod validieren.
4. Installation, Repository, PR und Revision upserten.
5. Bei neuem SHA alte Attempts und Check-Ergebnisse invalidieren.
6. Pending Check für den neuen SHA anlegen oder reparieren.
7. Analysejob idempotent enqueuen.

Ein Webhook antwortet nach dauerhafter Annahme. Diffanalyse, Medienverarbeitung
und GitHub-Reconciliation laufen im Worker.

## 6. Practice-Protokoll

Practice ist optional und desktopfreundlich. Der Worker erzeugt aus dem Diff:

- eine Karte veränderter Komponenten;
- Verhalten vor und nach dem Patch;
- Daten-, Fehler- und Rollbackpfade;
- Schnittstellen und Berechtigungsänderungen;
- vorhandene und fehlende Tests;
- Übungsfragen mit erklärbaren Lernzielen.

Der Coach darf Antworten kommentieren, speichert sie aber nicht als
Proof-Evidenz. Die Oberfläche sagt klar, dass Practice keine Garantie für die
späteren Fragen ist.

Der Contributor kann vom Check und von jeder Practice-Ansicht direkt zu Proof
wechseln. Ein fehlender `practice_sessions`-Datensatz ist ein normaler Zustand,
kein Fehler- oder Risikosignal.

## 7. Proof-Planung

Der Worker erstellt vor dem Start einen unveränderlichen `proof_plan`. Dieser
enthält:

- `plan_version`;
- Risikosignale und begründete Gewichtung;
- Fragenbudget;
- geordnete Fragenkandidaten;
- pro Frage Diff-Anker und Rubrik;
- Zeitbudget;
- Hash des Planinhalts.

### Risikoadaptives Fragenbudget

Rohes LOC-Volumen ist nur ein Signal. Höher gewichtet werden:

- Zahl unabhängiger Verhaltensänderungen;
- neue oder veränderte öffentliche Schnittstellen;
- Authentifizierung und Berechtigungen;
- Datenmigrationen und Persistenz;
- Nebenläufigkeit und verteilter Zustand;
- Fehler-, Retry- und Rollbackpfade;
- sicherheitsrelevante Grenzen;
- Testabdeckung der Risiken.

Generated Files, Snapshots und Lockfiles blähen das Budget nicht auf.

Empfohlene Obergrenzen:

- lokal begrenzter Patch: meist 1 Frage;
- mittlerer Patch: meist 2–3 Fragen;
- großer oder risikoreicher Patch: meist 4–5 Fragen;
- nicht sinnvoll prüfbarer Mega-PR: Split-Empfehlung statt endloser Challenge.

Der Planer muss jede Frage einem anderen relevanten Risiko zuordnen. Fünf
Varianten derselben Detailfrage sind kein breiterer Nachweis.

## 8. Mobile-Handoff und Aufnahme

### Handoff

1. Der Desktop erzeugt einen kurzlebigen, einmal nutzbaren Handoff-Token.
2. Der QR-Code enthält keine GitHub-Secrets und keine Fragen.
3. Das Smartphone tauscht den Token gegen eine opake Session aus.
4. Der Server prüft Autor, Revision, Ablauf und bestehenden Attempt.

### Preflight

Vor dem Start werden geprüft:

- Kamera- und Mikrofonberechtigung;
- unterstützter Codec und maximale Bitrate;
- ausreichende Netz- und lokale Pufferfähigkeit;
- sichtbares Kamerabild;
- Fragensatz, Gesamtdauer, Datenzugriff und Löschfrist als klare Vorabinfo.

Der Preflight ist keine biometrische Identifikation. Face-in-frame darf als
lokales UI-Signal dienen; es wird nicht als Identitätsmerkmal gespeichert.

### Starttransaktion

Die Transaktion:

1. sperrt Revision und offenen Attempt;
2. validiert den aktuellen Head-SHA erneut gegen GitHub;
3. prüft, dass der Proof-Plan vollständig ist;
4. erzeugt Attempt, Nonce, Serverstart und Ablauf;
5. bindet den Plan unveränderlich an den Attempt;
6. gibt erst dann die erste Frage frei.

### Aufnahme

- eine zusammenhängende Session;
- kein Pause-, Schnitt- oder Re-record-Button innerhalb des Attempts;
- Fragen erscheinen einzeln;
- pro Frage 15 Sekunden Orientierung und bis zu 90 Sekunden Antwort;
- lokaler, begrenzter Puffer bei kurzen Netzunterbrechungen;
- Fortschritt zeigt `Frage n/m`, nicht Bewertung oder Schwierigkeitslabel;
- technischer Abbruch erzeugt einen reproduzierbaren Retry-Grund.

## 9. Medien- und Schlüsselmodell

### Upload

- direkter Multipart-Upload vom Smartphone in privaten Objektspeicher;
- jeder MediaRecorder-Chunk wird im Browser vor dem Upload authentifiziert
  verschlüsselt;
- ausschließlich Ciphertext wird als Multipart-Part übertragen und
  persistiert;
- Objektschlüssel ist zufällig und attempt-gebunden;
- Chunkreihenfolge, Ciphertext-Hash, Größe, Gesamtdauer und Codec werden über
  ein versioniertes Abschlussmanifest geprüft;
- kein öffentlicher Bucket, kein dauerhafter Presigned-Downloadlink.

### Verschlüsselung

1. Das Smartphone erzeugt für jeden Attempt mit Web Crypto einen zufälligen
   Data Encryption Key.
2. Jeder Chunk wird mit einem versionierten AEAD-Verfahren verschlüsselt. Pro
   Key muss jede Nonce eindeutig sein; die Nonceableitung kombiniert einen
   zufälligen Attempt-Präfix mit dem monotonen Chunkindex.
3. Additional Authenticated Data bindet mindestens Protokollversion,
   Attempt-ID, Head-SHA, Chunkindex und Codec an den Ciphertext.
4. Der Browser wrappt den Data Key mit serverseitig bereitgestelltem,
   versioniertem öffentlichen Material des konfigurierten Key-Wrapping-
   Providers. Nur der gewrappte Schlüssel wird an SlopProof übertragen und
   dauerhaft gespeichert.
5. Ein authentifiziertes Abschlussmanifest bindet Reihenfolge, Nonces,
   Ciphertext-Hashes und Größen aller Parts. Manipulierte, fehlende oder
   doppelte Chunks verhindern die Finalisierung.
6. Datenbank und Objektspeicher allein reichen nicht zur Wiedergabe.
7. Entschlüsselung erfolgt nur für einen autorisierten, protokollierten
   Workerjob oder einen kurzlebigen Maintainer-Stream.

Klartextchunks existieren technisch kurz im flüchtigen Speicher des
Smartphone-Browsers und bei autorisierter Verarbeitung im Worker. Sie dürfen
nie in IndexedDB, Local Storage, Cache Storage, temporären Multipart-Objekten
oder unverschlüsselten Workerdateien persistiert werden.

### Retention

- Standard: Original und Derivate spätestens 24 Stunden nach Abschluss löschen;
- nach klarem Pass darf früher gelöscht werden;
- ein offener Maintainer-Review kann eine begrenzte, sichtbare Verlängerung
  erhalten;
- Lifecycle-Regel im Storage bildet den Backstop;
- Löschung ist idempotent und erzeugt ein Audit Event ohne Medieninhalt.

## 10. Multimodale Bewertung

Der Begriff `Judge` bezeichnet einen versionierten Providervertrag für ein
multimodales LLM. Das Modell vergleicht:

- Fragen und Rubriken;
- relevante Diff-Anker;
- Transkript mit Zeitmarken;
- ausgewählte, begründete Frames;
- technische Vollständigkeit des Takes;
- konkrete Patchreferenzen, Lücken und Widersprüche.

Das Modell erhält keine GitHub-Tokens, keine Datenbankverbindung, keine Tools
und keinen Zugriff auf andere Attempts.

```ts
type ProofEvaluation = {
  recommendation: "pass" | "review_required" | "retry";
  questionResults: Array<{
    questionId: string;
    result: "met" | "unclear" | "missing";
    evidence: string;
    patchReferences: string[];
  }>;
  contradictions: string[];
  technicalIssues: string[];
  explanation: string;
  schemaVersion: string;
  modelRef: string;
};
```

Im MVP erzeugt die Evaluation nur einen strukturierten Befund für das
Maintainer-Review. Weder `pass` noch `retry` aus einer Providerantwort verändern
den GitHub Check automatisch. Ein späteres kalibriertes Auto-Pass benötigt
einen eigenen Release- und Kalibrierungsgate.

`retry` ist für klare Verständnislücken oder technische Defekte reserviert.
Unklare Evidenz wird `review_required`.

## 11. Maintainer-Review

Die Reviewoberfläche zeigt:

- PR, Autor und exakten Head-SHA;
- Fragen und Rubriken;
- Video mit kurzlebiger Berechtigung;
- synchronisiertes Transkript und ausgewählte Frames;
- Modellbefund mit Belegen und Unsicherheiten;
- `pass` und `retry` als explizite Aktionen.

Jede Wiedergabe und Entscheidung wird mit Maintainer-ID, Attempt-ID und Zeit
protokolliert. Support oder Organisationsadmins erhalten keinen pauschalen
Videozugriff.

## 12. Zustandsmaschine

```text
preparing
  ├─ ready
  └─ invalidated

ready
  ├─ active
  └─ invalidated

active
  ├─ uploading
  ├─ expired
  ├─ technical_retry
  └─ invalidated

uploading
  ├─ processing
  └─ technical_retry

processing
  ├─ review_required
  └─ technical_retry

review_required
  ├─ passed
  ├─ retry_required
  └─ invalidated
```

Terminale Zustände werden nicht überschrieben. Korrekturen laufen über ein
neues Decision Event oder einen neuen Attempt.

## 13. Kerndatenmodell

- `installations`
- `repositories`
- `repository_policies`
- `pull_requests`
- `pull_request_revisions`
- `webhook_deliveries`
- `analysis_snapshots`
- `practice_sessions`
- `proof_plans`
- `proof_questions`
- `attempts`
- `recording_objects`
- `transcripts`
- `frame_selections`
- `evaluations`
- `review_decisions`
- `check_runs`
- `audit_events`
- `deletion_jobs`

Wichtige Constraints:

- Delivery-ID global eindeutig;
- Revision eindeutig pro Repository, PR und Head-SHA;
- höchstens ein aktiver Attempt pro Autor und Revision;
- Proof-Plan nach Attemptstart unveränderlich;
- Evaluation eindeutig pro Attempt, Schema-, Prompt- und Modellversion;
- Reviewentscheidung append-only;
- Object Key und gewrappter Data Key eindeutig pro Recording.

## 14. Repository-Policy

```yaml
version: 1

practice:
  enabled: true

proof:
  mode: live_video
  question_budget:
    min: 1
    max: 5
  orientation_seconds: 15
  answer_seconds: 90
  oversized_pr: recommend_split

decision:
  mode: maintainer_review
  review_on_uncertainty: true

evidence:
  retention_hours: 24
  delete_early_after_pass: true

accessibility:
  private_accommodation_path: true
```

Konfiguration wird strikt validiert. `calibrated_auto_pass` ist im MVP kein
gültiger Wert. Die spätere Einführung benötigt eine neue Policyversion,
Shadow-Daten und eine separat freigegebene Kalibrierung für Provider, Modell,
Prompt, Planner, Rubrik und Schema.

## 15. Fehler- und Repair-Pfade

- Webhook-Duplikat: no-op mit erfolgreicher Bestätigung;
- verpasster Webhook: periodischer GitHub-Reconciler;
- Check fehlt: idempotent neu anlegen;
- GitHub temporär nicht erreichbar: Retry mit Backoff;
- Upload abgebrochen: Attempt bleibt begrenzt resumierbar oder endet technisch;
- Transkription/LLM fehlgeschlagen: technischer Retry, nie fachlicher Fail;
- Head-SHA ändert sich während Aufnahme: Attempt invalidieren, Medium löschen;
- Löschjob fehlgeschlagen: Retry plus Lifecycle-Backstop und Alarm;
- Key-Wrapping-Provider oder privates Schlüsselmaterial nicht verfügbar: keine
  Entschlüsselung, Review bleibt gesperrt.

## 16. Observability ohne Evidenzleck

Logs enthalten IDs, Zustände, Dauer und Fehlerklassen. Sie enthalten keine
Frageantworten, Transkripte, Bildframes, Presigned URLs, Tokens oder Schlüssel.

Zentrale Metriken:

- Zeit von PR-Event bis Check;
- Practice-Nutzung ohne Inhaltsprotokollierung;
- Start-, Upload- und Processing-Erfolgsrate;
- technische Retry-Rate;
- Reviewquote und Overridequote;
- Zeit bis Maintainerentscheidung;
- Retention-Lag und Löschfehler;
- GitHub- und Providerlatenz.

## 17. Abnahme des vertikalen Schnitts

Der Architekturfluss gilt als bewiesen, wenn ein lokaler Fake-GitHub-Flow und
ein kontrollierter Dogfood-PR zeigen:

1. neuer SHA erzeugt einen neuen Pending Check;
2. Practice und Proof verwenden getrennte Fragepools;
3. Fragenbudget reagiert nachvollziehbar auf Patchrisiken;
4. QR-Handoff und Aufnahme funktionieren mobil;
5. ein Push invalidiert den Attempt sofort;
6. Video ist ohne autorisierte Entschlüsselung unlesbar;
7. LLM-Auswertung ist strukturiert und reproduzierbar versioniert;
8. jeder Proof endet unabhängig vom Modellbefund im Maintainer-Review;
9. öffentliche GitHub-Daten enthalten keine Evidenz;
10. alle Medien und Derivate werden fristgerecht gelöscht.

Der ausführbare Bauplan steht in
[[02-mvp-implementation-guide|02-mvp-implementation-guide.md]].
