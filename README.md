# nuum-connector

`nuum-connector` is a small daemon you run on a machine you want Persona/Nuum agents to manage: a laptop, GPU box, on-prem server, VM, or machine behind NAT.

It dials **outbound** to a Persona connector provider over a reverse WebSocket. You do **not** need to open inbound firewall ports. Once paired, agents in the paired Persona space can run shell commands on that machine.

> Security note: in this version, approved commands run as the OS user that starts the connector. There is no sandboxing yet. Only run the connector as a user account whose shell access you are willing to grant to agents in the paired space.

## Requirements

- Node.js 20 or newer.
- Network egress from the machine to your Persona/Nuum server.
- A Persona operator who can run `connector set`, `connector renew`, and `connector auth` in the paired space.
- Optional but recommended: an [ntfy](https://ntfy.sh/) topic for out-of-band approval codes.

You can run directly with `npx`:

```sh
npx -y github:sanity-labs/nuum-connector <slug> --url https://<your-persona-server>
```

The package also exposes a `nuum` binary after install.

## Concepts

- **Slug**: the local name for this connector, for example `gpu-box`, `basement-server`, or `laptop`.
- **Key**: a generated pairing/routing secret. The connector stores it in `~/.nuum/<slug>.json`.
- **Persona-side registration**: the paired space must run `connector set <slug> <key>` once.
- **Lease auth**: optional OTP approval layer. When enabled, shell exec fails closed until a human approves a lease. Leases are time-boxed by default; the operator's `--max-lease` policy decides whether agents may request longer or indefinite leases.

## Quickstart without OTP auth

Start the connector:

```sh
npx -y github:sanity-labs/nuum-connector my-host \
  --url https://persona.example.com
```

On first run it prints a generated key. In Persona, register it:

```sh
connector set my-host <key-printed-by-the-connector>
```

Then agents can run commands:

```sh
connector exec my-host hostname
connector exec my-host -- sh -c 'pwd; whoami'
```

This mode is simple but gives immediate shell access to the paired Persona space.

## Recommended quickstart: OTP lease auth with ntfy

OTP lease auth requires a human approval code before shell exec. The connector sends the code to an ntfy topic.

Pick a hard-to-guess ntfy topic name, for example:

```text
connector-yourcompany-8x7k2p9m
```

Start the connector with auth enabled:

```sh
npx -y github:sanity-labs/nuum-connector my-host \
  --url https://persona.example.com \
  --auth otp \
  --lease 8h \
  --notify ntfy:connector-yourcompany-8x7k2p9m \
  --cwd "$HOME"
```

`--lease 8h` is the lease an agent gets when it does not ask for a specific duration. Without `--max-lease`, it is also the longest lease an agent may request. See [Lease duration policy](#lease-duration-policy) to allow longer or indefinite leases.

If you use a private ntfy server or protected topic, set `NTFY_TOKEN` in the connector environment:

```sh
export NTFY_TOKEN='<your-ntfy-access-token>'

npx -y github:sanity-labs/nuum-connector my-host \
  --url https://persona.example.com \
  --auth otp \
  --lease 8h \
  --notify ntfy:https://ntfy.example.com/connector-yourcompany-8x7k2p9m \
  --cwd "$HOME"
```

On first run, register the printed key in Persona:

```sh
connector set my-host <key-printed-by-the-connector>
```

Now unauthenticated exec attempts fail closed:

```sh
connector exec my-host hostname
```

Expected response:

```text
Connector 'my-host' requires authorization.
Run: connector renew my-host "why access is needed"
```

Request a lease:

```sh
connector renew my-host "debug production issue"
```

Expected response:

```text
Authorization requested for 'my-host'.
Requested lease: 8h (connector default).
A one-time code was sent to the connector operator's channel.
Approve it with: connector auth my-host <otp>
```

An agent may also ask for a specific lease with `--for`:

```sh
connector renew my-host --for 30m "debug production issue"
connector renew my-host --for indefinitely "attended migration"
```

The connector operator receives an ntfy message like:

```text
Persona requests connector access

Connector: my-host
Host: my-host
Space: <space-id>
Access: shell exec
Lease: 8h
Reason: debug production issue

Code: ABCD-1234
Code expires: 5 minutes
```

`Lease:` is the exact duration the code approves — the connector resolves it before sending the code, so approving the code approves that duration and nothing else. For an indefinite lease it reads `Lease: indefinitely (no expiry; lasts until replaced or the connector restarts)`. `Code expires:` is the five-minute approval window; it is unrelated to the lease length.

Approve the lease from Persona:

```sh
connector auth my-host ABCD-1234
```

Then commands work until the lease expires:

```sh
connector exec my-host hostname
connector exec my-host -- sh -c 'pwd; whoami'
```

The lease clock starts when the code is approved, not when it was requested.

## Lease duration policy

Two flags define the policy. The connector is the authority: Persona only relays what the agent asked for and records what the connector returns.

```text
--lease <duration>                   Default lease when a request omits a duration. Finite. Default 8h.
--max-lease <duration|indefinitely>  Longest lease an agent may request. Defaults to --lease.
```

- Durations are `<n>s`, `<n>m`, `<n>h`, or `<n>d` with a positive integer and a lower-case unit, for example `30m`, `2h`, `8h`, `2d`. Zero, decimals, upper-case units, and compound values such as `1h30m` are rejected.
- There is no fixed product ceiling on a finite duration. A finite value is valid when its millisecond count is a positive safe integer and the expiry it would produce is a valid date. Because the lease clock starts when the code is approved, the connector checks that an approval at any moment inside the five-minute code window would still yield a valid expiry. A request that fails this is rejected as `invalid_lease_duration`; one that is valid but longer than `--max-lease` is rejected as `lease_duration_exceeds_max`.
- `--lease` must be finite. `indefinitely` is accepted only for `--max-lease`.
- If `--lease` is longer than a finite `--max-lease`, or either cannot produce a valid expiry from the connector's clock, the connector refuses to start. The same check is repeated on every request, so a long-running connector never relies on its startup-time validation alone.
- Notifications, logs, and Persona output name the exact bound duration: whole days, hours, minutes, or seconds use their unit (`2d`, `8h`, `30m`, `90s`); anything else is shown in exact milliseconds (`1499ms`), never rounded.
- A request above `--max-lease` (including `indefinitely` under a finite maximum) is rejected before any code is sent. It is never shortened: the operator approves exactly the duration shown in the notification.
- Requests are validated on the connector even if Persona already checked them.

Examples:

```sh
# Today's behavior: every lease is exactly 8h; longer requests are rejected.
--auth otp --lease 8h --notify ntfy:<topic>

# 30 minutes by default; agents may ask for up to 2 days.
--auth otp --lease 30m --max-lease 2d --notify ntfy:<topic>

# 30 minutes by default; agents may ask for any valid finite lease or an indefinite one.
--auth otp --lease 30m --max-lease indefinitely --notify ntfy:<topic>
```

An indefinite lease has no time expiry. It lasts until a newer approval for the same space replaces it or the connector process restarts. Restarting the connector is the operator's way to end any lease early, indefinite or not.

Compatibility: an older Persona never requests a duration, so it always receives this connector's finite `--lease` default. A newer Persona talking to an older connector works when the agent omits `--for`; an explicit `--for` against an older connector is reported by Persona as unsupported and no token is stored. Persona's `connector lease` shows Persona's recorded state, not a live query of this connector, and Persona's `connector revoke` only forgets Persona's copy of the token.

## Configuration and identity

The connector stores configuration at:

```text
~/.nuum/<slug>.json
```

The file contains the slug, URL, and connector key, and should be mode `0600`.

Preserve this file to preserve connector identity. If you delete it, the connector generates a new key and Persona must run `connector set <slug> <new-key>` again.

If you are migrating from older Persona connector builds, the old config may be under:

```text
~/.persona/connect/<slug>.json
```

To preserve the existing identity, copy that file to the new location:

```sh
install -d -m 700 ~/.nuum
cp -p ~/.persona/connect/my-host.json ~/.nuum/my-host.json
chmod 600 ~/.nuum/my-host.json
```

## Common flags

```text
<slug>                 Connector name/slug.
--url <url>            Persona/Nuum server URL, for example https://persona.example.com.
--cwd <path>           Working directory for commands. Defaults to the process cwd.
--auth otp             Enable OTP lease authorization.
--lease <duration>     Default lease when a request omits one, for example 30m, 2h, or 8h. Finite.
--max-lease <duration|indefinitely>
                       Longest lease an agent may request. Defaults to --lease.
--notify ntfy:<topic>  Send OTPs to an ntfy.sh topic.
--notify ntfy:<url>    Send OTPs to a full ntfy URL, useful for private ntfy servers.
```

If `--auth otp` is set without `--notify`, the connector refuses to start. It also refuses to start on an invalid duration, a `--lease` of `indefinitely`, a `--lease` longer than a finite `--max-lease`, a duration whose expiry could not be a valid date, or any value-taking flag (`--url`, `--cwd`, `--auth`, `--lease`, `--max-lease`, `--notify`) given without its value.

## Running as a service: Linux systemd

Example systemd unit for a connector running as user `deploy`:

```ini
[Unit]
Description=Nuum connector for my-host
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
Environment=HOME=/home/deploy
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/deploy
ExecStart=/usr/bin/npx -y github:sanity-labs/nuum-connector my-host --url https://persona.example.com --auth otp --lease 8h --max-lease 2d --notify ntfy:connector-yourcompany-8x7k2p9m --cwd /home/deploy
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Install and start:

```sh
sudo tee /etc/systemd/system/nuum-connector-my-host.service >/dev/null < nuum-connector-my-host.service
sudo systemctl daemon-reload
sudo systemctl enable --now nuum-connector-my-host.service
sudo journalctl -u nuum-connector-my-host.service -f
```

If `npx` uses `#!/usr/bin/env node`, make sure `PATH` includes the directory containing `node`. If in doubt, test the exact command as the service user before enabling the unit.

The lease policy lives in the service command line, not in `~/.nuum/<slug>.json`. Drop `--max-lease` to keep today's fixed-lease behavior, or set it to `indefinitely` only for hosts where an operator is prepared to restart the connector to end access.

## Running as a service: macOS LaunchAgent

Example `~/Library/LaunchAgents/dev.nuum.connector.my-host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.nuum.connector.my-host</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec npx -y github:sanity-labs/nuum-connector my-host --url https://persona.example.com --auth otp --lease 8h --notify ntfy:connector-yourcompany-8x7k2p9m --cwd "$HOME"</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>/Users/you</string>

  <key>StandardOutPath</key>
  <string>/tmp/nuum-connector-my-host.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/nuum-connector-my-host.err.log</string>
</dict>
</plist>
```

Load it:

```sh
plutil -lint ~/Library/LaunchAgents/dev.nuum.connector.my-host.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.nuum.connector.my-host.plist
launchctl kickstart -k "gui/$(id -u)/dev.nuum.connector.my-host"
tail -f /tmp/nuum-connector-my-host.err.log
```

If you use a Node version manager such as `fnm`, `nvm`, or `asdf`, wrap the command so the LaunchAgent can find `node` and `npx`, for example:

```xml
<string>eval "$(/opt/homebrew/bin/fnm env --shell zsh)"; exec npx -y github:sanity-labs/nuum-connector my-host --url https://persona.example.com --auth otp --lease 8h --notify ntfy:connector-yourcompany-8x7k2p9m --cwd /Users/you</string>
```

## Troubleshooting

### `node: command not found` or `/usr/bin/env: node: No such file or directory`

The service environment cannot find Node. Set `PATH` in systemd or initialize your Node version manager in the LaunchAgent command.

### Connector starts but Persona shows it offline

Check the connector logs and verify:

- `--url` points at the correct Persona/Nuum server.
- The machine can reach that URL over HTTPS.
- Persona registered the same key printed/stored by this connector.
- You preserved `~/.nuum/<slug>.json` if migrating an existing connector.

### `Connector '<slug>' requires authorization`

This is expected when OTP auth is enabled and there is no active lease. Run:

```sh
connector renew <slug> "reason for access"
```

Then approve the OTP with:

```sh
connector auth <slug> <otp>
```

### `Connector '<slug>' rejected the requested lease`

The agent asked for a lease longer than this connector's `--max-lease` (or asked for `indefinitely` under a finite maximum). No code was sent. Either the agent retries with a shorter `--for` (or none, for the default), or the operator restarts the connector with a larger `--max-lease`.

### `does not support requested lease durations`

Persona sent `--for` to a connector build that predates lease durations. Upgrade the connector, or retry `connector renew` without `--for`.

### OTP never arrives

Check:

- `--notify ntfy:<topic-or-url>` is configured.
- The topic name is correct.
- If using a protected ntfy server/topic, `NTFY_TOKEN` is present in the connector environment.
- The connector logs show the renew request and notification result.

### Commands run in the wrong directory

Start the connector with an explicit working directory:

```sh
--cwd /path/to/workdir
```

## Security model in this version

- The connector dials outbound; no inbound port is required.
- Pairing uses the connector key stored in `~/.nuum/<slug>.json`.
- OTP lease auth is opt-in.
- With OTP auth enabled, exec fails closed without an active lease.
- OTP approval grants a lease for shell exec from the paired Persona space. The lease duration is fixed by the connector's `--lease`/`--max-lease` policy and shown in the approval message; requests above the maximum are rejected, never shortened.
- One active lease per space: a newer approval replaces the previous lease for that space.
- Indefinite leases exist only if the operator sets `--max-lease indefinitely`. They end when replaced or when the connector restarts.
- Lease tokens and OTPs are stored by the daemon as hashes in memory. Restarting the daemon clears all leases, including indefinite ones.
- Persona stores its hidden lease token durably for the lease lifetime.
- Approved commands run as the OS user that launched the connector.
- There is no command sandboxing in this version.

Use a dedicated low-privilege OS user when possible.
