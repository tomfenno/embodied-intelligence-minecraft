# BUG 1 — Entity Metadata PartialReadError

**Severity:** Medium (non-fatal, noisy)
**Status:** Hypothesis — not fully proven from logs alone
**Branch:** hard-code-nts-am

---

## Symptom

Repeated errors immediately after bot spawns:

```
PartialReadError: Read error for undefined : Unexpected buffer end while reading VarInt
    at Object.readVarInt [as varint] (.../protodef/src/datatypes/varint.js:19:40)
    at Object.string (eval at compile ...)
    at Object.entityMetadataEntry (...)
    at Object.entityMetadata (...)
    at Object.packet_entity_metadata (...)
```

Bot does not crash — errors are caught and logged by protodef's serializer.

---

## Likely Cause

MC server is running **1.21.6**. The `entityMetadataEntry` type in `minecraft-data`'s
`1.21.6/protocol.json` has a type ID mapping that doesn't match what the server
actually sends. The parser reads a type ID of `4` (string) for a metadata entry,
then tries to read a VarInt length prefix for the string — the buffer ends, throwing
`PartialReadError`.

The entity metadata type ID table in `minecraft-data/minecraft-data/data/pc/1.21.6/protocol.json`
(under `types.entityMetadataEntry`) maps IDs 0–34. A likely culprit is one of the
newer variant types (IDs 22–28: `cat_variant`, `cow_variant`, `wolf_variant`,
`wolf_sound_variant`, `frog_variant`, `pig_variant`, `chicken_variant`) where an ID
shift or missing entry causes misidentification.

**This is a hypothesis.** The exact wrong mapping has not been confirmed from raw
packet inspection.

---

## What Is NOT Affected

- Bot connection and login
- Block collection (`!collectBlocks`)
- Crafting (separate issue — see BUG 2)
- SCSG / NTS / AM pipeline

---

## Investigation Steps

### Step 1 — Confirm patch versions match installed versions

`patch-package` matches by exact version in the filename.

| Patch file | Targets | Host-installed | Docker (cached layer) |
|---|---|---|---|
| `mineflayer+4.33.0.patch` | 4.33.0 | 4.35.0 ❌ | likely 4.33.0 ✓ |
| `minecraft-data+3.97.0.patch` | 3.97.0 | 3.105.0 ❌ | likely 3.97.0 ✓ |

Pin exact versions in `package.json` to match patch filenames:

```json
"mineflayer": "4.33.0",
"minecraft-data": "3.97.0"
```

Then rebuild without cache to force patch application:

```bash
docker-compose build --no-cache
```

Watch for `patch-package` warnings during the npm install step.

### Step 2 — Identify the exact failing type ID

Add a temporary debug handler to log raw packet bytes on parse error.
Extend `patches/protodef+1.19.0.patch` to add a hex dump on catch:

```diff
 } catch (e) {
   if (e.partialReadError) {
     if (!this.noErrorLogging) {
       console.error(e)
+      console.error('raw buffer (hex):', chunk.toString('hex'))
     }
   }
```

Run the container, wait for a `PartialReadError`, decode:
- First byte = `key` (u8, metadata slot index)
- Next bytes = `type` VarInt (the misidentified type ID)

Compare the actual type ID against the mapping in `protocol.json` to find which
entry is wrong.

### Step 3 — Patch protocol.json

Once the wrong mapping is identified, add a diff block to
`patches/minecraft-data+3.97.0.patch` (or the correctly-named version after Step 1).

Existing patch example (checksum fix):
```diff
-              "type": "i8"
+              "type": "u8"
```

Apply the same pattern to correct the entity metadata type mapping.

### Step 4 — Rebuild and verify

```bash
docker-compose build --no-cache
docker-compose up
```

Confirm `PartialReadError` lines are gone from startup output.

---

## Alternative: Check minecraft-data GitHub history

Search commits on `PrismarineJS/minecraft-data` touching
`data/pc/1.21.6/protocol.json` under `entityMetadataEntry`. Those commits will
show exactly which type IDs were corrected after the initial 1.21.6 release.
