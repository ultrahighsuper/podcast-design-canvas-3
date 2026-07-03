# Contributing

<!-- builderloops:contributing -->
## How to contribute to this repository

This product is built one step at a time by an automated maintainer that turns the product vision into a working product through your contributions. Read this before opening a pull request.

### Currently accepted
Current accepted work: the single open issue labeled `bl:active-step`. If no such issue is visible yet, wait for the maintainer to publish it before opening a PR.

Only implementation PRs that complete the current active step are accepted. Docs-only, planning-only, off-step, speculative, demo-only, mock-only, and unrelated PRs are closed even when the work is technically good.

### Work the one active step
At any moment there is exactly **one** open issue labeled `bl:active-step`. That issue is the only work being accepted right now. It describes what to build and a clear **Acceptance** (definition of done). Find it in this repo's Issues filtered by the `bl:active-step` label.

The maintainer acts like a hands-on product lead: it keeps the current goal focused, verifies behavior in the running product, and may replace a step with a prerequisite if repeated PRs show the target was missing a foundation.

### Open a pull request that completes that step
- Your PR must fully satisfy the active step's Acceptance, and reference it (for example, "Closes #<number>").
- Keep it focused: do that step and nothing unrelated.
- **One PR per contributor per step.** You may have only one open pull request for the active step, so put your best work into it. If you open a second PR for the same step, it is closed automatically. To revise your submission, push to your existing PR's branch (it is re-reviewed automatically) instead of opening another.

### Your PR is run, not just read
Every PR is checked out and executed in a sandbox: it must build, the existing tests must still pass, and the repo's acceptance checks (see `.builderloops/verify.json` if present) must pass. A PR that does not build, breaks tests, or fails acceptance is closed automatically. Make sure it genuinely works.

### What gets merged, what gets closed
- The best PR that completes the active step and passes review and execution is merged. When it merges, the step closes and the maintainer opens the next step.
- PRs that do something other than the active step are closed, even if the work is good. Wait until that work becomes the active step.
- A PR is merged only when it clearly completes the step and its benefit outweighs the added complexity; otherwise it is closed with a specific reason.

### Labels
This repo does not require Gittensor scoring labels on merged PRs. The maintainer may use operational labels such as active-step labels only for workflow control.
<!-- /builderloops:contributing -->
