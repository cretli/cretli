# Todos backend benchmark

Generated: 2026-10-29T19:09:59.305Z. Command: `node scripts/benchmark-todos.js`.

**Cutover BLOCKED.** The default SQLite facade cannot execute the required
50-row / 22302149-byte fixture: first no-op read fails with
`io/result_too_large` (worker result limit 4 MiB). No production limit or wiring was
changed. The fixture was seeded with the verified offline migration, because a
full-document worker import also exceeds the request limit. The refusal is a
real L4 backend blocker; unexecuted gates below FAIL certification, not fabricated
latency values. Production remains unchanged.

CPU: Intel(R) Core(TM) i7-14700KF; logical CPUs: 28; RAM: 25196240896 bytes;
platform: linux x64 6.6.114.1-microsoft-standard-WSL2; Node: v22.23.4; SQLite: 3.53.4.
Fixture hash (identical in both backends): a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a.
Synthetic L2-size equivalent; the historical L2 fixture is unavailable.

JSON completed 1000 no-ops, 1000 changes (first 20 for
ACK latency), list/detail, CAS refusal, watcher claim, two-workspace move and burst
200. SQLite completed 0 no-ops, 0
changes and 0 lists. Histogram resolution: 1 ms. API latency
uses performance.now(). Physical bytes use Linux write_bytes; worker-thread
counters isolate SQLite from main-thread overlay writes. These counters measure
block writes, not syscall byte counts; DB+WAL footprint is reported separately
when a workload completes. No thresholds were lowered.

| Gate | Value | Limit | Result |
| --- | --- | --- | --- |
| Changed write ACK p95 / p99 ms | unavailable: io/result_too_large; workload did not complete | 120 / 250 | FAIL |
| Worker queue + execute p95 / p99 ms | unavailable: io/result_too_large; workload did not complete | 80 / 180 | FAIL |
| Indexed list 50 rows p95 / p99 ms | unavailable: io/result_too_large; workload did not complete | 40 / 90 | FAIL |
| Event loop p99 / max ms at 1 ms | unavailable: io/result_too_large; workload did not complete | 25 / 100 | FAIL |
| Steady queue age p95 ms | unavailable: io/result_too_large; workload did not complete | 200 | FAIL |
| Burst 200 max ms | unavailable: io/result_too_large; workload did not complete | 2000 | FAIL |
| Stop/claim/final priority wait ms | unavailable: io/result_too_large; workload did not complete | 500 | FAIL |
| 1000 changes DB+WAL written bytes / JSON | unavailable: io/result_too_large; workload did not complete | 0.25 | FAIL |
| No-op bytes | unavailable: io/result_too_large; workload did not complete | 0 | FAIL |
| Checkpoint p99 ms | unavailable: io/result_too_large; workload did not complete | 500 | FAIL |
| Group commit batch bytes / ms | unavailable: io/result_too_large; workload did not complete | 262144 / 40 | FAIL |
| Todos JSON writes | unavailable: io/result_too_large; workload did not complete | 0 | FAIL |
| Full main-thread document serializations | unavailable: io/result_too_large; workload did not complete | 0 | FAIL |
| Todos JSON stringifyMs SQLite / JSON | unavailable: io/result_too_large; workload did not complete | 0.01 | FAIL |
| CAS / watcher claim / two-workspace move / COMMIT loss | unavailable: io/result_too_large; workload did not complete | all correct | FAIL |
| Count / logical export hash after workload | unavailable: io/result_too_large; workload did not complete | equal | FAIL |

The SQLite todos-key counters at refusal are {"writes":0,"bytes":0,"stringifyMs":0,"ioMs":0,"maxMs":0};
JSON stringifyMs is 93436.47. The apparent zero SQLite/JSON ratio
**cannot certify the <=1% gate** because SQLite did not execute the same workload.
All unavailable gates above are recorded cutover blockers. Full-document
materialization/diff serialization in the facade is an additional known blocker.

## Copy rehearsal

PASS: copied synthetic fixture, verified byte hash, migration to SQLite,
workspace/item/canonical-hash verification, one new durable post-import ACK,
clean close, logical export with receipts/fence, export verification, rollback
activation, sidecar-aware runtime read. Post-cutover ACK preserved.
Manifest: f6280ef074a7cfca2f417cbab7a0f1d46f5d8957535bd8278c645978ded7c715.
Verification canonical hash: c8e720f6aebbcb4550fe894035cb153908e2b48c8d15ef844e25f033214c2f7f.
The small post-import worker command works; the full-document facade read is what
fails. This was a synthetic data copy in OS temp, not a production backup.
Temporary files are removed by the command after reporting.

## Actual measurements

```json
{
  "json": {
    "kind": "json",
    "fixtureBytes": 22302149,
    "fixtureHash": "a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a",
    "logicalExportHash": "dd4600a775c272c8a365865b0bf95e32b71f42b3a28081ab249be5da1597c1f5",
    "counts": {
      "noop": 1000,
      "changes": 1000,
      "bytes": 22300000
    },
    "stats": {
      "writes": 2203,
      "bytes": 49019463262,
      "stringifyMs": 93436.47,
      "ioMs": 41873.87,
      "maxMs": 310.99
    },
    "noopBytes": 22302732288,
    "noopWorkerBytes": 0,
    "changeBytes": 22302720000,
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
    "bytesPerChange": 22302720,
    "writes": {
      "n": 20,
      "p95": 59.864221999996516,
      "p99": 61.06910199999402,
      "max": 61.06910199999402
    },
    "allChanges": {
      "n": 1000,
      "p95": 64.85734600000433,
      "p99": 75.85415800000192,
      "max": 311.4213269999891
    },
    "noop": {
      "n": 1000,
      "p95": 64.6735030000018,
      "p99": 78.11305800000082,
      "max": 292.8957279999995
    },
    "list": {
      "n": 20,
      "p95": 0.020852999994531274,
      "p99": 0.129480000003241,
      "max": 0.129480000003241
    },
    "indexedList": {
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "detail": {
      "n": 20,
      "p95": 0.04826100000354927,
      "p99": 0.04967600000964012,
      "max": 0.04967600000964012
    },
    "claim": {
      "n": 1,
      "p95": 195.67588299998897,
      "p99": 195.67588299998897,
      "max": 195.67588299998897
    },
    "burst": {
      "n": 200,
      "p95": 11971.039333000008,
      "p99": 12435.436625999995,
      "max": 12552.231647000008
    },
    "eventLoop": {
      "resolutionMs": 1,
      "p99": 136566.538239,
      "max": 136566.538239
    },
    "checkpoints": {
      "n": 0,
      "p95": null,
      "p99": null,
      "max": null
    },
    "dbBytes": null,
    "workerLoss": "not applicable (no worker)",
    "rehearsal": null
  },
  "sqlite": {
    "kind": "sqlite",
    "fixtureBytes": 22302149,
    "fixtureHash": "a71f2fb7bd52d307d7d38b4739938d82cbfaf4e86fdaba2a81cf9ec9ca65f75a",
    "counts": {
      "noop": 1000,
      "changes": 1000,
      "bytes": 22300000
    },
    "rehearsal": {
      "migration": "sqlite",
      "verification": {
        "workspaces": 2,
        "items": 50,
        "canonicalHash": "c8e720f6aebbcb4550fe894035cb153908e2b48c8d15ef844e25f033214c2f7f"
      },
      "rollback": "legacy-rollback",
      "manifestHash": "f6280ef074a7cfca2f417cbab7a0f1d46f5d8957535bd8278c645978ded7c715",
      "postAckPreserved": true
    },
    "runtimeFailure": {
      "code": "io",
      "operation": "result_too_large",
      "commitState": "not_committed"
    },
    "completed": {
      "noop": 0,
      "changes": 0,
      "list": 0
    },
    "stats": {
      "writes": 0,
      "bytes": 0,
      "stringifyMs": 0,
      "ioMs": 0,
      "maxMs": 0
    },
    "metrics": {
      "state": "ready",
      "generation": 1,
      "restarts": 0,
      "startAttempts": 0,
      "lastStart": {
        "spawnToReadyMs": 35.68933300000026,
        "registryMs": 2.188035000000127,
        "openMs": 5.3954990000002,
        "barrierMs": 0.08425400000032823,
        "threadOverheadMs": 28.021544999999605
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
          "enqueued": 2,
          "dispatched": 2,
          "bypassed": 0,
          "rejectedBusy": 0,
          "rejectedTooLarge": 0,
          "expired": 0,
          "removed": 0
        },
        "queueAgeMs": {
          "n": 2,
          "p50": 0.005999999999858119,
          "p95": 0.02260599999999613,
          "p99": 0.02260599999999613,
          "max": 0.02260599999999613
        }
      },
      "executeMs": {
        "n": 2,
        "p50": 0.5401779999997416,
        "p95": 64.82649300000003,
        "p99": 64.82649300000003,
        "max": 64.82649300000003,
        "sum": 65.36667099999977
      },
      "requestMs": {
        "n": 2,
        "p50": 0.8492049999999836,
        "p95": 65.00941599999987,
        "p99": 65.00941599999987,
        "max": 65.00941599999987,
        "sum": 65.85862099999986
      },
      "counters": {
        "completed": 1,
        "failed": 1,
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
          "dispatched": 2,
          "waitTotalMs": 0.07195400000000518,
          "waitMaxMs": 0.06622500000003129
        }
      }
    }
  }
}
```
