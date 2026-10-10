# Compatibility Notes

AoA keeps stable contracts across runtime, plugin, CLI, browser, export, and integration surfaces. Review the relevant API and adapter references before changing a contract.

## Task and objective naming

The database table and REST route use `issues`; the user interface calls these records Tasks. Objectives are backed by `goals`. See [the company API reference](../api/companies.md) and the domain-specific API guides.

## Company bundle imports

Company bundles use a versioned schema. Imports warn and continue when they encounter unknown sections so newer bundles can be inspected by older AoA installations without silently treating unknown content as known data.

## Discussion annotations

The `discussion_annotations` table and API remain deprecated compatibility stubs. The Thread surface `EntryRow` does not expose annotation actions; `DiscussionDetail` retains a separate entry renderer.
