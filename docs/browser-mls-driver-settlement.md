# Development room-driver settlement

A bounded box request may return unavailable after timeout or invalidation while
its actual signer, transport or parser still runs. That reply cannot release
the room-driver lock or establish endpoint shutdown. The box client retains
each actual promise before invoking its signer and exposes `settled()` for the
owning driver. Capacity remains occupied until that promise terminates.

The driver retains its native round lock through client settlement, including
work abandoned by a bounded caller. Closing invalidates synchronously, starts
endpoint shutdown, and joins the active round, client work and shutdown before
its single close promise settles. Shutdown failure is reported only after the
other local tails terminate. The closed instance cannot run again; its close
promise retains the failure. The application endpoint owner must separately
retain its native endpoint lock if engine shutdown fails.

Settlement is local terminal ownership. It does not undo a request committed
remotely, confirm delivery or clear uncertain outbox records. An unsettled signer
or request can keep the round and close pending. Callers must not await
`settled()` from inside a client operation or call driver close from inside its
own active round. Each concrete owner must keep the client private to one
driver; the shutdown callback must never recursively await driver close.

This repairs a prerequisite for the next explicit development room composition.
Generic create/join/driver work needs its own foreground lifecycle and sealed
room endpoint namespace, separate from grant preparation, persona witness leases
and the ordinary account Link. Only a named workflow using grant authority may
prepare the grant database. Actual create/join controls, default-WASM live Bothy,
historical writers, recovery, physical/operator acceptance and production MLS
activation remain separate gates. This change adds no production caller.
