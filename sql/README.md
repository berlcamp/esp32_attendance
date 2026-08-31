# SQL

The gate's tables live in the **`pta`** schema, alongside PTA Collections, on the
shared Supabase project `lvcbmopdstvupjpytjbb`. There is one roster and one
guardian list for both systems.

## Where the schema actually lives

**`../../pta-collections/supabase/migrations/0013_gate_attendance.sql`**

That file is the source of truth for every gate table, view, RLS policy and RPC.
It is *not* duplicated here, because the `pta` schema's version history belongs to
that repo — a second copy would be a second thing to keep in step, and it would
lose the argument the moment they disagreed.

Apply it by hand in the Supabase SQL Editor. Never `supabase db push`: the
project is shared with construction-saas and sms-demo, and a push proposes
dropping the other apps' objects.

## What is in this directory

| file | when |
|---|---|
| `cutover.sql` | **once.** Moves the gate off the old `mvts_esp32` schema: registers the device against a school, carries real attendance and linked guardians across, leaves the simulated data behind. Edit `c_school_code` at the top first. |
| `webhook.sql` | after the cutover, and whenever `WEBHOOK_SECRET` rotates. Installs the `pg_net` trigger that calls `notify-guardian` on each new scan. Carries a secret, so it is not a migration. |
| `test_bootstrap.sql` | test scaffolding — the `auth`, `storage` and role objects Supabase provides and a bare Postgres does not. Never run against Supabase. |
| `test_notify.sql` | the behavioural test suite: fan-out, staleness, retry, enrolment tokens, retention, and tenancy. |

## Running the tests

No board, no bot, no Supabase — just Docker. The real `pta` migrations are
loaded, so these tests fail if that schema drifts, which is the point.

```bash
docker run -d --rm --name gatepg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16
export PGPASSWORD=pw PTA=../../pta-collections/supabase/migrations
psql -h localhost -p 55433 -U postgres -v ON_ERROR_STOP=1 \
     -f sql/test_bootstrap.sql $(for f in $PTA/0*.sql; do echo -n "-f $f "; done) \
     -f sql/test_notify.sql
docker stop gatepg
```

A clean run ends in `--- all tests passed ---` after 21 checks.
