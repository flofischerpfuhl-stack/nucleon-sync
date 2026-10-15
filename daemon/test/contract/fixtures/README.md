# CLI contract fixtures (proton-drive 0.9.0)

**Provenance: synthesized, not recorded.** The JSON follows the field lists of `proton-drive` 0.9.0 (`filesystem list
-j`, `info -j`, `size -j`, `/devices`, the upload summary and its error texts; see `docs/ARCHITECTURE.md` §5.1). All
UIDs are random base64url strings in the real `volume~node~revision` shape; names, sizes and hashes are invented.

To replace them with recorded output (read-only commands only, at most 2 CLI processes, `PROTON_DRIVE_LOG_LEVEL=INFO`):

    NUCLEON_SYNC_RECORD_FIXTURES=1 node daemon/test/contract/record-fixtures.ts /my-files/<folder> <file>

then re-run `pnpm test` (`daemon/test/contract/contract.test.ts` parses every fixture and the mock output with the
same parser). Scrub recorded fixtures before committing them: UIDs, file names and hashes identify your Drive.
