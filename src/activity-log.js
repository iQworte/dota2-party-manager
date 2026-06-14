const MAX_ENTRIES = 200;

export class ActivityLog {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.entries = [];
  }

  add(message, { level = 'info', category = 'app' } = {}) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      level,
      category,
      message: String(message)
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.onChange();
    return entry;
  }

  snapshot() {
    return [...this.entries].reverse();
  }
}
