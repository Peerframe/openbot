/** Allows deliberately late queued callbacks after close to exercise subscriber ownership. */
export class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    TestEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, payload: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
  open() {
    this.onopen?.(new Event("open"));
  }
}
