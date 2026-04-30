import { Test, TestingModule } from '@nestjs/testing';
import { MarkerClient, MarkerError } from '../../src/modules/extraction/clients/marker.client';
import { ConfigModule } from '@nestjs/config';

/**
 * Failure Injection Tests
 * Verifies system resilience under simulated failure conditions:
 * - Marker sidecar timeouts
 * - Circuit breaker tripping
 * - Payload size limits
 */
describe('Failure Injection & Resilience', () => {
  let markerClient: MarkerClient;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [MarkerClient],
    }).compile();

    markerClient = module.get<MarkerClient>(MarkerClient);
  });

  describe('MarkerClient Resilience', () => {
    it('should reject files exceeding maxFileSize (returns null)', async () => {
      // Create a mock large file
      const fs = require('fs');
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 50 * 1024 * 1024 } as any);

      const result = await markerClient.convertPdf('dummy.pdf');
      expect(result).toBeNull();
    });

    it('should trip circuit breaker after consecutive failures', async () => {
      // Mock fetch to always fail fast
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      // Force failureThreshold (default 5) requests.
      // Since maxRetries is 2, each call will do 3 attempts.
      // So 2 calls is enough to trip the breaker (3 attempts + 2 attempts = 5 failures).
      await markerClient.convertPdf('dummy.pdf'); // 3 failures
      await markerClient.convertPdf('dummy.pdf'); // 2 failures -> OPEN

      const cbState = markerClient.getCircuitState();
      expect(cbState).toBe('OPEN');

      // Next request should fail instantly with circuit_open, returning null
      const result = await markerClient.convertPdf('dummy.pdf');
      expect(result).toBeNull();
    }, 15000); // increase timeout for exponential backoff

    it('should respect max concurrent requests limit', async () => {
      // Mock fetch to hang
      let resolveFetch: any;
      global.fetch = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

      const fs = require('fs');
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 } as any);
      jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('mock'));

      // Max is 4, fire 4 requests
      const req1 = markerClient.convertPdf('dummy1.pdf');
      const req2 = markerClient.convertPdf('dummy2.pdf');
      const req3 = markerClient.convertPdf('dummy3.pdf');
      const req4 = markerClient.convertPdf('dummy4.pdf');

      // Give event loop a tick to register requests
      await new Promise(r => setTimeout(r, 50));

      // 5th request should hit capacity limit and return null fast
      const req5 = markerClient.convertPdf('dummy5.pdf');

      expect(await req5).toBeNull();

      // Resolve the hanging requests so test can exit
      if (resolveFetch) resolveFetch({ ok: true, json: () => ({}) });
      await Promise.all([req1, req2, req3, req4]);
    });
  });
});
