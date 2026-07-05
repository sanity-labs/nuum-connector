/**
 * ntfy.sh notification carrier (v1).
 *
 * The `--notify ntfy:<topic-or-url>` config resolves to a publish URL:
 *   - `ntfy:mytopic`                 -> https://ntfy.sh/mytopic
 *   - `ntfy:https://n.example/topic` -> https://n.example/topic
 *   - a bare `mytopic` / full URL also work (the `ntfy:` prefix is optional).
 *
 * A private/high-entropy topic keeps the channel confidential; the OTP itself
 * is never derivable from the topic or URL. An optional NTFY_TOKEN env is sent
 * as a Bearer token for access-controlled ntfy servers.
 *
 * Publish is a plain HTTP POST: the message body is the human-readable request,
 * with the OTP on its own line so it is easy to read aloud / type into chat.
 */
/**
 * Parse a `--notify` value into an ntfy publish URL. Throws on empty/invalid
 * input so auth-enabled startup can fail closed with a clear message.
 */
export function parseNotifyConfig(raw) {
    if (!raw || raw.trim() === "") {
        throw new Error("--notify is required when --auth is enabled (e.g. --notify ntfy:<topic>)");
    }
    let value = raw.trim();
    if (value.startsWith("ntfy:"))
        value = value.slice("ntfy:".length);
    if (value === "") {
        throw new Error("invalid --notify: empty ntfy target");
    }
    if (/^https?:\/\//i.test(value)) {
        return { url: value.replace(/\/+$/, "") };
    }
    // Bare topic -> default public server.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`invalid --notify ntfy topic '${value}' (use letters, digits, - and _)`);
    }
    return { url: `https://ntfy.sh/${value}` };
}
function formatBody(p) {
    const expiresMin = Math.max(1, Math.round((p.pendingExpiresAt - Date.now()) / 60000));
    return [
        "Persona requests connector access",
        "",
        `Connector: ${p.connector}`,
        `Host: ${p.host}`,
        `Space: ${p.spaceId}`,
        `Access: shell exec`,
        `Lease: ${p.leaseLabel}`,
        `Reason: ${p.reason}`,
        "",
        `Code: ${p.otp}`,
        `Expires: ${expiresMin} minutes`,
    ].join("\n");
}
/** Build a Notifier that POSTs OTP requests to the configured ntfy URL. */
export function createNtfyNotifier(config) {
    return async (payload) => {
        const headers = {
            "Content-Type": "text/plain; charset=utf-8",
            Title: `Connector access: ${payload.connector}`,
            Priority: "high",
            Tags: "closed_lock_with_key",
        };
        const token = process.env.NTFY_TOKEN ?? process.env.NTFY_ACCESS_TOKEN;
        if (token)
            headers.Authorization = `Bearer ${token}`;
        const res = await fetch(config.url, {
            method: "POST",
            headers,
            body: formatBody(payload),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`ntfy publish failed: ${res.status} ${text.slice(0, 120)}`);
        }
    };
}
