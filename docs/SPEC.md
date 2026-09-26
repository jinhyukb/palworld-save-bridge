# Palworld Save Bridge 0.1

Approved scope: Windows portable desktop app. Steam co-op guest becomes the local
host, retaining the world and chosen character. All processing stays on the PC.
No Git initialization, repository publishing, telemetry, or save upload.

## Flow

1. Drop or choose a world folder or ZIP. Discover nested worlds, excluding historical
   backups. If multiple current worlds exist, require a choice. Explain missing files.
2. Show world, original host, players with level and owned-Pal count. User explicitly
   chooses their character. Optional world/character names, output folder, and own
   LocalData selection. Defaults preserve existing names and the supplied LocalData;
   clearly distinguish the host's local map from the user's own map.
3. Show a before/after preview; convert an immutable session snapshot into a new
   output directory and ZIP. Preserve source, validate rewritten saves, provide a
   readable report. File verification is separate from in-game verification.
4. Optionally apply to an explicitly selected local Steam account. Show exact world
   collision and confirmation. Verify a backup before swapping directories; prevent
   application while Palworld is running. Never modify other worlds.
5. Persistent application history supports restoring a selected backup. Preserve
   newer progress in a separate backup before restore. Verify backup integrity.

## Compatibility and validation

- Detect actual save container and schema, not marketing game version labels.
- Initially support PlM/Oodle and PlZ containers whose complete selected schemas
  round-trip exactly and whose ownership data can be handled without guessing.
- Fail closed on unknown layouts, corrupt files, missing selected character data,
  undecoded characters/guilds, inconsistent UIDs, unsupported structures or failed
  reversibility. Never label incomplete conversion successful.
- Swap semantic UUIDs including decoded character, guild and slot references;
  patch only validated owner fields inside known binary structures. Do not replace
  arbitrary byte patterns throughout a save.
- Rename only the selected player and that player's guild display records, plus
  world metadata. Preserve both characters, all inventory and game progression.
- Keep the old host's data; reconnecting that friend is a separate future workflow.
- Safety tests use temporary SaveGames roots. UI/packaged testing must not apply to
  the user's actual game directory. Real saves are opt-in local fixtures, excluded
  from the distributable and prospective source repository.

## Initial exclusions

Dedicated-server migration, Game Pass/container conversion, cross-world transfers,
stat/item editing, automatic Steam Cloud manipulation, automatic game launch.

## Implementation

Electron desktop, sandboxed renderer with a narrow validated IPC API. Worker-thread
parsing/conversion keeps progress and cancellation responsive. Vendored parser
source at a recorded commit, GPL-3.0 distribution with preserved notices. Node
built-in tests, isolated filesystem integration tests, Electron UI smoke tests and
a portable Windows build. No production fixture data inside app source.
