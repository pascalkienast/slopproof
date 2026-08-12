# SlopProof: finales Brand-, Marketing- und Interface-System

Stand: 2026-08-11  
Status: kanonische V3-Richtung

## 1. Markenversprechen

> **SlopProof — Prove you know what you ship.**

SlopProof macht Patchverständnis zu einem sichtbaren Schritt vor dem Merge.
Die Marke urteilt nicht darüber, wie Code geschrieben wurde. Sie zeigt zwei
faire Wege: bei Bedarf vorbereiten oder direkt live erklären, danach
nachvollziehbar entscheiden.

## 2. Kerncopy

### Hero

**Eyebrow**  
`The pull request accountability gate`

**Headline**  
`Understand it. Say it live. Ship it.`

**Markenclaim**  
`Prove you know what you ship.`

**Subline**  
`Practice when it helps. When you're ready, answer a focused set of questions
on live video before the pull request can merge.`

**CTAs**  
`Practice the patch` · `See the live proof`

### Manifest

**Eyebrow**  
`Understanding before merge`

**Headline**  
`Fast code still deserves a slow thought.`

**Text**  
`Tools can generate code. They cannot take responsibility. SlopProof creates a
clear moment to understand the change before a shared project has to carry
it.`

Die Copy bleibt neutral zur Toolwahl. SlopProof ist weder eine Kampagne für
Coding-Agenten noch gegen sie.

### Practice und Proof

**Eyebrow**  
`One flow · different starting points`

**Headline**  
`Practice when it helps. Prove when you're ready.`

**Text**  
`Contributors arrive with different experience and context. Practice gives
everyone access to preparation without turning preparation into a hurdle.
Experienced contributors and small patches can go directly to Proof.`

### Multimodale Auswertung

**Eyebrow**  
`Assistive multimodal review`

**Headline**  
`A multimodal LLM evaluates. A maintainer decides.`

**Text**  
`A multimodal LLM compares the transcript, selected video frames, question
timestamps, patch context and rubric. It prepares a structured finding for
review. In the MVP, only an authorized maintainer can pass or retry a proof.`

### Video Security

**Eyebrow**  
`Private by architecture`

**Headline**  
`Your video is locked down from capture to deletion.`

Die drei sichtbaren Sicherheitsbausteine:

1. `Encrypted per attempt`
2. `Need-to-see access`
3. `Deleted on a short clock`

Die Verschlüsselung beginnt auf dem Smartphone. Jeder Aufnahmechunk wird vor
dem direkten Upload authentifiziert verschlüsselt. Der Objektspeicher erhält
ausschließlich Ciphertext; auch während Multipart-Upload und Verarbeitung
entsteht dort niemals ein temporäres Klartextvideo.

Providerzugriff wird als technische Grenze beschrieben:

`SlopProof exposes only a temporary, job-scoped media reference. Deployment
operators choose the model endpoint and are responsible for its processing and
retention terms.`

### Schluss

> **Practice it. Prove it. Own it.**

## 3. Ton

SlopProof spricht:

- direkt und technisch;
- streng über Prozesse, respektvoll über Menschen;
- konkret über Daten und Grenzen;
- ruhig bei Unsicherheit;
- ohne erfundene Prozentwerte oder Verdachtsvokabular.

Vermeiden:

- `Prove you are human`;
- `AI-generated PR detected`;
- `Suspicious contributor`;
- `Understanding score: 92%`;
- pauschale Aussagen über Vibe Coding oder handgeschriebenen Code;
- nicht garantierbare Providerclaims;
- die Behauptung, SlopProof beweise Autorschaft oder Täuschungsfreiheit.

Ein Retry benennt eine Lücke:

`Your explanation did not address what happens when the callback fails after
candidate state becomes visible. Start a new proof for this revision.`

## 4. Visuelle Leitidee: Organic Proof Press

V3 behält die Energie der frühen Proof-Press-Richtung und löst sie von der
starren Printwerkstatt. Das System verbindet:

- warme Papierflächen;
- schwarze Druckfarbe;
- Safety Orange für Bewegung und aktive Schritte;
- Proof Green ausschließlich für gültige Entscheidungen;
- weichere, unregelmäßige Radien;
- handgezeichnete Kringel, Pfeile und Unterstreichungen;
- präzise Monospace-Daten für SHA, Timer und Status.

Das wiedererkennbare Element ist die `Responsibility Loop`: Eine orange
gezeichnete Linie beginnt bei Practice, führt zum QR-Handoff, wird zum roten
Recording-Punkt und endet als grüner Proof-Haken.

## 5. Farben

| Rolle | Name | Wert |
| --- | --- | --- |
| Hintergrund | Proof Paper | `#F3EFE4` |
| Fläche | Clean Sheet | `#FFFDF6` |
| Text | Press Ink | `#171711` |
| Sekundärtext | Carbon | `#68645A` |
| Aktion | Safety Orange | `#FF4F22` |
| Erfolg | Proof Green | `#BCE93C` |
| Hinweis | Hold Yellow | `#FFD34F` |
| Aufnahme/Fehler | Recording Red | `#E7372F` |
| Fokus | Signal Blue | `#4C70FF` |

Status wird nie nur über Farbe vermittelt.

## 6. Typografie

- Display: `Bricolage Grotesque`, 650–800;
- UI/Text: `Instrument Sans`, 400–700;
- technische Daten: `IBM Plex Mono`, 400–600.

Herozeilen bleiben auf Desktop und Mobile bewusst gesetzt:

```text
Understand it.
Say it live.
Ship it.
```

`Understand it.` darf nicht unkontrolliert umbrechen. Die Displaygröße wird
viewportabhängig begrenzt; Zeilen erhalten `white-space: nowrap`.

## 7. Form und Bewegung

- harte 2-px-Konturen;
- weiche, leicht unregelmäßige Kartenformen;
- sparsame harte Offset-Schatten;
- Papierkörnung mit sehr geringer Deckkraft;
- ein orchestrierter Responsibility-Loop statt vieler unabhängiger Animationen;
- Hoverbewegungen kurz und mechanisch;
- Reduced-Motion-Modus ohne Informationsverlust;
- schräge Vollbreitenbänder müssen über den Viewport hinausragen, damit keine
  hellen Ecken entstehen.

## 8. Seitenstruktur

### 8.1 Navigation

- Wortmarke `SLOP/PROOF`;
- `The flow`;
- `Video security`;
- CTA `See the proof`.

### 8.2 Hero und GitHub Check

Links stehen Claim und CTAs. Rechts zeigt der GitHub Check zwei Wege:

- `Practice your understanding`;
- `Prove your understanding`.

Der Check zeigt PR-Nummer, kurzen SHA und Status. Private Evidenz bleibt
unsichtbar.

### 8.3 Manifest

Orange Vollfläche mit `Fast code still deserves a slow thought.`. Der Block
erklärt die Verantwortungspause, nicht einen Kulturkampf um Werkzeuge.

### 8.4 Zwei Momente

Practice und Proof stehen als zwei unterschiedlich geformte Karten
nebeneinander. Practice erklärt Fairness und Vorbereitung. Proof erklärt das
risikoadaptive Fragenset im Live-Take.

### 8.5 Klickbares Produkt

Tabs:

- `Practice`: Diff, Risikostellen, Coach und Vorbereitung;
- `Proof`: QR-Handoff, Preflight und Smartphone-Aufnahme.

Das Smartphone zeigt `QUESTION n/m`, Timer, Kamera und aktuelle Frage. Die
Aufnahme bleibt ein Take, auch wenn mehrere Fragen erscheinen.

### 8.6 Auswertungspipeline

Fünf Schritte:

1. `Live capture`
2. `Encrypted vault`
3. `Extract`
4. `Multimodal LLM judge`
5. `Maintainer decision`

Der Text erklärt explizit, was der Judge ist und welche Daten er vergleicht.

### 8.7 Video Security

Die Fläche priorisiert Verschlüsselung, Zugriff und Löschung. Grenzen wie keine
Gesichtserkennung, kein Raumscan, keine öffentliche Evidenz und kein
Dauerarchiv stehen kompakt unter `Hard limits`.

### 8.8 Schluss

Der Abschluss enthält keine zusätzliche Eyebrow. Die große Zeile lautet allein:

`Practice it. Prove it. Own it.`

## 9. Contributor-Oberfläche

### Practice

- strukturierter Patchüberblick;
- anklickbare Risikoanker;
- Übungsfragen;
- Fortschritt ohne Bewertungsscore;
- CTA zur Bereitschaft, nicht zur vermeintlichen Perfektion.

### Proof Desktop

- Fragenanzahl und maximale Dauer vor dem Start;
- QR-Code und Fallback `Continue on this device`;
- kurze Erklärung von Zugriff und Löschung;
- kein Frageinhalt vor dem Start.

### Proof Mobile

- Kamera-/Mikrofon-Preflight;
- `Frage n/m`;
- 15 Sekunden Orientierung;
- bis zu 90 Sekunden Antwort pro Frage;
- ununterbrochene Session;
- Upload- und Processingstatus;
- keine Live-Bewertung und kein Prozentwert.

## 10. Maintainer-Oberfläche

- Reviewqueue;
- PR, Autor und aktueller Head-SHA;
- Fragen und Rubrik;
- geschütztes Video mit synchronisiertem Transkript;
- ausgewählte Frames mit Begründung;
- separater multimodaler LLM-Befund;
- explizite Aktionen `pass` und `retry`;
- sichtbare Löschdeadline und auditierter Zugriff.

Die Oberfläche darf den Modellbefund nicht als objektive Wahrheit inszenieren.

## 11. Repository-Policy

Die Policyoberfläche erklärt:

- Practice an/aus;
- Fragenbudget und Split-Empfehlung;
- im MVP ausschließlich `maintainer_review`;
- Retention innerhalb der erlaubten Grenzen;
- Maintainergruppen mit Evidence Access;
- privaten Accommodation-Pfad.

Der normale Contributor sieht keine Auswahl verschiedener Proof-Modalitäten.
`calibrated_auto_pass` ist eine spätere, separat kalibrierte Ausbaustufe und
wird in der MVP-Oberfläche nicht angeboten.

## 12. Responsive Regeln

- Hero unter 980 px einspaltig;
- unter 720 px volle Breite für CTAs;
- Karten und Pipeline auf eine Spalte;
- QR-Layout darf zweispaltig bleiben, solange 390 px ohne Overflow bestehen;
- Smartphone-Demo bleibt vollständig sichtbar;
- schräge Bänder überdecken beide Viewportränder;
- Fokus und Touchziele mindestens 40–44 px;
- Desktop, 1440 px und Mobile, 390 px, gehören zum Pflicht-Smoke.

## 13. Aktives Artefakt

Der klickbare Referenzstand liegt in:

`slopproof-brand-ui-concept-v3.html`

Frühere HTMLs liegen unter `archive/` und dürfen nicht als Vorlage verwendet
werden.
