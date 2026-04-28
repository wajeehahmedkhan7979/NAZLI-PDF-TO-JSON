import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, recoveryTimeMs: 200, requestTimeoutMs: 1000 });
  });

  it('starts in CLOSED state', () => {
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAvailable()).toBe(true);
  });

  it('passes through a successful call', async () => {
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('counts failures and opens after threshold', async () => {
    const fail = () => cb.execute(async () => { throw new Error('fail'); });

    await expect(fail()).rejects.toThrow('fail');
    await expect(fail()).rejects.toThrow('fail');
    expect(cb.getState()).toBe('CLOSED'); // 2/3 — still closed

    await expect(fail()).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN'); // 3/3 — now open
  });

  it('throws CircuitOpenError when open', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }

    await expect(cb.execute(async () => 99)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('transitions to HALF_OPEN after recovery time', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    expect(cb.getState()).toBe('OPEN');

    // Wait for recovery
    await new Promise((r) => setTimeout(r, 250));
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('closes again on successful probe in HALF_OPEN', async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 250));

    // Successful probe
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('returns to OPEN on failed probe in HALF_OPEN', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 250));

    // Failed probe
    await cb.execute(async () => { throw new Error('still failing'); }).catch(() => {});
    expect(cb.getState()).toBe('OPEN');
  });

  it('resets manually', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
    expect(cb.getState()).toBe('OPEN');
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('enforces request timeout', async () => {
    const slowFn = () => cb.execute(async () => {
      await new Promise((r) => setTimeout(r, 2000)); // 2s > 1s timeout
      return 'done';
    });

    await expect(slowFn()).rejects.toThrow('timeout');
  });
});
