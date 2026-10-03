# Frozen participation protocol fixtures (test-only)

`participation/` and `state-sequences/` are frozen pure-protocol test data —
participation descriptors, invalid-case matrices and state sequences — copied
unchanged from the private world-sdk protocol fixture set at fixed client
e75380b6 (the world-sdk package itself is not distributed here). These keep the
active participation-descriptor validation (action-wire's attachment checks)
covered from a clean checkout; the retired automatic-turn engine cases remain
classified as unsupported scope.

Source SHA-256 (world-sdk originals at e75380b6):

- participation/invalid-cases.json   ef0c4e14cc2b48ad19a220a846c12e3ed45ec57037b007d1dc8cc32f70a25573
- participation/reading-window-wk8.json  40a6e99d898434c8787912ccee6cd29fdcd17d98e060bc0b4f56f71695643b3a
- participation/train-window-w42.json    4a18f7b93c7bc28039a910351e3b801f1ec0908c78625df1a66fb79e09f9901b
- state-sequences/reading-parity.json   000b9e28bc10b8afb5e8961563ab1c5ddf089c3042435642b3fdcc892ce2254c
- state-sequences/train-t1-t14.json     caac8f90ab05b5302ed97a13709ddbdf18f61842c01d889bc28546753cb61145
