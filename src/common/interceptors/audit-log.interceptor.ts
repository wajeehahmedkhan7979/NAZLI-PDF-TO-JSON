import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Interceptor that auto-logs document access/modification events.
 * Attach to controllers that need audit trail coverage.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;
    const url = request.url;
    const actor = request.headers['x-api-key'] ? 'api-user' : 'anonymous';

    // Only log mutating operations or sensitive reads
    const shouldLog = method !== 'GET' || url.includes('/raw') || url.includes('/audit');
    if (!shouldLog) return next.handle();

    // Extract documentId from URL if present
    const idMatch = url.match(/documents\/([a-f0-9-]+)/);
    const documentId = idMatch ? idMatch[1] : null;

    return next.handle().pipe(
      tap(async () => {
        if (documentId) {
          try {
            await prisma.auditLog.create({
              data: {
                documentId,
                action: `${method} ${url}`,
                actor,
                details: { method, url, timestamp: new Date().toISOString() },
              },
            });
          } catch {
            // Non-critical: audit log failure should not break the request
          }
        }
      }),
    );
  }
}
