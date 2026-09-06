import type { Readable, Writable } from "node:stream";
import { addCredit, transferDataSize, TRANSFER_FRAME_BYTES, TRANSFER_WINDOW_BYTES } from "./flow-control.js";

/** One command's bounded byte plane. No pending output array or chunk remainder.
 * Readable pipes stay in pull mode; their native high-water marks bound prefetch.
 * At most one window can be queued across transport + child stdin writes.
 */
export class CommandFlow {
  private outputCredit = 0;
  private inputCredit = TRANSFER_WINDOW_BYTES;
  private inputAck = 0;
  private inputClosed = false;
  private inputSinkClosed = false;
  private disposed = false;
  private pumping = false;
  private nextStream = 0;
  private readonly outputs: Array<["stdout" | "stderr", Readable]>;

  constructor(
    stdout: Readable,
    stderr: Readable,
    private readonly stdin: Writable,
    private readonly send: (frame: { type: "stdout" | "stderr"; data: string } | { type: "stdin_credit"; bytes: number }) => void,
    private readonly fail: (error: Error) => void,
  ) {
    this.outputs = [["stdout", stdout], ["stderr", stderr]];
    for (const [, stream] of this.outputs) {
      stream.on("readable", this.pumpOutput);
      stream.on("error", this.onError);
    }
    stdin.on("error", this.onInputClosed);
    stdin.on("drain", this.flushInputAck);
  }

  start(): void { this.send({ type: "stdin_credit", bytes: TRANSFER_WINDOW_BYTES }); }

  grantOutput(bytes: unknown): void {
    if (this.disposed) return;
    try {
      this.outputCredit = addCredit(this.outputCredit, bytes);
      this.pumpOutput();
    } catch (e) { this.onError(e as Error); }
  }

  private readonly pumpOutput = (): void => {
    if (this.disposed || this.pumping) return;
    this.pumping = true;
    try {
      while (this.outputCredit > 0) {
        let read = false;
        // Share output credit across stdout/stderr, taking turns if both are ready.
        for (let i = 0; i < 2; i++) {
          const index = (this.nextStream + i) % 2;
          const [type, stream] = this.outputs[index];
          const size = Math.min(stream.readableLength, this.outputCredit, TRANSFER_FRAME_BYTES);
          if (size === 0) { stream.read(0); continue; }
          const chunk: Buffer | null = stream.read(size);
          if (!chunk) continue;
          this.outputCredit -= chunk.length;
          this.nextStream = (index + 1) % 2;
          this.send({ type, data: chunk.toString("base64") });
          read = true;
          break;
        }
        if (!read) break;
      }
      // EOF is control state, not data. In particular an empty stderr pipe and
      // a final stdout read that exactly exhausts credit must still emit end.
      // read(0) consumes no bytes and leaves native prefetch bounded by the HWM.
      for (const [, stream] of this.outputs) stream.read(0);
    } catch (e) { this.onError(e as Error); }
    finally { this.pumping = false; }
  };

  writeInput(data: unknown): void {
    if (this.disposed) return;
    let bytes: number;
    try {
      bytes = transferDataSize(data);
      if (this.inputClosed || bytes > this.inputCredit) throw new Error("stdin exceeded transfer credit or followed EOF");
      this.inputCredit -= bytes;
    } catch (e) {
      this.onError(e as Error);
      return;
    }

    if (this.inputSinkClosed) return;

    try {
      this.stdin.write(Buffer.from(data as string, "base64"), (error?: Error | null) => {
        if (this.disposed) return;
        if (error) { this.onInputClosed(error); return; }
        if (this.inputSinkClosed) return;
        this.inputAck += bytes;
        this.flushInputAck();
      });
    } catch (e) {
      this.onInputClosed(e as Error);
    }
  }

  private readonly flushInputAck = (): void => {
    // A write callback alone is insufficient when Node still needs drain.
    if (this.disposed || this.inputClosed || this.inputSinkClosed || this.stdin.writableNeedDrain || this.inputAck === 0) return;
    const bytes = this.inputAck;
    this.inputAck = 0;
    this.inputCredit = addCredit(this.inputCredit, bytes);
    this.send({ type: "stdin_credit", bytes });
  };

  closeInput(): void {
    if (this.disposed || this.inputClosed) return;
    this.inputClosed = true;
    if (this.inputSinkClosed) return;
    try {
      this.stdin.end(); // Node flushes the bounded pending writes before EOF.
    } catch (e) {
      this.onInputClosed(e as Error);
    }
  }

  private readonly onInputClosed = (_error?: Error): void => {
    // Child processes are allowed to exit or close stdin before consuming all
    // credited input (for example upload destination-exists checks). Treat the
    // stdin pipe closure as backpressure terminal state, not as a transfer
    // protocol failure that would race and mask the child's honest exit code.
    if (this.disposed) return;
    this.inputSinkClosed = true;
    this.inputAck = 0;
  };

  private readonly onError = (error: Error): void => {
    if (!this.disposed) this.fail(error);
  };

  dispose(): void {
    if (this.disposed) return;
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
