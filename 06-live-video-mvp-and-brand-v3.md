# SlopProof V3: Practice → Live Video Proof

Stand: 2026-08-11  
Status: kanonische Produkt- und Markenentscheidung

## 1. Der Produktmoment

SlopProof wird durch einen Ablauf verständlich:

1. Ein Pull Request erhält den Check
   `SlopProof / understanding required`.
2. Der Contributor wählt direkt zwischen optionalem `Practice your
   understanding` und verpflichtendem `Prove your understanding`.
3. Practice hilft bei Bedarf, Verhalten, Risiken, Abhängigkeiten und Tests des
   Patches durchzugehen; erfahrene Contributors und kleine PRs können es
   überspringen.
4. `Prove your understanding` zeigt einen QR-Code.
5. Auf dem Smartphone startet nach einem Preflight eine ununterbrochene
   Videoaufnahme.
6. Ein risikoadaptives Set patchspezifischer Fragen erscheint nacheinander.
7. Ein multimodales LLM kann Transkript, ausgewählte Frames,
   Fragenzeitmarken, technische Vollständigkeit, Patchkontext und Rubrik
   vergleichen.
8. Der Modellbefund ist assistierend. Im MVP entscheidet ausschließlich ein
   berechtigter Maintainer `pass` oder `retry`.

> **Prove you know what you ship.**

## 2. Practice macht den Ablauf fair

Contributors beginnen mit unterschiedlicher Erfahrung und unterschiedlichem
Kontext. Practice gibt allen die Gelegenheit, den Patch vor dem Proof zu
verstehen.

Der Lernraum enthält:

- eine Karte veränderter Bereiche;
- Verhalten vor und nach dem Patch;
- Risiko-, Fehler- und Rollbackpfade;
- Abhängigkeiten und Schnittstellen;
- vorhandene und fehlende Tests;
- Übungsfragen mit konkretem Feedback;
- einen sichtbaren Übergang zu `I'm ready to prove it`.

Practice ist optional und darf Proof weder technisch noch in der UI sperren.
Erfahrene Contributors und Contributors mit kleinen, klaren Patches können
direkt zu Proof wechseln. Practice beeinflusst die Proof-Bewertung nicht. Freie
Antworten aus Practice werden nicht als Evidenz an den Judge oder Maintainer
weitergegeben.

Practice und Proof verwenden getrennte Seeds und Fragepools. Lernziele dürfen
transparent sein; die konkreten Live-Fragen bleiben bis zum Start unbekannt.

## 3. Proof ist ein Live-Take mit mehreren möglichen Fragen

`One take` bedeutet eine zusammenhängende Aufnahme, nicht genau eine Frage.

Der Proof-Planer legt vor dem Start ein begrenztes Fragenbudget fest:

- kleiner, lokal begrenzter Patch: meist 1 Frage;
- mittlerer Patch: meist 2–3 Fragen;
- großer oder risikoreicher Patch: meist 4–5 Fragen;
- unprüfbarer Mega-PR: Empfehlung zum Aufteilen.

Semantische Breite zählt stärker als rohe LOC. Höheres Gewicht erhalten neue
Schnittstellen, Migrationen, Berechtigungen, Nebenläufigkeit, Rollbackpfade und
Testlücken. Lockfiles, Snapshots und generierte Dateien blähen das Budget nicht
auf.

Während der Aufnahme:

- zeigt die UI `QUESTION n/m`;
- erscheint immer nur die aktuelle Frage;
- gibt es 15 Sekunden Orientierung;
- stehen bis zu 90 Sekunden Antwortzeit pro Frage zur Verfügung;
- gibt es keinen Pause-, Schnitt- oder Re-record-Button innerhalb des Attempts;
- bleibt die Session an Autor, Repository, PR und Head-SHA gebunden.

Ein neuer Push invalidiert den laufenden oder bestandenen Proof.

## 4. GitHub-Check und Gerätewechsel

Der Check bietet zwei gleich sichtbare Wege:

```text
SlopProof / understanding required

Prepare
Practice your understanding  → guided patch deep dive

Required
Prove your understanding     → QR code → live video
```

### Desktop

- Practice nutzt den Platz für Diff, Patchkarte und Coach;
- Proof zeigt Fragenanzahl, maximale Dauer, Datenzugriff und Löschfrist;
- der QR-Code enthält einen kurzlebigen, einmaligen Handoff-Token;
- `Continue on this device` bleibt als Kamera-Fallback möglich.

### Smartphone

- der Token übernimmt die Session ohne erneutes GitHub-Passwort;
- Preflight prüft Kamera, Mikrofon, Codec und Uploadfähigkeit;
- vor dem Start bleiben die Fragen verborgen;
- nach der Aufnahme zeigt die UI Upload und Processing ohne Bewertungsscore.

## 5. Was der multimodale Judge ist

Der `Judge` ist kein magischer Produktschauspieler. Er ist ein versionierter
Provideradapter für ein multimodales LLM.

Das Modell vergleicht:

- Fragen und Rubriken;
- relevante Diffausschnitte;
- Transkript mit Zeitmarken;
- wenige ausgewählte Frames;
- Fragenzeitmarken und technische Vollständigkeit, nicht Sprechtempo, Pausen
  oder vermeintliche Sicherheit;
- konkrete Patchreferenzen, Lücken und Widersprüche.

Der Provider erhält keine GitHub-Tokens, keine Datenbankverbindung, keine Tools
und keinen Zugriff auf andere Pull Requests oder Attempts. PR-Inhalte bleiben
untrusted data.

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
};
```

## 6. Maintainer entscheidet im MVP

Der MVP unterstützt ausschließlich `maintainer_review`:

- das LLM erstellt einen assistierenden Befund;
- ein Maintainer entscheidet `pass` oder `retry`;
- Providerfehler blockieren kein manuelles Review.

### Späterer Ausbau: `calibrated_auto_pass`

- erst nach Shadow-Betrieb, Dogfood und separater Freigabe dürfen klare,
  vollständig belegte Fälle automatisch bestehen;
- Auto-Pass bindet konkrete Modell-, Prompt-, Planner-, Rubrik- und
  Schemaversionen;
- eine Versionsänderung fällt zurück auf Shadow oder Review;
- Unsicherheit bleibt menschliche Entscheidung;
- Auto-Fail ist nicht Teil des MVP.

## 7. Videoschutz von Aufnahme bis Löschung

Live-Video enthält Gesicht, Stimme und technische Erklärung. SlopProof behandelt
es als sensible Evidenz.

### Verschlüsselung pro Attempt

- der Smartphone-Browser erzeugt für jeden Attempt einen eigenen Data
  Encryption Key;
- jeder MediaRecorder-Chunk wird vor dem direkten Multipart-Upload mit
  eindeutiger Nonce und attempt-/SHA-gebundener AAD authentifiziert
  verschlüsselt;
- der Browser wrappt den Data Key mit versioniertem öffentlichem Material des
  konfigurierten Key-Wrapping-Providers; nur der gewrappte Schlüssel wird
  gespeichert;
- der Bucket erhält ausschließlich Ciphertext und enthält auch vor
  Finalisierung niemals ein temporäres Klartextvideo;
- Datenbank oder Objektspeicher allein reichen nicht zur Wiedergabe.

Klartext existiert nur kurzzeitig im flüchtigen Browser- beziehungsweise
autorisierten Worker-Speicher. Er wird weder in persistentem Browserstorage
noch in Multipart-Parts oder unverschlüsselten Workerdateien abgelegt.

### Need-to-see Access

- nur berechtigte Maintainer des Repositorys können Evidenz öffnen;
- Zugriff ist kurzlebig und wird protokolliert;
- Support- oder Organisationsadmins erhalten keinen pauschalen Zugriff;
- ein abgelaufener Link oder fremdes Repository führt zu 403.

### Kurze Retention

- Standardlöschung spätestens 24 Stunden nach Abschluss;
- frühere Löschung nach klarem Pass möglich;
- begrenzte Verlängerung bei offenem Review;
- Storage-Lifecycle bildet einen zweiten Backstop;
- Video, Transkript, Frames und Evaluation werden gemeinsam gelöscht oder
  minimiert.

### Begrenzter Providerzugriff

SlopProof stellt dem gewählten Modellendpunkt nur eine temporäre, jobgebundene
Medienreferenz und das kleinste nötige Kontextbundle bereit. Deployment-
Betreiber wählen Provider und verantworten dessen Verarbeitungs- und
Retentionbedingungen. Die Produktseite verspricht keine Bedingungen, die
SlopProof technisch nicht kontrolliert.

### Hard Limits

- keine Gesichtserkennung;
- kein Gaze Tracking oder Raumscan;
- kein öffentliches Video oder Transkript;
- kein dauerhaftes Evidenzarchiv oder globaler Contributor-Score.

## 8. Retry und Unsicherheit

Ein Retry benennt den Grund:

- konkrete unbeantwortete Rubrik;
- Widerspruch zum Patch;
- abgelaufener oder unvollständiger Take;
- technischer Upload- oder Medienfehler.

SlopProof sagt nicht `suspicious`. Ein Providerfehler oder uneindeutiger Befund
wird nicht als fachliches Scheitern verkleidet.

## 9. Accessibility

Der normale MVP-Flow bleibt Live-Video. Menschen, die ihn nicht nutzen können,
brauchen einen privaten Accommodation-Pfad. Dieser Pfad darf Betroffene weder
öffentlich markieren noch eine heimlich schwächere öffentliche Option sein.

Eine konkrete Alternative wird erst aktiviert, wenn Barriere, Assurance,
Datenschutz, Freigabe und Missbrauchsrisiko separat geklärt sind. Ein kurzes
synchrones Maintainer-Viva ist eine mögliche spätere Form.

## 10. MVP-Scope

### Enthalten

- GitHub App, Webhooks und SHA-gebundener Check;
- Practice-Deep-Dive;
- risikoadaptive Fragenplanung;
- QR-/Mobile-Handoff;
- Kamera-/Mikrofon-Preflight;
- ununterbrochene Videoaufnahme mit mehreren möglichen Fragen;
- clientseitige attempt-spezifische Chunkverschlüsselung vor direktem Upload;
- Transkription und begrenzte Frame-Auswahl;
- multimodale LLM-Auswertung;
- verpflichtendes Maintainer-Review, Audit und Löschung.

### Nicht enthalten

- frei wählbare Proof-Modalitäten;
- biometrische Identifikation;
- öffentliche Evidenz;
- dauerhafte Reputation;
- Ausführung von PR-Code;
- Auto-Pass oder Auto-Fail.

## 11. Markenrichtung

V3 heißt intern `Organic Proof Press`.

### Visuelle Sprache

- Proof Paper und Clean Sheet;
- Press Ink;
- Safety Orange für aktive Bewegung;
- Proof Green für gültige Entscheidung;
- Recording Red für den Live-Moment;
- unregelmäßige Radien und wenige harte Schatten;
- Bricolage Grotesque, Instrument Sans und IBM Plex Mono;
- handgezeichnete Kringel und Pfeile.

### Responsibility Loop

Eine orange Linie verbindet Practice, QR-Code, Aufnahme und Proof-Haken. Sie
zeigt den Ablauf als einen Vorgang, nicht als Sammlung unabhängiger Features.

## 12. Finale Produktcopy

### Hero

`Understand it. Say it live. Ship it.`

`Prove you know what you ship.`

`Practice when it helps. When you're ready, answer a focused set of questions
on live video before the pull request can merge.`

### Manifest

`Fast code still deserves a slow thought.`

`Tools can generate code. They cannot take responsibility. SlopProof creates a
clear moment to understand the change before a shared project has to carry
it.`

### Fairness

`Practice when it helps. Prove when you're ready.`

`Contributors arrive with different experience and context. Practice gives
everyone access to preparation without turning preparation into a hurdle.
Experienced contributors and small patches can go directly to Proof.`

### Judge

`A multimodal LLM evaluates. A maintainer decides.`

### Security

`Your video is locked down from capture to deletion.`

### Kurze Linie

`Focused questions. One take. Your patch.`

### Schluss

`Practice it. Prove it. Own it.`

## 13. Kanonische Artefakte

- Produktentscheidung: dieses Dokument;
- Architektur: `01-architektur-und-live-challenge.md`;
- Umsetzung: `02-mvp-implementation-guide.md`;
- Ausbau: `03-ausbauplan-nach-live-video-mvp.md`;
- Brand/UI: `04-brand-marketing-interface.md`;
- aktiver Prototyp: `slopproof-brand-ui-concept-v3.html`;
- historische HTMLs: `archive/`.
