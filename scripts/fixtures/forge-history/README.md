# Historical Forge migration fixtures

These fixtures preserve migration inputs from development commits that are
absent from normal full-history clones. Tests run offline against retained main
history and these checked-in sources.

`previous-integration.mjs` is the unmodified
`scripts/managed-update-forge-integration.mjs` from
[`540da2c42c380a7ca75c13ffe8c2c9d5ba71164f`](https://github.com/davidomil/cloudx/blob/540da2c42c380a7ca75c13ffe8c2c9d5ba71164f/scripts/managed-update-forge-integration.mjs).
Its Git blob is `0a5ac0720a046e56329c217af1ea6cf6261ae2bc`. It produces the
previously integrated targets used to verify that current integration adds
review continuation without replacing their other behavior.

`native-historical-drafts.patch` applies to retained main commit
`2f28a100cd765b8c209e85fdacb03b03a57ba0df`. It reproduces the service and
validation sources from
[`7604d8d501177d0fd7ea04443c66020de751a1f2`](https://github.com/davidomil/cloudx/tree/7604d8d501177d0fd7ea04443c66020de751a1f2/apps/server/src/forge).
That state already reads historical drafts and selects the latest reviewer,
but cannot continue a review whose workspace was cleaned. The runtime is
unchanged from the retained base.

The fixture helper applies and commits the patch only in its disposable clone
before running integration. This establishes the historical baseline so the
updater's protection against operator edits remains active. The integration
suite verifies the original runtime, service, validation and prior-integrator
Git blob identities before exercising migrations. Keep these archived inputs
unchanged when changing the production integration.
