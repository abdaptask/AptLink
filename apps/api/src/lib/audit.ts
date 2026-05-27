// Shared audit-log helper.
//
// Extracted from admin.routes.ts during the v0.10.0 sprint so non-admin
// endpoints (notably /me/active-did) can also write audit entries.
// Behavior identical to the original — never throws (audit failures don't
// block the user-visible action), normalizes null metadata to undefined
// because Prisma's JSON column doesn't accept literal null without an
// explicit Prisma.JsonNull import.
import { prisma } from '@ace/db';

export async function recordAudit(
  actorUserId: number,
  action: string,
  targetUserId: number | null,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        targetUserId,
        metadata: (metadata ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    console.warn('[audit] failed to write audit entry', { action, err });
  }
}
