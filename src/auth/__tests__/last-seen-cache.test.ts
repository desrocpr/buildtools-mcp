import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../users.js", () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

import { touchLastSeen } from "../users.js";
import {
  __clearLastSeenCache,
  touchLastSeenDebounced,
} from "../last-seen-cache.js";

describe("touchLastSeenDebounced", () => {
  beforeEach(() => {
    __clearLastSeenCache();
    vi.mocked(touchLastSeen).mockClear();
  });

  it("fires the underlying touch on first call", () => {
    const db = {} as any;
    touchLastSeenDebounced(db, "user-1");
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("debounces a second call within the window", () => {
    const db = {} as any;
    touchLastSeenDebounced(db, "user-1");
    touchLastSeenDebounced(db, "user-1");
    touchLastSeenDebounced(db, "user-1");
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("debounces independently per user", () => {
    const db = {} as any;
    touchLastSeenDebounced(db, "user-1");
    touchLastSeenDebounced(db, "user-2");
    expect(touchLastSeen).toHaveBeenCalledTimes(2);
  });

  it("fires again after the debounce window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z"));
    const db = {} as any;
    touchLastSeenDebounced(db, "user-1");
    vi.setSystemTime(new Date("2026-06-02T00:05:01Z"));
    touchLastSeenDebounced(db, "user-1");
    expect(touchLastSeen).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
