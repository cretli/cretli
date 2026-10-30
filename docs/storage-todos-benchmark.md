# Todos backend benchmark

Generated: 2026-10-30T02:29:22.999Z. Command: `node scripts/benchmark-todos.js`. Full workload.

CPU: Intel(R) Core(TM) i7-14700KF; logical CPUs: 28; RAM: 25196240896 bytes; platform: linux x64 6.6.114.1-microsoft-standard-WSL2; Node: v22.23.4; SQLite: 3.53.4. No host/user names recorded.

50 rows, 22302149 JSON bytes; 1000 no-op updates (duplicate chat link: resolved by the domain layer without a write), 20 measured changed writes plus 980 for the byte workload, list/detail, CAS refusal, watcher claim, two-workspace move, burst 200, worker exit after COMMIT. Fresh independent backends use identical fixture hash a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a. L2 historical fixture is unavailable; this is a synthetic equivalent, not a historical comparison.

Histogram resolution: 1 ms. API ACK uses performance.now(); host metrics (steadyMetrics: requestMs, queueAgeMs) are percentiles over a bounded rolling sample (last 4096 requests) snapshotted once right after the changed-write phase, not over the whole workload; every gate row below reads that same single snapshot embedded in the raw measurements. Worker request time includes queue, execute and reply; execute and queue metrics are included below. Physical process write_bytes includes overlay and lock writes; DB+WAL footprint is not bytes written. Linux non-main-thread write_bytes isolates worker writes (DB/WAL, including checkpoint writes) during the change window; the JSON denominator is total process write_bytes (including lock overhead). This is physical block accounting, not a syscall byte tracer. Batch metrics measure facade transaction batches including queue/reply; independent-command group commit is not enabled. Stop/claim/final probes are worker ping requests submitted alongside the burst, not application Stop commands. Scratch JSON writes outside the configured root are excluded from getWriteStats todos keys; the full-document serialization gate counts overlay materializations and overlay reads of the SQLite facade.

| Gate | Value | Limit | Result |
| --- | --- | --- | --- |
| API changed write ACK ms p95 | 494.27637400000003 | 120 | FAIL |
| API changed write ACK ms p99 | 505.3376559999997 | 250 | FAIL |
| Worker queue + execute + reply ms (conservative) p95 | 19.681634000036865 | 80 | PASS |
| Worker queue + execute + reply ms (conservative) p99 | 20.94929499999853 | 180 | PASS |
| Indexed list 50 rows ms p95 | 13.433346999983769 | 40 | PASS |
| Indexed list 50 rows ms p99 | 14.154833999986295 | 90 | PASS |
| Event loop p99 ms | 2.109439 | 25 | PASS |
| Event loop max ms | 357.564415 | 100 | FAIL |
| Steady queue age p95 ms | 0.0030539999715983868 | 200 | PASS |
| Burst 200 API completion max ms (includes queue) | 97456.964722 | 2000 | FAIL |
| Watcher claim ms | 213.23248399997829 | 500 | PASS |
| Stop/claim/final worker priority ACK ms (includes wait) | 0.3830970000126399 | 500 | PASS |
| 1000 changes DB+WAL worker write_bytes / JSON process write_bytes | 0.008995590634418616 | 0.25 | PASS |
| No-op physical write bytes (measured 1000-no-op window only; includes overlay) | 0 | 0 | PASS |
| Checkpoint p99 ms | 5.284252000041306 | 500 | PASS |
| Transaction batch payload bytes (no group commit enabled) | 1614748 | 262144 | FAIL |
| Transaction batch ACK max ms (includes queue/reply) | 151.02439400000003 | 40 | FAIL |
| Todos JSON writes (getWriteStats) | 0 | 0 | PASS |
| Full document main-thread serializations (overlay materialize + overlay read) | 2411 | 0 | FAIL |
| Todos JSON stringifyMs SQLite / JSON | 0 | 0.01 | PASS |
| Logical export content/order hash equality | 8192af1213b4f465d4aaf0226bd6201a8deb1127decb69bbeb444b56b15e7844 / a3ee26f2094379a5e2145179795dc898333d8c343af1d441702e1663ddf3ad3b | equal | FAIL |
| CAS / counts / receipt reconciliation | PASS: committed receipt resolved; same command replayed exactly once | correct | PASS |

## Cutover blockers

- API changed write ACK ms p95: 494.27637400000003
- API changed write ACK ms p99: 505.3376559999997
- Event loop max ms: 357.564415
- Burst 200 API completion max ms (includes queue): 97456.964722
- Transaction batch payload bytes (no group commit enabled): 1614748
- Transaction batch ACK max ms (includes queue/reply): 151.02439400000003
- Full document main-thread serializations (overlay materialize + overlay read): 2411
- Logical export content/order hash equality: 8192af1213b4f465d4aaf0226bd6201a8deb1127decb69bbeb444b56b15e7844 / a3ee26f2094379a5e2145179795dc898333d8c343af1d441702e1663ddf3ad3b

No thresholds were lowered. These failures block cutover. Production wiring is unchanged.

## Copy rehearsal

Verified fixture copy -> migration -> count/canonical-hash verification -> new durable ACK -> clean worker close -> logical export with receipts/fence -> verification -> rollback activation -> sidecar-aware runtime read: PASS. Post-cutover ACK preserved. Export manifest: 902a210e79a5176c6e4b23820dd35d82e1116bece8ed7450996d64f1dd627cff. This is a synthetic data-copy rehearsal in OS temp, not a production backup rehearsal. Temporary files are removed after reporting.

## Raw measurements

```json
{
  "json": {
    "kind": "json",
    "fixtureBytes": 22302149,
    "fixtureHash": "a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a",
    "logicalExportHash": "a3ee26f2094379a5e2145179795dc898333d8c343af1d441702e1663ddf3ad3b",
    "counts": {
      "noop": 1000,
      "changes": 1000,
      "bytes": 22300000
    },
    "stats": {
      "writes": 1204,
      "bytes": 26740058116,
      "stringifyMs": 53517.16,
      "ioMs": 22668.94,
      "maxMs": 71.55
    },
    "noopBytes": 0,
    "noopWorkerBytes": 0,
    "changeBytes": 22302724096,
    "changeWorkerBytes": 0,
    "batches": {
      "count": 0,
      "maxBytes": 0,
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "priorityProbe": {
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "bytesPerChange": 22302724.096,
    "writes": {
      "n": 20,
      "p95": 63.53662499999996,
      "p99": 65.57365499999992,
      "max": 65.57365499999992
    },
    "allChanges": {
      "n": 1000,
      "p95": 67.42602800000168,
      "p99": 69.41735700000027,
      "max": 70.47844899999836
    },
    "noop": {
      "n": 1000,
      "p95": 0.02901400000001786,
      "p99": 0.06734799999998131,
      "max": 2.070003999999983
    },
    "list": {
      "n": 20,
      "p95": 0.015242000001308043,
      "p99": 0.1673609999998007,
      "max": 0.1673609999998007
    },
    "indexedList": {
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "detail": {
      "n": 20,
      "p95": 0.013036999996984378,
      "p99": 0.07503999999607913,
      "max": 0.07503999999607913
    },
    "claim": {
      "n": 1,
      "p95": 226.9475919999968,
      "p99": 226.9475919999968,
      "max": 226.9475919999968
    },
    "burst": {
      "n": 200,
      "p95": 12075.489604000002,
      "p99": 12579.374294000001,
      "max": 12707.461185999993
    },
    "eventLoop": {
      "resolutionMs": 1,
      "p99": 77108.084735,
      "max": 77108.084735
    },
    "checkpoints": {
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "dbBytes": null,
    "workerLoss": "not applicable (no worker)",
    "rehearsal": null,
    "facadeWork": null
  },
  "sqlite": {
    "kind": "sqlite",
    "fixtureBytes": 22302149,
    "fixtureHash": "a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a",
    "logicalExportHash": "8192af1213b4f465d4aaf0226bd6201a8deb1127decb69bbeb444b56b15e7844",
    "counts": {
      "noop": 1000,
      "changes": 1000,
      "bytes": 22300000
    },
    "stats": {
      "writes": 0,
      "bytes": 0,
      "stringifyMs": 0,
      "ioMs": 0,
      "maxMs": 0
    },
    "noopBytes": 0,
    "noopWorkerBytes": 0,
    "changeBytes": 44791988224,
    "changeWorkerBytes": 200626176,
    "batches": {
      "count": 1203,
      "maxBytes": 1614748,
      "n": 1203,
      "p95": 12.379795000015292,
      "p99": 17.702827999950387,
      "max": 151.02439400000003
    },
    "priorityProbe": {
      "n": 3,
      "p95": 0.3830970000126399,
      "p99": 0.3830970000126399,
      "max": 0.3830970000126399
    },
    "bytesPerChange": 44791988.224,
    "writes": {
      "n": 20,
      "p95": 494.27637400000003,
      "p99": 505.3376559999997,
      "max": 505.3376559999997
    },
    "allChanges": {
      "n": 1000,
      "p95": 526.7901759999804,
      "p99": 543.4843209999963,
      "max": 633.4692829999985
    },
    "noop": {
      "n": 1000,
      "p95": 0.28493299999990995,
      "p99": 0.37423200000012,
      "max": 1.0356310000006488
    },
    "list": {
      "n": 20,
      "p95": 21.489361999963876,
      "p99": 414.89074599999003,
      "max": 414.89074599999003
    },
    "indexedList": {
      "n": 20,
      "p95": 13.433346999983769,
      "p99": 14.154833999986295,
      "max": 14.154833999986295
    },
    "detail": {
      "n": 20,
      "p95": 1.9658289999933913,
      "p99": 2.110655000025872,
      "max": 2.110655000025872
    },
    "claim": {
      "n": 1,
      "p95": 213.23248399997829,
      "p99": 213.23248399997829,
      "max": 213.23248399997829
    },
    "burst": {
      "n": 200,
      "p95": 92444.44829999999,
      "p99": 96467.22135,
      "max": 97456.964722
    },
    "eventLoop": {
      "resolutionMs": 1,
      "p99": 2.109439,
      "max": 357.564415
    },
    "checkpoints": {
      "n": 20,
      "p95": 0.21787900000344962,
      "p99": 5.284252000041306,
      "max": 5.284252000041306
    },
    "steadyMetrics": {
      "state": "ready",
      "generation": 1,
      "restarts": 0,
      "startAttempts": 0,
      "lastStart": {
        "spawnToReadyMs": 33.53685600000017,
        "registryMs": 2.2882880000001933,
        "openMs": 5.15070199999991,
        "barrierMs": 0.08143999999992957,
        "threadOverheadMs": 26.016426000000138
      },
      "inFlight": false,
      "inFlightAgeMs": 0,
      "queue": {
        "depth": 0,
        "bytes": 0,
        "maxDepth": 1024,
        "maxBytes": 16777216,
        "maxAgeMs": 5000,
        "agingMs": 250,
        "bypassEvery": 4,
        "depthByPriority": {
          "stop": 0,
          "claim": 0,
          "intent": 0,
          "final": 0,
          "normal": 0
        },
        "oldestAgeMs": 0,
        "counters": {
          "enqueued": 29031,
          "dispatched": 29031,
          "bypassed": 0,
          "rejectedBusy": 0,
          "rejectedTooLarge": 0,
          "expired": 0,
          "removed": 0
        },
        "queueAgeMs": {
          "n": 4096,
          "p50": 0.0018070000223815441,
          "p95": 0.0030539999715983868,
          "p99": 0.004342000000178814,
          "max": 0.016232999972999096
        }
      },
      "executeMs": {
        "n": 4096,
        "p50": 10.361883999954443,
        "p95": 19.18745600001421,
        "p99": 20.495236000046134,
        "max": 23.263982000004034,
        "sum": 42550.82603100239
      },
      "requestMs": {
        "n": 4096,
        "p50": 10.858262000023387,
        "p95": 19.681634000036865,
        "p99": 20.94929499999853,
        "max": 23.713726999994833,
        "sum": 44407.49766700086
      },
      "counters": {
        "completed": 29031,
        "failed": 0,
        "unknownCommit": 0,
        "workerLost": 0,
        "expired": 0,
        "aborted": 0,
        "rejectedBusy": 0,
        "rejectedInvalid": 0,
        "dispatchFailed": 0,
        "expiryRetried": 0
      },
      "byPriority": {
        "stop": {
          "expired": 0,
          "dispatched": 0,
          "waitTotalMs": 0,
          "waitMaxMs": 0
        },
        "claim": {
          "expired": 0,
          "dispatched": 0,
          "waitTotalMs": 0,
          "waitMaxMs": 0
        },
        "intent": {
          "expired": 0,
          "dispatched": 0,
          "waitTotalMs": 0,
          "waitMaxMs": 0
        },
        "final": {
          "expired": 0,
          "dispatched": 0,
          "waitTotalMs": 0,
          "waitMaxMs": 0
        },
        "normal": {
          "expired": 0,
          "dispatched": 29031,
          "waitTotalMs": 102.64719700216892,
          "waitMaxMs": 0.18399099999805912
        }
      }
    },
    "metrics": {
      "state": "ready",
      "generation": 2,
      "restarts": 1,
      "startAttempts": 0,
      "lastStart": {
        "spawnToReadyMs": 35.75126599997748,
        "registryMs": 2.3841259999899194,
        "openMs": 5.902490000007674,
        "barrierMs": 0.08865599997807294,
        "threadOverheadMs": 27.37599400000181
      },
      "inFlight": false,
      "inFlightAgeMs": 0,
      "queue": {
        "depth": 0,
        "bytes": 0,
        "maxDepth": 1024,
        "maxBytes": 16777216,
        "maxAgeMs": 5000,
        "agingMs": 250,
        "bypassEvery": 4,
        "depthByPriority": {
          "stop": 0,
          "claim": 0,
          "intent": 0,
          "final": 0,
          "normal": 0
        },
        "oldestAgeMs": 0,
        "counters": {
          "enqueued": 34817,
          "dispatched": 34817,
          "bypassed": 0,
          "rejectedBusy": 0,
          "rejectedTooLarge": 0,
          "expired": 0,
          "removed": 0
        },
        "queueAgeMs": {
          "n": 4096,
          "p50": 0.0022669999161735177,
          "p95": 0.005630000028759241,
          "p99": 0.007427999982610345,
          "max": 41.21179199998733
        }
      },
      "executeMs": {
        "n": 4096,
        "p50": 9.967032999964431,
        "p95": 18.589147999999113,
        "p99": 20.034125000005588,
        "max": 22.53451300004963,
        "sum": 40666.0664100016
      },
      "requestMs": {
        "n": 4096,
        "p50": 10.413456000038423,
        "p95": 19.051824999973178,
        "p99": 20.483012999990024,
        "max": 41.88384599995334,
        "sum": 42423.889103000634
      },
      "counters": {
        "completed": 34816,
        "failed": 1,
        "unknownCommit": 1,
        "workerLost": 1,
        "expired": 0,
        "aborted": 0,
        "rejectedBusy": 0,
        "rejectedInvalid": 0,
        "dispatchFailed": 0,
        "expiryRetried": 0
      },
      "byPriority": {
        "stop": {
          "expired": 0,
          "dispatched": 1,
          "waitTotalMs": 0.005776999983936548,
          "waitMaxMs": 0.005776999983936548
        },
        "claim": {
          "expired": 0,
          "dispatched": 1,
          "waitTotalMs": 0.15468300000065938,
          "waitMaxMs": 0.15468300000065938
        },
        "intent": {
          "expired": 0,
          "dispatched": 0,
          "waitTotalMs": 0,
          "waitMaxMs": 0
        },
        "final": {
          "expired": 0,
          "dispatched": 1,
          "waitTotalMs": 0.2513829999952577,
          "waitMaxMs": 0.2513829999952577
        },
        "normal": {
          "expired": 0,
          "dispatched": 34814,
          "waitTotalMs": 172.59845900119626,
          "waitMaxMs": 41.217250999994576
        }
      }
    },
    "dbBytes": 23498952,
    "workerLoss": "PASS: committed receipt resolved; same command replayed exactly once",
    "rehearsal": {
      "migration": "sqlite",
      "verification": {
        "workspaces": 2,
        "items": 50,
        "canonicalHash": "05a70b7bece42da5f0be580ab57a355cde7d4cca70383f8a7d4fc44704c4f2f8"
      },
      "rollback": "legacy-rollback",
      "manifestHash": "902a210e79a5176c6e4b23820dd35d82e1116bece8ed7450996d64f1dd627cff",
      "postAckPreserved": true
    },
    "facadeWork": {
      "pagedExports": 1206,
      "exportPages": 30102,
      "scratchWrites": 1209,
      "overlayReads": 1202,
      "noopCommands": 1001,
      "committedCommands": 1202
    }
  }
}
```
