# Design decisions and their justification

These are proposed implementation choices, not claims about completed software.

| Choice | Reason | Evidence that could change the choice |
| --- | --- | --- |
| Define expected outcomes before coding | Makes the intended behavior concrete and exposes ambiguous requirements. | Faculty requirements or representative real records contradict the assumptions. |
| One small web application | Keeps the user journey and request-processing code together. Next.js is the initial framework proposal. | Hosting restrictions or the actual integration require a different runtime. |
| Deterministic checks for exact evidence | Known identifiers, allowed catalog entries, field completeness, and contradictions can be checked explicitly. | Reference data is incomplete or identifiers are unreliable. |
| AI for interpreting inconsistent descriptions and proposing candidates | This is a bounded language task that can be compared with keyword matching. | AI provides no useful improvement or causes unacceptable errors. |
| No initial clustering dependency | Grouping similar items does not, by itself, establish an exact destination or applicability. | A measured experiment shows clustering reduces useful review or labeling work. |
| Fictional, labeled examples first | Lets us build and demonstrate behavior without claiming access to private payroll data. | An authorized representative dataset becomes available. |
| GitHub for code and decisions | Version history makes the work reviewable and supports collaboration. | A faculty-mandated alternative is required. |
| Optional AWS S3 for files | Gives AWS a concrete role: storing supplied inputs and reports. It is not a source of private QuickBooks data. | The rubric requires another cloud capability or no persistent files are needed. |
| Targeted requests for missing facts | A missing distinguishing fact cannot be recovered reliably from an identical label and rate. | An authorized authoritative lookup can supply that fact automatically. |

## AI request and response contract

Send only the needed source fields, catalog candidates, and explicit instructions. Keep `evaluation/` out of application and model inputs: it contains expected answers.

The future API response should include candidate IDs drawn from the provided catalog or an explicit no-match result, the input fields supporting the suggestion, and unresolved questions. The server must validate allowed IDs and the underlying evidence. Generated prose is not an authoritative source. The application should construct factual validation explanations from recorded checks.

Structured output controls format; it does not prove correctness. Do not turn a model's self-reported confidence into a promise of accuracy. Do not generate or invent tax rates, agency codes, account credentials, or missing jurisdiction evidence.

Use one existing model through an API initially. This is inference with a pretrained model, not a claim that the team trained a proprietary model. Keep the model choice configurable and select it using actual examples, latency, and cost.

## Evaluation

Compare rules-only and rules-plus-AI on the same independently checked cases. Track correct automatic mappings, incorrect automatic mappings, unresolved items, suggestion usefulness, and time spent reviewing. Keep those measurements separate.

The fixtures in this starter are visible development examples. Do not report performance on them as generalization accuracy. With real evaluation data, hold out whole companies and assess unfamiliar descriptions and jurisdictions. Correct answers require independent verification rather than treating legacy configuration as automatically correct.

## Technical references

- GitHub repository concepts: https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories
- Next.js request handling: https://nextjs.org/docs/app/guides/backend-for-frontend
- OpenAI API authentication: https://developers.openai.com/api/reference/overview
- OpenAI structured outputs and limitations: https://developers.openai.com/api/docs/guides/structured-outputs
- Amazon S3 storage: https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html

These references explain service capabilities. They do not substantiate the fictional tax catalog or production suitability.
