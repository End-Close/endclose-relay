# relayctl

In-container operator CLI for endclose-relay. It talks to the **local** admin API
(`http://127.0.0.1:8081` by default) and authenticates with `ADMIN_BASIC_AUTH` from the
process environment — no password prompt. Intended for `docker exec` / ECS Exec sessions
when you do not want (or cannot reach) the admin UI.

The YAML document it applies is the same routes-only config as the admin UI; see
[CONFIG.md](./CONFIG.md).

## When to use it

- Fargate / ECS Exec: `./deploy/fargate/ops exec`, then `relayctl …`
- Docker: `docker exec -it <container> relayctl status`
- Local build: `pnpm relayctl status` (same env vars as the running relay)

It is **not** a remote client. Pointing `RELAY_ADMIN_URL` at another host still needs
that host’s `ADMIN_BASIC_AUTH` in your environment.

## Authentication and endpoints

| Env | Role |
|---|---|
| `ADMIN_BASIC_AUTH` | **Required.** `user:password` (already injected in the container). |
| `RELAY_ADMIN_URL` | Optional override (default `http://127.0.0.1:$RELAY_ADMIN_PORT`). |
| `RELAY_ADMIN_PORT` | Used when `RELAY_ADMIN_URL` is unset (default `8081`). |

```sh
relayctl --help
relayctl config help
relayctl events help
```

## Commands

### `status`

Snapshot of mode, killswitch, config hash, queue depths, and routes.

```sh
relayctl status
relayctl status --json
```

### `config`

YAML is the interchange format (same document as the admin UI / `relay.example.yaml`).
Use `-` as the path to read from stdin.

| Subcommand | What it does |
|---|---|
| `get [-o file]` | Print active YAML (or write to a file). Hash goes to stderr. |
| `validate <file\|->` | Validate without applying. |
| `apply <file\|->` | Validate + apply. Alias: `set`. |
| `edit` | Open active YAML in `$EDITOR` / `$VISUAL`, then apply if changed. |
| `versions` | List immutable config versions. |
| `show <id> [-o file]` | Show a historical version’s YAML. |
| `preview --route <id> --sample <payload.json> [--file yaml]` | Dry-run mapping for a sample payload (optional draft YAML). |

```sh
relayctl config get -o /tmp/relay.yaml
# edit /tmp/relay.yaml …
relayctl config validate /tmp/relay.yaml
relayctl config apply /tmp/relay.yaml

relayctl config edit   # fetch → editor → apply in one step ($EDITOR defaults to vi in the image)
```

Stdin (`-`) works when you already have a file on the client side of a pipe; prefer a
`/tmp` file inside the container for interactive sessions.

**Bootstrap / recovery:** the first successful apply (no valid config yet, or repairing an
invalid stored config) exits the process so the orchestrator restarts into running mode.
Later applies are live — no restart. After a recovery apply the relay may come up
**paused**; resume with `relayctl killswitch resume`.

### `killswitch`

Global killswitch. With no argument (or `get`), prints the current state.

```sh
relayctl killswitch              # show
relayctl killswitch pause        # buffer, do not forward
relayctl killswitch resume       # clear pause/panic → none
relayctl killswitch panic        # refuse ingest
relayctl killswitch none         # same as resume
```

### `events`

Browse the buffer, inspect decrypted payloads locally, and replay parked events.
Payload viewing is audited (`event.view_payload`); bodies never leave the appliance.

```sh
relayctl events list
relayctl events list --status parked --route payabli-settlements --limit 50
relayctl events list --json

relayctl events payload <id>     # print decrypted JSON (local only)
relayctl events replay <id>
relayctl events replay-parked
```

## Typical flows

**Bootstrap on Fargate (ECS Exec):**

```sh
./deploy/fargate/ops exec
# inside the container:
relayctl status
vi /tmp/relay.yaml          # write the routes YAML (see relay.example.yaml)
relayctl config validate /tmp/relay.yaml
relayctl config apply /tmp/relay.yaml
# process exits; wait for the new task, then:
./deploy/fargate/ops exec
relayctl status
```

If the image has no editor, paste into a file instead (`cat > /tmp/relay.yaml`, then
Ctrl-D) and apply the same path. `relayctl config edit` is the same flow when
`$EDITOR` is set (starts from an empty `routes` document in bootstrap).

**Change window:**

```sh
relayctl killswitch pause
relayctl config edit          # or apply a file
relayctl killswitch resume
relayctl status
```

**Clear parked events after a mapping fix:**

```sh
relayctl events list --status parked
relayctl config apply /tmp/relay.yaml
relayctl events replay-parked
```
