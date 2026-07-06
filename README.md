# lesiw.io/proc field guide

A condensed reference for working with proc, written for coding
agents and quick lookup. The visual tour lives at
[procfunc.io](https://procfunc.io/); the API reference at
[pkg.go.dev/lesiw.io/proc](https://pkg.go.dev/lesiw.io/proc). The
examples here compile against the library; the closing quick
reference is signatures, not a program.

## The mental model

- A **body** is a `func(ctx context.Context) error`. It honors its
  ctx, surfaces failures as returned errors, and keeps any goroutines
  it spawns within its own return.
- `proc.Context` opens a supervised context on the parent ctx;
  `proc.Go` schedules bodies onto it; `proc.Wait` drains it and
  returns the first non-nil error. The tree lives on the ctx.
- **Supervisors** wrap bodies like HTTP middleware: `Keep` restarts,
  `Solo` adds a cluster-wide claim, `Many` fans out N Solo slots,
  `Each` runs one copy per peer.
- **Channels** are named, typed, and durable. Delivery is
  at-least-once, FIFO within a (channel, cohort). Payloads are JSON,
  or `encoding.BinaryMarshaler` when implemented.
- **Claims and messages are broker state, not host state.** Kill
  every peer and the first one back resumes the work. Scale-to-zero
  is not a special case.

## Starting

```go
func main() {
    ctx := context.Background()
    pool, err := pgxpool.New(ctx, os.Getenv("DB_URL"))
    if err != nil {
        log.Fatal(err)
    }
    ctx, cancel := proc.Context(
        ctx, &procpgx.Broker{Pool: pool},
    )
    defer cancel()
    proc.Go(ctx, serveHTTP, proc.Each("http"))
    proc.Go(ctx, deliverMail, proc.Solo("mailer"))
    log.Fatal(proc.Wait(ctx))
}
```

On a laptop, `proc.Context(ctx, new(mem.Broker))` runs the whole
program — claims included — in one process. The broker is the only
line that changes between the two. Brokers sit behind a four-method
interface; Postgres is supported today via
[lesiw.io/procpgx](https://pkg.go.dev/lesiw.io/procpgx).

## Supervisors

```go
proc.Go(ctx, fn)                       // bare: fail-fast
proc.Go(ctx, fn, proc.Keep())          // restart on failure
proc.Go(ctx, fn, proc.Solo("leader"))  // cluster-singleton
proc.Go(ctx, fn, proc.Many("pool", 5)) // 5 Solo slots, one cohort
proc.Go(ctx, fn, proc.Each("http"))    // one copy per peer
```

- A bare `Go` is fail-fast: the first non-nil return or recovered
  panic cancels its siblings through the shared context, and that
  error is what `Wait` returns — errgroup semantics with recovery
  built in.
- `Keep` re-invokes the body on any non-nil return or panic, under
  decay backoff: failures in quick succession wait longer; a crash
  after a long healthy run restarts immediately.
- `Solo` is Keep plus a claim: at most one peer runs the body. The
  body's ctx is claim-scoped — losing the claim cancels it, so a
  deposed holder winds down instead of racing its successor. On a
  clean nil return the next peer reclaims.
- `Many(name, n)` claims slots `name-1..name-n` across the cluster,
  all sharing cohort `name`, so a `Recv` inside the body
  load-balances the channel across the pool.
- `Each` runs per-peer with cohort `name + "/" + Host`, so every
  peer sees every message — right for config watchers and broadcast
  consumers. Use `Many` when you want load-balancing instead.
- Supervisors compose left-to-right, outermost first:
  `proc.Go(ctx, fn, withMetrics, proc.Solo("x"))`.

**Nil is death.** A clean nil return means "this proc is done" —
Keep exits its loop, a Solo's next peer reclaims, a Many slot
retires. Long-lived bodies return only on ctx-cancel. A body that
finished one work item and wants to run again returns
`proc.ErrContinue`, which restarts without logging a body error.

## Messaging

```go
proc.Send(ctx, "orders", order)

for ctx, o := range proc.Recv[Order](ctx, "orders") {
    process(ctx, o)
}
```

- The range body's control flow settles each message: reaching the
  end of the body (or `continue`) acks; `break`, `return`, or panic
  naks, and the broker redelivers.
- The cohort comes from the supervisor's name automatically
  (`proc.Solo("billing")` ⇒ cohort `billing`), or explicitly via
  `proc.WithCohort`. Replicas sharing a cohort load-balance;
  distinct cohorts each see every message.
- Every messaging primitive signals ctx-cancel by returning
  `ok=false` (`Send`, `Load`, `Query`) or `committed, ok`
  (`Save`). `ok=false` means one thing: your ctx ended and the
  call's effect is unknown — shut down. There are no other visible
  failure modes; the broker retries transport faults internally.
  Do not write retry loops around Send.

`proc.Chan` returns `<-chan Delivery[T]` for Go-native `select`
across channels or settlement decoupled from iteration. You own
settlement: exactly one of `d.Ack(ctx)` / `d.Nak(ctx)` per delivery,
callable from any goroutine, later than the yield if needed. A
dropped Delivery stays in flight until the scope cancels. The
channel is never closed — when the ctx ends it goes quiet, so every
receive loop carries a `ctx.Done()` arm as its exit. Prefer `Recv`
when its safe-by-construction shape fits.

## Request and reply

```go
double := proc.ServerFunc[int, int](
    func(_ context.Context, n int) (int, error) {
        return n * 2, nil
    },
)
proc.Go(ctx, func(ctx context.Context) error {
    return proc.Serve(ctx, "double", double)
}, proc.Solo("double"))

reply, ok := proc.Query[int, int](ctx, "double", 21)
```

Serve is at-least-once and so is the reply: a handler that dies
before its ack runs again on redelivery, and a crash mid-reply can
deliver the answer twice. Handlers stay idempotent; requesters treat
a duplicate reply as the same news. Business errors the requester
should see belong in the reply type; a handler's returned error
means "I'm in a bad state" and propagates to the supervisor.

## Load and Save: channels as values

```go
func bump(ctx context.Context) error {
    for {
        n, ok := proc.Load[int](ctx, "counter")
        if !ok {
            return nil
        }
        saved, ok := proc.Save(ctx, "counter", n+1)
        if !ok || saved {
            return nil
        }
    }
}
```

- `Load` reads the latest message; `Save` compare-and-appends
  against what the cohort has seen. An uncommitted save means the
  head moved — re-Load and retry. Conflict is normal flow, not an
  error.
- `Load` is at-most-once by design: it advances the cohort's
  high-water mark past what it read. A later `Recv` on the same
  cohort resumes after that point — Load-then-Recv is the canonical
  "ignore history, watch the future" shape.
- `Save` does not advance the mark; only `Load` does. A second Save
  without an intervening Load conflicts with its own prior write.
- With a fresh cohort that has never Loaded, Save commits only if
  the channel is empty — first-write-wins, a durable `sync.Once`.
- Channels are eternal: Load cannot distinguish "never written"
  from "holds the zero value." Encode presence in the type (`*T` or
  a flag field).

## The cron shape

```go
proc.Go(ctx, func(ctx context.Context) error {
    last, ok := proc.Load[time.Time](
        ctx, "cron/backup/last",
    )
    if !ok {
        return nil
    }
    next := schedule.Next(last)
    select {
    case <-ctx.Done():
        return nil
    case <-time.After(time.Until(next)):
    }
    defer proc.Send(ctx, "cron/backup/last", next)
    return cmp.Or(runBackup(ctx), proc.ErrContinue)
}, proc.Solo("cron/backup"))
```

One tick per invocation; Keep owns the loop via `ErrContinue`. The
deferred Send records the tick only if the work ran, so a crash
mid-run re-runs the missed tick: at least once, never zero. State
lives in the substrate — a fresh Load starts every tick from durable
truth, never from a local variable.

## TTLs and tunables

- `proc.WithMessageTTL(d)` bounds the message-log entry. Negative
  skips the log entirely (Send becomes a no-op; Save writes only
  the value cell). Useful for tokens and scratch state — an idle
  rate limiter can't bank an unbounded burst.
- `proc.WithChannelTTL(d)` bounds the per-channel value cell that
  Load reads; zero means indefinite.
- `proc.WithTripwire(d)` arms rollouts: within d after startup, a
  supervised body's error surfaces through Wait instead of
  restarting, so a bad deploy halts loudly.
- Tunables never gate correctness. At-least-once, FIFO-per-cohort,
  and supervised restart hold at every setting, including zero.

## Rolling deploys

Every peer stamps its build with an epoch — by default the commit
timestamp from the binary's VCS metadata, or explicitly:

```sh
go build \
    -ldflags="-X lesiw.io/proc.Epoch=$(date -u +%s)" .
```

When a majority of peers reports a newer epoch, every Solo migrates
onto new-epoch peers, so new code runs the singletons while old code
is still there to fall back to.

## Partitions

A peer that loses its broker transport fences itself — cancels its
own procs — before the cluster re-grants its claims. Bodies see
plain ctx-cancel, the same signal a deploy delivers. Code that
honors its ctx is already partition-correct; why a context ended is
the supervisor's business, not the body's.

## Traps

Things that look right and aren't. Check code against this list.

- **Calling `proc.Go` on a ctx with no scope panics.** Open
  `proc.Context` first; inside a body, the body's own ctx already
  carries the scope.
- **Calling `proc.Wait` from inside a body scheduled on the same
  scope deadlocks** — the body waits for itself. To wait on a
  subset of children, open a nested `proc.Context` inside the body
  and Wait on that.
- **`Recv`, `Chan`, `Load`, and `Save` panic on an empty cohort.**
  Schedule the body under a named supervisor or apply
  `proc.WithCohort`.
- **Don't loop inside a tick-shaped body.** Return `ErrContinue`
  and let Keep restart it; local state that must survive belongs in
  the substrate via Load/Save.
- **Don't Load while messages are in flight on the same cohort.**
  Advancing the high-water mark no-ops their settlement and orphans
  anything Chan already buffered. Load at startup, before the
  consume loop.
- **Don't branch on why a ctx ended.** Partition, deploy, shutdown,
  and claim-loss all deliver the same cancel; handle the cancel.
- **Don't retry `ok=false`.** It only means your ctx ended. The
  broker already retries everything retryable.
- **Nested `Many` with a fixed inner name collapses** to one
  cluster-wide inner pool raced by every outer slot. Derive inner
  names from `proc.Name(ctx)` for true fan-out.
- **`proc.WithLogger` goes on the ctx passed into `proc.Context`**,
  not the returned one — the scope captures its input.
- **Everything is at-least-once; make handlers idempotent.** A
  crash between work and ack reruns the work; a crash mid-reply
  duplicates the reply. Carry dedup keys in payloads when the work
  isn't naturally idempotent.
- **Under `Many`, a slot's clean nil return retires that slot**
  peer-locally with no cross-peer signal. Pool bodies should return
  only on ctx-cancel.
- **A Chan receive loop without a `ctx.Done()` arm blocks forever
  after cancel** — the channel never closes; the ctx is the only
  termination signal. Ranging over a Chan never terminates either;
  single-channel iteration belongs to `Recv`.
- **Call `Chan` once per channel per body invocation, at the top of
  the body — never inside a loop.** Each call starts a new consumer
  whose pump prefetches and holds a claimed message; in-loop calls
  strand messages and goroutines until the body exits. The
  exception that proves the rule: a tick-shaped body that receives
  one message and returns `proc.ErrContinue` may call `Chan` inline
  in its select — the restart reaps every consumer the invocation
  minted. `ErrContinue` is exempt from Keep's backoff and the
  tripwire boot window, so the shape works at any traffic level;
  just never return it without blocking first.

## Quick reference

```go
ctx, cancel := proc.Context(ctx, ds...)     // open a supervised context
proc.Go(ctx, body, supervisors...)          // schedule a body
err := proc.Wait(ctx)                       // drain; first error
proc.Keep() / proc.Solo(n) / proc.Many(n, k) / proc.Each(n)

ok := proc.Send(ctx, ch, v)                 // durable when ok
for ctx, v := range proc.Recv[T](ctx, ch)   // ack via control flow
d := <-proc.Chan[T](ctx, ch)                // manual d.Ack / d.Nak
reply, ok := proc.Query[Q, R](ctx, ch, q)   // request/reply
proc.Serve(ctx, ch, server)                 // dispatch loop (body-shaped)
v, ok := proc.Load[T](ctx, ch)              // latest value; advances HWM
committed, ok := proc.Save(ctx, ch, v)      // CAS append

proc.WithCohort(n) / proc.WithHost(h) / proc.WithHostTag(k, v)
proc.WithMessageTTL(d) / proc.WithChannelTTL(d)
proc.WithTripwire(d) / proc.WithLogger(l)
proc.Host(ctx) / proc.Name(ctx) / proc.Logger(ctx)
proc.ErrContinue                            // restart me; not a failure
```
