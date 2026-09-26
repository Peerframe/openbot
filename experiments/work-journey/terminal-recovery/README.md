# Isolated mTLS terminal qualification

This probe imports the repository's integrated ProductWorkService /
OpenBotWork Worker, and existing scripted approval/effect fixtures. It does not implement a
Workflow, dispatcher or substitute model provider. Its model is the existing synthetic fixture;
no paid call or external account is used.

Run with the pinned Worker Python:

```
python -B experiments/work-journey/terminal-recovery/probe.py --repo /absolute/openbot --fixture /private/terminal.json --output /empty/private/output
```

The fixture must name an explicitly assigned loopback `openbot_control_test_terminal_<suffix>`
database, use canonical migrations and have no WorkTasks before the run. The probe reuses its
synthetic Owner token/Bot without printing credentials. No SQL history change is made. The
repository's three digest-pinned Temporal/Postgres images must already exist locally.

The probe starts a random owned Compose project and dedicated history volume, private freshly
issued mTLS credentials, one product Worker process at a time, and one synthetic loopback HTTP
effect service. Resource overlay caps Temporal at 1536 MiB / 2 CPUs, its PostgreSQL at 512 MiB /
1 CPU and the transient schema tool at 512 MiB / 1 CPU. It never stops the shared Control
PostgreSQL container or accesses other databases, projects, volumes, VPSes or installed apps.

Cases:

- TERMINATED: execute one approved synthetic write with lost response and malformed receipt,
  kill the product process while SQL is unknown, terminate the exact real engine Run, start a
  new ProductWorkService process, and verify one closure without new POST/claim/refund. Repair
  the synthetic receipt and use the existing Owner reconciliation/ClosedRepair protocol to
  settle by lookup only. The Task remains failed and the original terminal result is immutable.
- TIMED_OUT: same real unknown operation, but use a 35-second execution timeout and wait for
  an actual WORKFLOW_EXECUTION_TIMED_OUT event while the product process is stopped. Restart
  and verify identical closure invariants. No business timer is presented as engine timeout.
- Commit ACK loss: after actual hard termination, a test-only transaction wrapper pauses the
  service *after* terminal SQL commit but before returning. SIGKILL that process, start another
  service, and recover the exact original terminal result from real SDK proof and SQL receipt.
  The wrapper does not grant authority, fabricate history or change product logic.

All original histories and the Owner lookup history are then replayed offline through the
existing SDK Replayer, with snapshots and HTTP counters checked unchanged. Container/volume
identity is exact; `finally` shuts down that project, all owned Worker processes and the effect
server and deletes only tracked Task rows (including their own reconciliation rows). Evidence
records no certificate/key/config contents. Private run output must never be copied wholesale
into the repository; use only the sanitized evidence/history listed by the final result.

The first exploratory run completed hard termination and lookup but used an obsolete hardcoded
repair Workflow prefix when fetching history. That probe-only error is corrected to import the
product `PREFIX`. Its cleanup also initially omitted reconciliation foreign-key deletion order;
cleanup was completed and independently verified before the successful run. Product files were
unchanged throughout this qualification.
