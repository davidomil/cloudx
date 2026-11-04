# Serialization and image fixtures

New blackboards always start with an empty canvas. Scene editing, feedback and WIP tests create their data through normal board operations.

[blackboard.schema.json](blackboard.schema.json) records the original snapshot design. The current runtime contract is [cooperationBoardSchema.json](../../../../packages/shared/src/cooperationBoardSchema.json), with operations and input types in [cooperation.ts](../../../../packages/shared/src/cooperation.ts).

[assets/reference.png](assets/reference.png) is an original image fixture for browser, asset-retention and native-provider image tests. It remains here so those tests can verify exact original bytes and native image access. It is not a bundled creation seed. The original scene snapshots and generated template concepts have been removed.
