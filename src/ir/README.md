# ir

Task **T1** · scope `src/ir/**` · intermediate representation, findings, mapping tables. **HOT**: post a CONTRACT before changing.

| File | What |
|---|---|
| `types.ts` | `Dashboard`, `Group`, `Panel`, `QuerySet`, `SourceQuery`, `Formula`, `Variable`, `Alert`, `IngestResult`. Query text stays in the vendor's language; T4 translates it. Layout is in **source** grid units (Datadog 12 columns). |
| `finding.ts` | `Status` = `exact` \| `exact-under` \| `bounded` \| `manual` (plan 03 §2), `worst()`, `reportLabel()` (→ exact / approximate / manual), `Finding`, `FINDING_CODES`, `Certificate`. |
| `mappings.ts` | Schema, strict parser and loader for `mappings/`. `kindTransform(m)` is the type rule: a Datadog RATE metric on an OTel counter needs `rate()` (D-18). |

Rules:
- Every non-exact item produces a `Finding`. Nothing is dropped without one.
- `exact-under` findings list their `assumptions`, and `bounded` findings give an `epsilon`.
- Mapping files are validated strictly: an unknown field, a bad status, or `otel: null` claiming `exact` all throw `MappingError`.
