import { addCredit, transferDataSize, TRANSFER_FRAME_BYTES, TRANSFER_WINDOW_BYTES } from "./flow-control.js";
/** One command's bounded byte plane. No pending output array or chunk remainder.
 * Readable pipes stay in pull mode; their native high-water marks bound prefetch.
 * At most one window can be queued across transport + child stdin writes.
 */
export class CommandFlow {
    stdin;
    send;
    fail;
    outputCredit = 0;
    inputCredit = TRANSFER_WINDOW_BYTES;
    inputAck = 0;
    inputClosed = false;
    inputSinkClosed = false;
    disposed = false;
    pumping = false;
    nextStream = 0;
    outputs;
    constructor(stdout, stderr, stdin, send, fail) {
        this.stdin = stdin;
        this.send = send;
        this.fail = fail;
        this.outputs = [["stdout", stdout], ["stderr", stderr]];
        for (const [, stream] of this.outputs) {
            stream.on("readable", this.pumpOutput);
            stream.on("error", this.onError);
        }
        stdin.on("error", this.onInputClosed);
        stdin.on("drain", this.flushInputAck);
    }
    start() { this.send({ type: "stdin_credit", bytes: TRANSFER_WINDOW_BYTES }); }
    grantOutput(bytes) {
        if (this.disposed)
            return;
        try {
            this.outputCredit = addCredit(this.outputCredit, bytes);
            this.pumpOutput();
        }
        catch (e) {
            this.onError(e);
        }
    }
    pumpOutput = () => {
        if (this.disposed || this.pumping)
            return;
        this.pumping = true;
        try {
            while (this.outputCredit > 0) {
                let read = false;
                // Share output credit across stdout/stderr, taking turns if both are ready.
                for (let i = 0; i < 2; i++) {
                    const index = (this.nextStream + i) % 2;
                    const [type, stream] = this.outputs[index];
                    const size = Math.min(stream.readableLength, this.outputCredit, TRANSFER_FRAME_BYTES);
                    if (size === 0) {
                        stream.read(0);
                        continue;
                    }
                    const chunk = stream.read(size);
                    if (!chunk)
                        continue;
                    this.outputCredit -= chunk.length;
                    this.nextStream = (index + 1) % 2;
                    this.send({ type, data: chunk.toString("base64") });
                    read = true;
                    break;
                }
                if (!read)
                    break;
            }
            // EOF is control state, not data. In particular an empty stderr pipe and
            // a final stdout read that exactly exhausts credit must still emit end.
            // read(0) consumes no bytes and leaves native prefetch bounded by the HWM.
            for (const [, stream] of this.outputs)
                stream.read(0);
        }
        catch (e) {
            this.onError(e);
        }
        finally {
            this.pumping = false;
        }
    };
    writeInput(data) {
        if (this.disposed)
            return;
        let bytes;
        try {
            bytes = transferDataSize(data);
            if (this.inputClosed || bytes > this.inputCredit)
                throw new Error("stdin exceeded transfer credit or followed EOF");
            this.inputCredit -= bytes;
        }
        catch (e) {
            this.onError(e);
            return;
        }
        if (this.inputSinkClosed)
            return;
        try {
            this.stdin.write(Buffer.from(data, "base64"), (error) => {
                if (this.disposed)
                    return;
                if (error) {
                    this.onInputClosed(error);
                    return;
                }
                if (this.inputSinkClosed)
                    return;
                this.inputAck += bytes;
                this.flushInputAck();
            });
        }
        catch (e) {
            this.onInputClosed(e);
        }
    }
    flushInputAck = () => {
        // A write callback alone is insufficient when Node still needs drain.
        if (this.disposed || this.inputClosed || this.inputSinkClosed || this.stdin.writableNeedDrain || this.inputAck === 0)
            return;
        const bytes = this.inputAck;
        this.inputAck = 0;
        this.inputCredit = addCredit(this.inputCredit, bytes);
        this.send({ type: "stdin_credit", bytes });
    };
    closeInput() {
        if (this.disposed || this.inputClosed)
            return;
        this.inputClosed = true;
        if (this.inputSinkClosed)
            return;
        try {
            this.stdin.end(); // Node flushes the bounded pending writes before EOF.
        }
        catch (e) {
            this.onInputClosed(e);
        }
    }
    onInputClosed = (_error) => {
        // Child processes are allowed to exit or close stdin before consuming all
        // credited input (for example upload destination-exists checks). Treat the
        // stdin pipe closure as backpressure terminal state, not as a transfer
        // protocol failure that would race and mask the child's honest exit code.
        if (this.disposed)
            return;
        this.inputSinkClosed = true;
        this.inputAck = 0;
    };
    onError = (error) => {
        if (!this.disposed)
            this.fail(error);
    };
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.outputCredit = this.inputCredit = this.inputAck = 0;
        for (const [, stream] of this.outputs) {
            stream.off("readable", this.pumpOutput);
            // Retain the inert error listener for late destroy/write errors.
            stream.destroy();
        }
        this.stdin.off("drain", this.flushInputAck);
        this.stdin.destroy();
    }
}
