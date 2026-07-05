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
- **Lease auth**: optional OTP approval layer. When enabled, shell exec fails closed until a human approves a time-boxed lease.

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
A one-time code was sent to the connector operator's channel.
Approve it with: connector auth my-host <otp>
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
Expires: 5 minutes
```

Approve the lease from Persona:

```sh
connector auth my-host ABCD-1234
```

Then commands work until the lease expires:

```sh
connector exec my-host hostname
connector exec my-host -- sh -c 'pwd; whoami'
```

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
--lease <duration>     Lease duration, for example 30m, 2h, or 8h.
--notify ntfy:<topic>  Send OTPs to an ntfy.sh topic.
--notify ntfy:<url>    Send OTPs to a full ntfy URL, useful for private ntfy servers.
```

If `--auth otp` is set without `--notify`, the connector refuses to start.

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
ExecStart=/usr/bin/npx -y github:sanity-labs/nuum-connector my-host --url https://persona.example.com --auth otp --lease 8h --notify ntfy:connector-yourcompany-8x7k2p9m --cwd /home/deploy
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
- OTP approval grants a time-boxed lease for shell exec from the paired Persona space.
- Lease tokens and OTPs are stored by the daemon as hashes in memory. Restarting the daemon clears active leases.
- Persona stores its hidden lease token durably for the lease lifetime.
- Approved commands run as the OS user that launched the connector.
- There is no command sandboxing in this version.

Use a dedicated low-privilege OS user when possible.
