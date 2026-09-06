/** Shared bounded-transfer v1: keep the Persona and public daemon copies identical. */
export const BOUNDED_TRANSFER = "byte-credit-v1";
export const TRANSFER_FRAME_BYTES = 16 * 1024;
export const TRANSFER_WINDOW_BYTES = 64 * 1024;
export const TRANSFER_WIRE_BYTES = 64 * 1024;
export const TRANSFER_UPGRADE_REQUIRED = "connector cp requires bounded transfer support; upgrade the public nuum-connector daemon and Persona connector provider";
/** Credits count decoded bytes, shared by stdout and stderr for each command. */
export function addCredit(current, bytes) {
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        current + bytes > TRANSFER_WINDOW_BYTES) {
        throw new Error("invalid or excessive transfer credit");
    }
    return current + bytes;
}
/** Validate before allocating decoded bytes. Empty frames cannot bypass the queue bound. */
export function transferDataSize(data) {
    if (typeof data !== "string" || data.length === 0 ||
        data.length > 4 * Math.ceil(TRANSFER_FRAME_BYTES / 3) ||
        data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error("invalid or oversized transfer data frame");
    }
    const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes <= 0 || bytes > TRANSFER_FRAME_BYTES)
        throw new Error("oversized transfer data frame");
    return bytes;
}
