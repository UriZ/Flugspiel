// Records every send() for the emit-loop tests.

export class RecordingTransport {
  /** @param {{throws?: boolean}} [opts] */
  constructor({ throws = false } = {}) {
    this.sent = [];
    this.throws = throws;
  }

  send(state) {
    this.sent.push(state);
    if (this.throws) throw new Error('transport down');
  }

  get count() {
    return this.sent.length;
  }
}
