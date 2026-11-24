# GT import batch: worksheets and named mappings

This is a local review candidate. It builds on the previously applied import diagnostics and By Round changes; it is not a deployment or schema rollout. Do not preview files on a local app connected to the shared database: the final Preview still stages a batch and may discard an earlier staged batch for the same client/dataset.

## Behavior

- Upload CSV as before, or choose a worksheet from an `.xlsx` file. No sheet is selected for you. Hidden or unsupported worksheets cannot be selected. The selected sheet feeds the existing GT detector, mapping, validation and Preview/Commit path; inspection never stages a batch.
- Automatic and remembered mapping remains the default, side by side with editable fields. If detection cannot identify the dataset, choose it only after checking the diagnostics. Clarity retains its separate parser.
- Named profiles require a signed-in staff workspace and an active configured journey stage. The profile belongs to that exact client, source, and configured stage. Only an exact normalized header-layout match is suggested; nothing is applied or saved automatically. Update is explicit and checks the displayed revision. Date-order choices are automatic, day/month/year, or month/day/year.
- A material change to the stage's configuration or metric invalidates a profile binding. An identical GU re-sync does not. Profile use never replaces the source-wide legacy remembered mapping.
- Explicit reviewed mappings do not import extra columns as Form Answers. A contacts or Form Answers export that could be mistaken for new leads is refused. Reviewed mappings also cannot stage new unmatched rows, adopt existing queue entries, or supersede them, because those entries cannot safely replay the profile’s rules. Correct those rows and retry, or continue using legacy automatic mapping for exports it supports.
- The staged plan contains the selected worksheet, effective mapping, explicit date rule, and profile name/revision where used. Commit applies that plan, not a fresh profile lookup.

## Safe review checklist

1. Use a disposable isolated database or a mock adapter. Never apply a migration or press Preview/Commit against the shared project as part of QA.
2. Install the locked dependencies with `npm ci`. This candidate was developed for a Node 24 runtime (the parser tree requires at least Node 20.12).
3. Run `npm run typecheck` and `npm run build` with isolated credentials and synthetic fixtures. Use the same practice for the existing detection and By Round assertions.
4. For pure tests, generate safe workbooks in a temporary directory with `python3 scripts/generate-worksheet-fixtures.py <temp-path>`. Set `GT_WORKSHEET_FIXTURES=<temp-path>`, then run `npx --yes tsx@4 --test scripts/test-worksheets.mts scripts/test-mapping-profile.mts scripts/test-import-request.mts`.
5. In the isolated app, choose two differently populated worksheets and check the selected file only. Check equivalent CSV/XLSX results, renamed header correction, explicit date order, loose IDs stored as text, and profile save/inspect/select/update for two different stages. Check absence of reporting writes before Commit.
6. Profile storage is a draft SQL file in `supabase/migration-drafts/`, not an active migration. It remains disabled until separately reviewed, run in an approved isolated environment, and tested with signed-in staff. No automatic migration should be queued by applying this code patch.

Workbook import rejects macros, external references, encrypted archives, unsupported formats, formulas, merged cells, and excess input instead of guessing. If needed, export a clean CSV with identifiers kept as text and unambiguous dates. Hosted production requires login enforcement for workbook import; local dev follows existing staff/demo controls.
