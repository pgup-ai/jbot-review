# Blind adjudication fixture

`signals.example.jsonl` contains bounded finding and evidence text plus
metadata-only historical outcomes. Run
`npm run corpus:import-history -- --input <signals> --output <directory>` to
produce candidates and a treatment-blind batch. The blind batch retains only
the finding and evidence needed to adjudicate it; reply text, model identity,
and treatment identity do not belong in these files.

Ambiguous candidates require labels from two distinct adjudicators. Feed the
candidate and label JSONL files to `npm run corpus:adjudicate`; disagreements
are written separately and remain unresolved until humans agree.
