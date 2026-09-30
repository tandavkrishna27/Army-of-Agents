# Upstream Lineage and AoA Contracts

AoA began as a fork of an upstream agent orchestration project. The historical decisions and plans under `docs/archive/` explain the original porting work. AoA's current contracts are authoritative in `CLAUDE.md`, `docs/architecture/decisions.md`, and source code.

The clean break approved on 2026-09-30 removes inherited brand identifiers from active interfaces. There are no existing AoA product installations to migrate. The previous wire compatibility exceptions, including Decision #92's Hermes deferral, are superseded. See [wire contracts](architecture/wire-compat.md) for current names.

DB and REST naming is separate from the brand cleanup: the `issues` table and `/issues` route still back UI Tasks, and `goals` still back Objectives. See the naming map in `CLAUDE.md`.

The `discussion_annotations` table and API remain as deprecated compatibility
stubs for the Discussion model. The Thread surface `EntryRow` no longer exposes
annotation actions; `DiscussionDetail` still has a separate entry renderer.
