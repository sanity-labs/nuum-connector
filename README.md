# nuum-connector

nuum-connector is a daemon you run on a remote machine, such as a laptop, GPU box, or on-prem server; it dials out to a Nuum/Persona connector-provider over a reverse WebSocket, so it works behind NAT/firewalls with no inbound ports. Agents in the paired space can then exec commands on it.

## Quickstart

```sh
npx github:sanity-labs/nuum-connector <slug> --url https://<your-server>
```

On first run it prints a generated key. On the Persona side, pair it with:

```sh
connector set <slug> <key>
```

Then run commands with:

```sh
connector exec <slug> -- <cmd>
```

## Config

Configuration is stored at `~/.nuum/<slug>.json` with file mode `0600`.

## Security / Capabilities

The daemon executes arbitrary shell commands as the OS user that launched it, with no sandboxing in this version. Only run it on machines where you intend agents in the paired space to have that level of access.

### Opt-in lease-token auth

Time-boxed authorization is available as an opt-in layer. When disabled (the default), behavior is unchanged. To enable it:

```sh
nuum <slug> --url https://<your-server> \
  --auth otp \
  --lease 8h \
  --notify ntfy:<topic-or-url>
```

With auth on, `exec` requires an active, unexpired lease for the calling space. Persona obtains a lease with `connector renew <slug> "<reason>"`, which makes the daemon mint a hidden lease token and send a one-time code (OTP) to the configured [ntfy](https://ntfy.sh) channel; a human approves via `connector auth <slug> <otp>`. The daemon holds only token/OTP *hashes* in memory, so a restart clears all leases. If `--auth` is set without `--notify`, the daemon fails to start (fail-closed). An optional `NTFY_TOKEN` env is sent as a Bearer token for access-controlled ntfy servers.

Sandboxing remains a separate future layer: an approved lease still grants shell access as the daemon's OS user.

## Requirements

Node >= 20.
