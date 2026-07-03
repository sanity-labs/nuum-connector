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

The daemon executes arbitrary shell commands as the OS user that launched it, with no sandboxing in this version. Only run it on machines where you intend agents in the paired space to have that level of access. Authentication (time-boxed) and sandboxing are planned as opt-in layers in later versions.

## Requirements

Node >= 20.
