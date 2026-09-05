# UnderstandProof Recording Crypto v1

Status: verbindliche Protokollspezifikation  
Suite-ID: `SP-RC1`

Diese Spezifikation schließt die Kryptoprotokollgrenze. Abweichende
Algorithmen, Feldreihenfolgen oder stilles Fallback sind nicht erlaubt.

## Schlüssel und Ableitung

Der Browser erzeugt pro Attempt 32 zufällige Bytes `K_master` und einen
zufälligen acht Byte langen Nonce-Präfix. `K_master` wird mit HKDF-SHA-256 in
zwei getrennte Schlüssel abgeleitet:

- `K_enc`: AES-256-GCM mit 128-Bit-Tag;
- `K_manifest`: HMAC-SHA-256.

Der HKDF-Kontext ist die UTF-8-Kodierung von:

```text
JSON.stringify([
  "slopproof-recording-kdf", 1, attemptId, headSha, objectId
])
```

Der Salt ist SHA-256 dieses Kontexts. Die beiden Info-Werte sind exakt:

```text
slopproof/recording/v1/chunk-aead
slopproof/recording/v1/manifest-auth
```

Der Browser wrappt `K_master` mit RSA-OAEP/SHA-256 ohne OAEP-Label. Das lokale
Self-Host-Profil verwendet RSA-3072 mit Exponent 65537. Es akzeptiert nur
serverseitig ausgegebenes, mindestens 3072 Bit starkes SPKI-Material. Der
private Schlüssel ist ausschließlich dem Worker zugänglich.

## Normalisierung

- IDs sind kanonische kleingeschriebene UUIDs.
- `headSha` ist exakt 40 Zeichen langes kleingeschriebenes Hex.
- Der v1-Codec ist ausschließlich `video/webm;codecs=vp8,opus`, bis weitere
  Profile physisch und im Integrationstest bestätigt sind.
- Zahlen sind nicht negative Safe Integers.
- Binärwerte sind ungepaddetes Base64url nach RFC 4648.
- Strikte Schemas lehnen unbekannte Felder ab.

## Chunk-AAD und Nonce

Die Additional Authenticated Data ist exakt die UTF-8-Kodierung von:

```text
JSON.stringify([
  "slopproof-recording-chunk", 1, "SP-RC1",
  attemptId, headSha, objectId, codec,
  chunkIndex, nonceBase64url, plaintextBytes
])
```

Der 12-Byte-GCM-Nonce ist `randomPrefix8 || uint32be(chunkIndex)`. Der Index
beginnt bei null, ist lückenlos und wird nur für nicht leere MediaRecorder-
Blobs erhöht. Reload oder Verlust des Schlüsselzustands invalidiert den
Attempt; eine Aufnahme wird nicht mit rekonstruiertem Zustand fortgesetzt.

## Binäres Chunk-Record

Ein verschlüsselter MediaRecorder-Chunk wird als unveränderter `SPC1`-Record
seriell an den Objektbytestrom angehängt. Die Verkettung aller Multipart-Parts
muss exakt dieselbe lückenlose, byte-identische Recordfolge ohne Padding oder
Trennbytes ergeben. Eine feste Transportgrenze darf einen Record an jeder
Byteposition teilen, auch innerhalb von Header, Ciphertext oder GCM-Tag. Diese
Teilung verändert weder Recordbytes noch Nonce, AAD, Längen oder Hashbindung.
Der Record ist:

| Offset | Größe | Inhalt                              |
| ------ | ----- | ----------------------------------- |
| 0      | 4     | ASCII `SPC1`                        |
| 4      | 1     | Recordversion `1`                   |
| 5      | 1     | Flags `0`                           |
| 6      | 2     | Headerlänge `32`, uint16 BE         |
| 8      | 4     | Chunkindex, uint32 BE               |
| 12     | 12    | Nonce                               |
| 24     | 4     | Klartextlänge, uint32 BE            |
| 28     | 4     | Sealed-Länge, uint32 BE             |
| 32     | N     | AES-GCM-Ciphertext plus 16-Byte-Tag |

`sealedLength` muss `plaintextLength + 16` entsprechen. Der Record ist damit
`plaintextLength + 48` Byte lang.

## Manifest

Das API-Objekt wird strikt validiert. Für HMAC und Digest rekonstruiert die
Implementierung ausschließlich folgendes positionsgebundene Tupel:

```text
JSON.stringify([
  "slopproof-recording-manifest", 1, "SP-RC1",
  attemptId, headSha, objectId, codec, noncePrefixBase64url,
  wrapping.materialId, wrapping.keyId, "RSA-OAEP-256",
  wrapping.wrappedKeySha256,
  durationMs, totalPlaintextBytes, totalObjectBytes,
  chunks.map(c => [
    c.index, c.nonce, c.plaintextBytes, c.sealedBytes,
    c.ciphertextSha256
  ]),
  parts.map(p => [
    p.partNumber, p.firstChunkIndex, p.lastChunkIndex,
    p.byteLength, p.sha256
  ])
])
```

`manifestTag = HMAC-SHA-256(K_manifest, canonicalManifestBytes)`.
`manifestDigest = SHA-256(canonicalManifestBytes)` dient nur Idempotenz und
Audit, nicht als Authentifizierung. Multipart-ETags bleiben opake
Transportbelege und sind nicht Teil des HMAC.

Vor dem Unwrap werden unter anderem lückenlose Indizes, korrekte Nonces,
Längengleichungen, exakte Partintersektionen, Summen, Hashlängen und bekannte
Versionen geprüft. `firstChunkIndex` und `lastChunkIndex` eines Parts sind exakt
der erste und letzte Recordindex, deren halboffene Bytebereiche den halboffenen
Bytebereich des Parts schneiden. Für zwei benachbarte Parts ist der nächste
`firstChunkIndex` deshalb entweder der vorherige `lastChunkIndex` — genau ein
an der Transportgrenze geteilter Record — oder `lastChunkIndex + 1` — eine
Grenze exakt zwischen Records. Lücken und ein Überlapp von mehr als einem
Recordindex sind ungültig; abweichende, obwohl formal zusammenhängende Bereiche
werden gegen die Recordoffsets ebenfalls abgelehnt.

## S3-Multipart-Packing

- Jedes nicht finale Transportfenster ist exakt `8 * 1024 * 1024` Byte. Damit
  erfüllt es zugleich das S3-Minimum von `5 * 1024 * 1024` Byte.
- Das verbleibende finale Fenster darf kleiner als 8 MiB und damit auch kleiner
  als 5 MiB sein. Ist die Objektlänge exakt durch 8 MiB teilbar, entsteht kein
  zusätzliches leeres Fenster.
- Maximaler Klartextchunk: 4 MiB.
- Maximaler verschlüsselter Puffer: 16 MiB.
- Maximal 1024 Chunks, 32 Parts, 128 MiB Objektgröße, acht Minuten und
  512 KiB Finalize-JSON.
- Vollständige verschlüsselte Records werden geordnet in einen flüchtigen
  Bytestrom übernommen. Sobald mindestens 8 MiB bereitstehen, werden die
  nächsten exakt 8 MiB als sequenzieller Part entnommen; Recordgrenzen haben
  für diese Transportfenster keine Sonderbedeutung. Die Partverkettung muss den
  ursprünglichen `SPC1`-Bytestrom exakt rekonstruieren.
- Jeder Manifest-Part nennt exakt alle Recordindizes, die sein Bytefenster
  schneidet. Benachbarte Parts dürfen dadurch höchstens den einen an ihrer
  gemeinsamen Grenze geteilten Chunkindex wiederholen; kein Index darf
  übersprungen und kein Bereich um mehr als einen Index überlappt werden.
- ETags gelten nie als kryptografische Hashes. Der Browser bildet für jeden
  kompletten Part zusätzlich SHA-256.
- Verschiedene Bytes für dieselbe Partnummer invalidieren den Upload.

Der Browser fordert pro Part eine attempt-gebundene, kurzlebige `UploadPart`-
URL an. Ciphertext durchläuft dabei nie die Web-API. CORS erlaubt nur die
nötigen Methoden und exponiert `ETag`.

## Finalisierung und Worker

1. Der Browser stoppt die Aufnahme, leert seine serialisierte
   Verschlüsselungs-/Uploadqueue und sendet Manifest, HMAC, Wrapped Key und
   Part-ETags.
2. Das Web prüft Schema, Limits, Attempt, SHA, Deadline, Wrapping-Bindung und
   `ListParts`. Es speichert eine unveränderliche Finalisierung und enqueut den
   Worker. Das Web schließt den Multipart-Upload noch nicht ab.
3. Der Worker prüft Wrapped-Key-Hash und Keyreferenz, unwrappt exakt 32 Byte,
   leitet `K_manifest` ab und prüft den HMAC timing-safe.
4. Erst danach schließt der Worker den Multipart-Upload idempotent ab.
5. Der Worker prüft Objekt- und Parthashes, Framing, Index, Nonce, AAD und jeden
   GCM-Tag. Nachlaufende Bytes sind ein Fehler.
6. Entschlüsselte Bytes fließen ohne Klartextdatei per Pipe an FFmpeg. Codec,
   Dauer und Ressourcenlimits werden serverseitig geprüft.
7. Jede Abweichung löscht das Objekt, zerstört Key-Metadaten, erzeugt
   `technical_retry` und protokolliert ausschließlich IDs und Fehlerklasse.

`dataavailable`-Events werden im Browser über eine serialisierte Promise-Queue
verarbeitet. Leere Blobs verbrauchen keinen Index. IndexedDB, Local Storage und
Cache Storage werden nicht verwendet.

## Privater Reviewstream

Das Web gibt den privaten Schlüssel auch für Maintainer-Reviews niemals frei.
Nach frischer repositorygebundener Autorisierung erzeugt es stattdessen eine
höchstens 60 Sekunden gültige, attempt-/repository-/actor-gebundene
One-Time-Capability. Der Worker verbraucht deren JTI atomar, prüft erneut
Current-SHA, Status und Retention und entschlüsselt das Objekt während genau
eines Streams.

Das Web leitet diesen Stream ohne Speicherung weiter. Der Reviewbrowser ruft
ihn exakt einmal ab, validiert Typ und deklarierte Länge gegen das 128-MiB-Limit
und spielt anschließend eine `blob:`-URL aus flüchtigem Tab-Speicher ab. Beim
Verlassen wird die URL widerrufen; Cache Storage, IndexedDB und lokale Dateien
bleiben unbenutzt. Das Audit unterscheidet Web-Autorisierung sowie im Worker
gestarteten und vollständig beendeten Stream.

## Verschlüsselte Derivate und privater Reviewkontext

Frame-Auswahl bedeutet nicht, dass Klartext-JPEGs im Objektspeicher landen.
Der Worker extrahiert die begrenzten Frames aus dem entschlüsselten Pipe-Stream,
verschlüsselt jedes Derivat unmittelbar mit AES-256-GCM und persistiert nur den
Ciphertext samt attempt-/SHA-gebundener AAD. Transkript und Evaluation liegen
ebenfalls nur als verschlüsselte Providerpayloads vor.

Der finale, hashgebundene Frame-Objektschlüssel wird vor dem Ciphertext-PUT
dauerhaft in `frame_selections` reserviert. Ein Crash nach dem PUT bleibt damit
für Retention sichtbar; ein Retry entfernt eine Reservation nur dann, wenn ein
`HEAD` das exakt gebundene Objekt als fehlend bestätigt. Transiente
Storagefehler führen nicht zur Löschung einer vorhandenen Referenz.

Für die Reviewoberfläche entschlüsselt ausschließlich der Worker den benötigten
Kontext hinter derselben kurzlebigen, repository-/actor-/attempt-gebundenen
Capability-Grenze. Das Web erhält nur die autorisierte Antwort für diesen
Review und speichert weder Frames, Transkript noch Evaluation dauerhaft oder in
Browserstorage.

## Mindesttests

- browser-/workerübergreifende Golden Vectors für KDF, AAD, Nonce,
  Ciphertext, Record, Manifest und HMAC;
- Nonce-Eindeutigkeit und Ablehnung doppelter oder lückenhafter Indizes;
- Manipulation jedes gebundenen AAD-/Manifestfelds;
- vertauschte, fehlende, doppelte, gekürzte oder erweiterte Records;
- falscher Key, Key-ID, Material-ID, Wrapped-Key-Hash oder Attempt-Replay;
- von exakt 8 MiB abweichende nicht finale Parts, falsche
  Record-/Partintersektionen, Lücken, Mehrfachüberlapp und
  `ListParts`-Abweichungen;
- alle Größen-, Zeit-, Chunk-, Part- und Backloglimits;
- Nachweis, dass Storage nur `SPC1`-Records enthält und ein bekannter
  Klartextmarker nicht vorkommt;
- Nachweis, dass DB und Bucket ohne privaten Worker-Schlüssel nicht
  entschlüsseln können;
- Redactiontests für Wrapped Key, Manifesttag, Presigned URL, Medienbytes und
  Providerpayloads.
