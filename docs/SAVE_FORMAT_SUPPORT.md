# Save format support and evidence

The compatibility claim is deliberately bounded. Version 100 co-op saves with the
tested structures are supported only after complete parser/writer byte equality,
ownership validation, and inverse-operation equality. The game build number is
not used to guess schema compatibility. In-game acceptance remains a separate check.

## Sources

- Vendored GVAS, character, character-container and group readers:
  [palworld-save-toolkit, e71370ede118311e1a2b354caadb6d527ca9bcd2](https://github.com/zlmitchell/palworld-save-toolkit/tree/e71370ede118311e1a2b354caadb6d527ca9bcd2).
- Modern concrete models and work assignments:
  [uesave-rs palworld-v1, 11b2b4907ef6f34337135faed783fef2e450fcaf](https://github.com/oMaN-Rod/uesave-rs/tree/11b2b4907ef6f34337135faed783fef2e450fcaf).
- Original permission/module/foliage layouts: cheahjs/palworld-save-tools,
  preserved in the toolkit's Python vendor tree.

No unqualified global replacement of the host's 16 bytes is permissible. The host
UUID is mostly zeros and appears incidentally across numeric fields and custom
version metadata. Both guest and host occurrences are checked against parsed
ownership offsets and validated non-player spans.

## Ownership handling

- Typed GVAS UUIDs: swap host and selected guest simultaneously.
- Decoded character ownership, previous owners, character keys, guild handles,
  guild members/admin, and character-container slots are included.
- Map models: validated 261-byte profile, `build_player_uid` at 200. Only the
  documented first 241 bytes are exempted as typed fields; unknown bytes 241–260
  remain subject to dual-identity detection.
- Work assignments: documented owner offset 21, canonical fixed flag, four-byte
  zero trailer; Progress_MultiType additionally has three enums and four zeros.
- ItemBooth: private-lock player and each trade's seller UID are updated. Product,
  price and dynamic-item identifiers are left unchanged.
- PasswordLock: documented per-player UID entries are handled for the accepted
  trailer shape. Unknown module layouts containing either identity fail closed.
- Repair and ReviveCharacter work: parse the base, type-specific and type-2
  transform fields; other transform variants are currently rejected when relevant.

## Explicitly inferred, constrained profiles

### DroppedCharacter

The current external reader leaves its newer tail opaque. This app does not assume
that every 88-byte object uses an owner at 68. It accepts that offset only when:

1. The discriminator is DroppedCharacter; version metadata is precisely the known
   two-key v1/v3 profile; size is 88 and the specified four-byte prefix/trailer are zero.
2. Both instance GUIDs match the containing model's reversed pair of GUIDs.
3. The stored-parameter GUID at 36 matches **exactly one** named storage record.
4. The GUID at 68 equals that record's **LostPlayerUId and InstanceId.PlayerUId**.
5. No swapped-identity occurrence lies in unexplained bytes 52–67.

That is a relationally validated inference, not a claim of a fully decoded structure.
Unknown bytes are preserved verbatim. The relationships are checked again when
performing the inverse swap on the output. Mutation tests cover missing/duplicate
records, both owner mismatches, model mismatch, version/length/tail differences and
an unexplained UID occurrence. Other variants are rejected.

### Modern item slots

The modern reader defines a slot/count/PalItemId prefix but keeps the permission
tail opaque. The accepted tail combines that prefix with the legacy permission
schema only when both enum arrays are empty, one allowed static item ID equals the
main item ID, corruption is zero, the final four bytes are zero, and the parser
consumes the payload exactly. This is explicitly a restricted composite inference.
No bytes in these non-player item fields are rewritten. Any unsupported matching
block is rejected rather than silently ignored.

## Other non-player spans

The accepted CustomVersionData false positive is the exact two-key metadata shape
with DE000B38… version 1 and zero GUID version 1. ItemContainer module fields and
foliage coordinates are bounds-checked with their discriminators and zero trailers.
Unknown payloads are preserved only if neither swapped identity occurs in them.

## Verification meaning

The final output must decompress/reparse/rewrite identically. Undoing only the
planned display-name changes and identity swap must reconstruct the original world
and player GVAS bytes exactly. Inventory data, all character instances, experience,
owned-Pal counts and world record counts are preserved. This provides file-level
evidence; it does not prove cryptographic validity, complete game-version support,
cloud-sync behavior or in-game acceptance.
