# F5 backup initialization attribution — diagnostic result

**Later disposition:** The approved [F5 repair and full qualification](f5-repair-results.md) are complete and passing. The dated record below is historical evidence, not the current execution status.

**September 13, 2026. Diagnostic complete; no source correction or baseline acceptance.** The single authorized full-shard diagnostic passed: **6,043 tests passed, three unchanged skips, zero failures**. Both original backup/restore assertions ran and passed. The 6,046 test identities exactly match the [previous failed shard](full-baseline-qualification-results.md). This successful instrumented sample does not replace that failed qualification.

## What was measured

| Phase | Duration |
|---|---:|
| Complete setup (first directory through seed-client close) | 3.334 seconds |
| PostgreSQL initialization | 3.081 seconds |
| Server start | 0.082 seconds |
| Database creation | 0.129 seconds |
| Teardown stop | 1.904 seconds |

Initialization consumed about 92% of setup. The original ten-second setup hook and thirty-second teardown hook remained unchanged. No backup assertion, port choice, PostgreSQL option, worker concurrency, test selection or skip condition was relaxed.

Direct stage records identify fixture process 146. Its `initdb` child 390 was sampled in uninterruptible sleep: twice in `jbd2_log_wait_commit`, then in `submit_bio_wait`. At the latter two samples, eight and nine other `initdb` processes were present; several showed the same waits. These are concrete filesystem journal/block-I/O waits during this successful initialization, rather than a server-readiness or seed-query stall.

No cgroup CPU throttling or OOM events occurred in this sample. CPU and memory limits reported `max`; that does not establish unlimited Docker VM or host resources. Cgroup I/O pressure was present but is aggregate, not target-specific attribution. Zero process block-delay counters do not override the observed wait channels. Sampling once per second cannot measure exact time in each wait. The 114 resource samples cost about 119 ms in total, at most 4.7 ms each; instrumentation and warm caches can still affect timing.

**Conclusion:** initialization has variable storage latency under concurrent database setup. Storage contention is the leading explanation for the earlier timeout, supported by direct waits here and the earlier final `syncing data to disk ...` output. The ten-second failure itself did not recur, so its exact delay and eventual completion time remain unknown. This is evidence of an unreliable test startup boundary, not evidence that production backup/restore is broken, and not proof of a permanent PostgreSQL hang.

The installed embedded-Postgres initializer spawns `initdb` with its default empty extra flags and waits for child exit; that initialization path supplies no deadline or cancellation signal. PostgreSQL normally synchronizes the newly created files before returning; its default synchronization method is `fsync`. See [PostgreSQL 18 initdb documentation](https://www.postgresql.org/docs/18/app-initdb.html). No synchronization option was changed.

## Scope and reproducibility

- Exact input: local correction commit `4aebfa0f4aaf011cfd85347246c18d3cbde305ba`, retained checkout and built prerequisites from the failed full run; not a fresh cold install. SDK export preflight passed again. No network, install, build or upstream adoption.
- Same immutable Node image, UID/GID 1000, allowlisted environment and task volume as the full run; no host repository/home/socket mount. One invocation of `vitest run --shard=4/4` with the same default/JSON reporters, original timeout and concurrency. Command duration approximately 112.7 seconds; outer 15-minute test bound not reached.
- Temporary instrumentation affected only the backup test in the isolated runtime: thirteen stage wrappers with direct timestamp logging. Both test bodies were checked byte-for-byte against the original. Resource sampling read process and cgroup counters without collecting environment or command-line credentials.
- All 7,666 tracked entries matched the pristine snapshot before instrumentation. The instrumented tree remained unchanged throughout testing. Original source was restored and all 7,666 entries verified again. Container is stopped and disconnected. Host source correction branches, Universe application source and the premature draft were untouched.

Evidence: [summary and target process samples](evidence/f5-attribution-2026-09-13/summary.json), [stage records](evidence/f5-attribution-2026-09-13/stages.jsonl), [resource samples](evidence/f5-attribution-2026-09-13/resources.jsonl.gz), [complete shard log](evidence/f5-attribution-2026-09-13/shard4.log.gz), [test report](evidence/f5-attribution-2026-09-13/tests.json.gz), [instrumentation patch](evidence/f5-attribution-2026-09-13/instrumentation.patch.gz), [runner](evidence/f5-attribution-2026-09-13/run.mjs), [hash manifest](evidence/f5-attribution-2026-09-13/manifest.json). Runtime manifests, export gate and attempt/result records are retained alongside these. Raw logs remain in the task's local diagnostic folder.

## Recommended next step

**Follow-up prepared:** the [F5 fixture correction plan](f5-fixture-correction-plan.md) now defines exact files, code, deadlines, regression tests and execution bounds. Source is not yet authored.

Prepare one **fixture-only startup/lifecycle correction** for review: give database initialization an explicit bounded startup policy, report the failing stage, and own cleanup even if initialization or start completes after the caller times out. Preserve real backup assertions, default disk synchronization, global timeouts and concurrency. A larger startup allowance alone would not establish cancellation or cleanup correctness. Choose its finite budget as an explicit engineering policy with the observed timing range and CI limits recorded; this successful sample does not prove a sufficient worst-case budget.

Review the concrete correction and deterministic late-completion/cleanup checks before authoring source. Then qualify the clean corrected commit with typecheck, the complete test suite and gated build. No repeated unchanged green-seeking diagnostic is recommended. This is a narrow engineering follow-up, not another review of all Universe epics.

**Readiness:** this diagnostic allowance is complete. A fixture source correction, new full qualification, replatform landing/base adoption and Universe implementation have not been performed or newly authorized. Typecheck and build were not repeated in this diagnostic; prior typecheck passed and prior build remains withheld. The plan is ready to guide implementation; the baseline remains unaccepted.

**Author review:** reconciled test identities and skips, stage/process ownership, measurement limits, tracked-tree restoration and evidence hashes. No independent review is claimed.
