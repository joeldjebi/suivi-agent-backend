import type { NextFunction, Request, Response } from 'express';
import { isScannerPath, scanDetection } from './scan-detection';
import { SecurityEventsService } from './security-events.service';

describe('détection des scans de chemins', () => {
  it('reconnaît les chemins de robots, pas les chemins légitimes', () => {
    for (const p of [
      '/.env',
      '/api/.env',
      '/wp-login.php',
      '/.git/config',
      '/phpmyadmin/',
      '/xmlrpc.php',
      '/actuator/health',
    ])
      expect(isScannerPath(p)).toBe(true);
    for (const p of [
      '/api/auth/login',
      '/assets/index.js',
      '/map',
      '/',
      '/socket.io/',
      '/downloads/app.apk',
    ])
      expect(isScannerPath(p)).toBe(false);
  });

  it('journalise et renvoie 404 sur un scan, laisse passer sinon', () => {
    const records: unknown[] = [];
    const security = {
      record: (e: unknown) => records.push(e),
    } as unknown as SecurityEventsService;
    const handler = scanDetection(security);

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;

    handler(
      {
        path: '/.env',
        originalUrl: '/.env',
        method: 'GET',
        ip: '203.0.113.5',
        headers: { 'user-agent': 'nikto' },
      } as unknown as Request,
      res,
      next,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'path_scan',
      ip: '203.0.113.5',
      method: 'GET',
    });
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(404);
    expect(next).not.toHaveBeenCalled();

    handler(
      {
        path: '/api/auth/login',
        originalUrl: '/api/auth/login',
        method: 'POST',
        ip: '1.2.3.4',
        headers: {},
      } as unknown as Request,
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });
});
