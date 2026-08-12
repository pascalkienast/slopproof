# SlopProof: Ausbauplan nach dem Live-Video-MVP

Stand: 2026-08-11  
Status: geplanter Ausbau nach lokalem Golden Path und Dogfood

## 1. Ausgangspunkt

Der MVP besitzt einen klaren Hauptflow:

```text
Practice your understanding
        ↓
QR-Handoff zum Smartphone
        ↓
risikoadaptive Fragen in einem Live-Video-Take
        ↓
multimodale LLM-Auswertung
        ↓
assistierender Modellbefund
        ↓
verpflichtendes Maintainer-Review
```

Der Ausbau verbreitert diesen Flow nicht sofort um weitere Antwortformen. Er
macht zunächst Planung, Bewertung, Betrieb und Governance belastbar.

## 2. Reihenfolge

### Release 1.1 — Shadow Evaluation und Kalibrierung

Ziel: Modellurteile messen, ohne Entscheidungen zu automatisieren.

- jeder Proof geht weiterhin an Maintainer;
- das multimodale LLM läuft im Shadow-Modus;
- Modellbefund und Maintainerentscheidung werden versioniert verglichen;
- Reason Codes und Rubrikabweichungen werden ausgewertet;
- Provider-, Modell-, Prompt-, Planner- und Rubrikversion bilden eine feste
  Kalibrierungseinheit;
- Kill Switch deaktiviert Evaluation ohne Ausfall des Reviewflows.

Abnahme:

- ausreichend vielfältiger Dogfood-Datensatz;
- keine Evidenz in Analytics oder Logs;
- Overridefälle können konkret erklärt werden;
- bekannte Fehlermuster und nicht prüfbare Patchtypen sind dokumentiert.

### Release 1.2 — Assistiertes Maintainer-Review

Ziel: Review beschleunigen, ohne Urteil zu verstecken.

- synchronisierte Wiedergabe von Video, Transkript und Fragen;
- Modellbefund zeigt Belege, Lücken und Widersprüche;
- Maintainer kann `pass` oder `retry` unabhängig entscheiden;
- Override verlangt einen knappen Reason Code, keinen Aufsatz;
- Reviewqueue priorisiert Alter und Repositorypolicy, nicht einen geheimen
  Contributor-Score.

Abnahme:

- Maintainer versteht, was das Modell verglichen hat;
- Reviewer kann jeden Befund auf Patch und Aufnahme zurückführen;
- Berechtigungs- und Auditpfade sind getestet;
- Review bleibt bei Providerstörung vollständig funktionsfähig.

### Release 1.3 — Kalibriertes Auto-Pass

Ziel: klare Fälle automatisch freigeben, wenn ein Repository dies wünscht.

Dies ist die erste Release-Stufe, in der Auto-Pass überhaupt ein gültiger
Policywert werden darf. Der MVP, Release 1.1 und Release 1.2 schließen jeden
Proof ausschließlich über eine Maintainerentscheidung ab.

- Auto-Pass ist pro Repository opt-in;
- Freigabe bindet eine konkrete Kalibrierungseinheit;
- jede Versionsänderung setzt Auto-Pass zunächst zurück auf Shadow;
- Unsicherheit und Widerspruch bleiben Review;
- Auto-Fail bleibt ausgeschlossen;
- Rollback auf `maintainer_review` ist ohne Migration möglich.

Abnahme:

- dokumentierter Schwellen- und Evaluationsprozess;
- getrennte Metriken nach Patchrisiko und Fragenbudget;
- keine systematische Benachteiligung bestimmter Akzente, Kameras oder
  Sprechstile in den fachlichen Kriterien;
- Maintainer-Overrides bleiben niedrig und erklärbar;
- ein Incident-Schalter deaktiviert Auto-Pass sofort.

### Release 1.4 — Questions Planner V2

Ziel: bessere Abdeckung großer und heterogener Pull Requests.

- semantische Komponenten statt bloßer Dateigruppen;
- explizite Abdeckung von Migration, Berechtigung, Nebenläufigkeit, Rollback
  und Teststrategie;
- Duplikaterkennung zwischen Fragen;
- Split-Empfehlung mit begründeter Grenzüberschreitung;
- repositoryspezifische Fragentemplates;
- Kalibrierung nach Planerversion.

Abnahme:

- kleine Änderungen bleiben kurz;
- Generated Output vergrößert das Budget nicht;
- große Patches erhalten verschiedene Risikofragen statt Detailvarianten;
- Planner kann erklären, warum er eine Frage gewählt oder einen PR als zu groß
  markiert hat.

### Release 1.5 — Practice Coach V2

Ziel: Practice als nützliches Entwicklerwerkzeug unabhängig vom Gate stärken.

- interaktive Erklärpfade pro Risiko;
- Übungsfragen mit Feedback;
- Hinweise auf noch nicht erklärbare Rollback- oder Testpfade;
- optionaler persönlicher Practice-Modus für eigene Repositories;
- keine Verwendung von Practice-Antworten als Proof-Signal;
- klare Datenminimierung.

Abnahme:

- Nutzer kann vom Diff zur relevanten Erklärung springen;
- Coach erfindet keine Patchbehauptungen ohne Anchor;
- Practice bleibt optional und blockiert Proof nicht;
- die Trennung der Datenpfade ist technisch getestet.

## 3. Providerstrategie

SlopProof definiert Verträge, keine feste Cloudpflicht.

### Fähigkeiten

- Transkription mit Zeitmarken;
- multimodale Auswertung von Text und begrenzten Frames beziehungsweise
  jobgebundener Videoreferenz;
- strukturierte Ausgabe nach versioniertem Schema;
- dokumentierbare Datenübergabe und Fehlerklassen.

### Betreiberverantwortung

Der Deployment-Betreiber wählt Provider, Region, Vertrag und Retention. Die UI
darf deshalb keine pauschalen No-Training- oder Löschversprechen über fremde
Anbieter machen. SlopProof garantiert nur eigene technische Grenzen:

- kleinstmögliches Inputbundle;
- keine GitHub-Secrets oder Tools;
- kurzlebige Referenzen;
- keine providerübergreifende Wiederverwendung;
- sichtbare Providerkonfiguration in den Betreiberunterlagen.

### Lokale Provider

Lokale Transkriptions- oder multimodale Modelle können später Adapter erhalten.
Sie müssen dieselben Schemas, Limits und Securitytests erfüllen. `local` ist
kein Synonym für sicher: Ressourcenlimits, Modellherkunft und Logverhalten
bleiben prüfpflichtig.

## 4. Evidence Security V2

Baseline aus dem MVP bleibt: Das Smartphone verschlüsselt jeden Chunk vor dem
direkten Multipart-Upload. In keinem Bucket oder persistenten Browserstorage
entsteht ein Klartextvideo.

Nach dem MVP folgen:

- automatisierte Rotation des Key-Wrapping-Schlüssels;
- feinere getrennte Rollen für Ingestion, Verarbeitung und Review;
- externe Audit-Events ohne Medieninhalt;
- überprüfbare Löschreports;
- Backups, die keine entschlüsselbaren Evidence-Kopien erzeugen;
- Incident Runbooks für unberechtigten Zugriff, Ausfall des Key-Wrapping-
  Providers und Retention-Lag;
- optional kundeneigene Schlüssel für größere Self-Hosted-Installationen.

Eine längere Aufbewahrung ist kein Featuredefault. Repositories müssen eine
begründete Policy und sichtbare Nutzerinformation setzen.

## 5. Accessibility und Accommodation

Der Live-Video-MVP hat eine reale Zugangshürde. Der Ausbau braucht einen
privaten Accommodation-Prozess, ohne Betroffene öffentlich zu markieren.

Vor einer alternativen Proof-Form müssen geklärt werden:

- welche Barriere sie adressiert;
- welche Assurance sie tatsächlich liefert;
- welche zusätzlichen Missbrauchs- und Datenschutzrisiken entstehen;
- wer sie freischaltet und wie lange die Freigabe gilt;
- welche Informationen öffentlich sichtbar werden dürfen.

Mögliche spätere Pfade sind ein synchrones Maintainer-Viva oder eine andere
gleichwertige, zeitgebundene Erklärung. Eine öffentliche Moduswahl im normalen
Contributor-Flow ist nicht geplant.

## 6. Repository- und Organisationsgovernance

Spätere Policies können zusätzlich steuern:

- welche Pfade oder Labels Proof verlangen;
- Bypass für Bots und vertrauenswürdige Wartungsautomation;
- maximale Fragenzahl;
- Reviewpflicht für bestimmte Risikoklassen;
- Auto-Pass-Kalibrierung;
- Retention innerhalb sicherer Grenzen;
- Maintainergruppen mit Evidenzzugriff;
- private Accommodation-Freigaben.

Bypass und Override sind auditierbar. Eine Organisation darf keine heimliche
Gesichts- oder Reputationsdatenbank über SlopProof aufbauen.

## 7. Trust ohne Contributor-Ranking

Ein späteres Vertrauensmodell darf Reibung reduzieren, aber keine dauerhafte
Personenbewertung erzeugen.

Vertretbar wären:

- repositorylokale, kurzlebige Bypass-Regeln;
- Maintainerfreigabe für bekannte Teams;
- geringeres Fragenbudget nach wiederholten, aktuellen Nachweisen im selben
  Repository;
- sofortiger Entzug bei neuer Risikoklasse oder Maintainerentscheidung.

Nicht vorgesehen sind globale Scores, öffentliche Badges über persönliche
Zuverlässigkeit oder verkaufte Reputation.

## 8. Betriebsreife

Vor breiter Installation braucht SlopProof:

- Installations- und Upgradeguide;
- Backup-/Restore-Test für Metadaten;
- klare Key-Wrapping- und Storage-Contracts ohne Bindung an konkrete Produkte;
- Providerkosten- und Kapazitätsmetriken;
- Rate Limits und Abuse Monitoring;
- SLOs für Check, Upload, Processing und Löschung;
- Statusseite ohne Evidenzdetails;
- Datenexport und saubere Deinstallation;
- Security Disclosure und Threat Model.

## 9. Skalierung

Erst bei gemessener Last:

- Worker nach Jobklasse trennen;
- Medienjobs mit eigener Ressourcenklasse;
- Queue-Priorität für interaktive Proofs und Retention;
- regionale Buckets und Grenzen des gewählten Key-Wrapping-Providers;
- Uploadresumption;
- Backpressure bei Providerausfällen;
- kontrollierte Degradation auf Maintainer-Review.

Redis, Kubernetes oder Microservices werden nur eingeführt, wenn Messdaten ein
konkretes Problem zeigen.

## 10. Spätere, getrennte Forschung

### Ausführung von PR-Code

Testvorhersagen oder Mini-Aufgaben könnten Verständnis stärker prüfen. Sie
erfordern jedoch einen eigenen Runner, ein separates Threat Model und eine
eigene Abnahme. Dafür gelten mindestens:

- kein Netzwerk;
- keine App-Secrets;
- kein Datenbankzugriff;
- kein Docker-Socket;
- harte CPU-, Speicher-, Prozess- und Zeitlimits;
- ephemere Umgebung;
- gVisor, MicroVM oder gleichwertige Isolation.

Dieser Pfad ist kein Teil des Live-Video-MVP oder der Releases 1.1 bis 1.5.

### Weitere Proof-Formen

Papier, Live-Text oder Audio-only werden nicht als allgemeines Produktmenü
wieder eingeführt. Eine spätere Form braucht eine konkrete Accessibility- oder
Assurance-Begründung und eigene Tests.

## 11. Reihenfolge der Freigaben

1. lokaler Golden Path;
2. kontrollierter Dogfood-PR mit verpflichtendem Maintainer-Review;
3. Shadow Evaluation;
4. assistiertes Review;
5. kalibriertes Auto-Pass für ein Testrepository;
6. Planner und Practice V2;
7. breitere Self-Hosted-Dokumentation;
8. erst danach weitere Proof- oder Runnerforschung.

Jede Stufe besitzt Kill Switch, dokumentierte Rückkehr zum vorherigen Modus und
eine klare Datenlöschung.

## 12. Erfolgskriterien

Der Ausbau ist sinnvoll, wenn:

- Maintainer weniger Zeit mit unverstandenen Pull Requests verlieren;
- ernsthafte Contributors Practice als fair und nützlich erleben;
- Fragenbudgets Risiko statt Dateimasse abbilden;
- automatische Freigaben selten korrigiert werden müssen;
- Provider- oder Modellfehler nie als fachliches Urteil erscheinen;
- Videos fristgerecht gelöscht und Zugriffe vollständig auditiert werden;
- ein Repository SlopProof deaktivieren oder zurückstufen kann, ohne seine
  Pull Requests zu blockieren.
