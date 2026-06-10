// Script to safely clean up test data for email = 'abdulla+test1@aptask.com'
//
// Usage:
//   npx tsx --env-file=../../.env scripts/cleanup-test-data.ts
//
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const emailToDelete = 'abdulla+test1@aptask.com';

  try {
    console.log(`Searching for user with email: ${emailToDelete}`);
    const user = await prisma.user.findUnique({
      where: { email: emailToDelete },
    });

    if (user) {
      console.log(`Found user: ${user.firstName} ${user.lastName} (ID: ${user.id}). Deleting related data...`);

      // Delete child associations first to satisfy foreign keys
      const deletedFavorites = await prisma.favorite.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedFavorites.count} favorites.`);

      const deletedBlocked = await prisma.blockedNumber.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedBlocked.count} blocked numbers.`);

      const deletedCalls = await prisma.call.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedCalls.count} calls.`);

      const deletedMessages = await prisma.message.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedMessages.count} messages.`);

      const deletedVoicemails = await prisma.voicemail.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedVoicemails.count} voicemails.`);

      const deletedInternal = await prisma.internalMessage.deleteMany({
        where: { OR: [{ senderId: user.id }, { recipientId: user.id }] },
      });
      console.log(`Deleted ${deletedInternal.count} internal messages.`);

      const deletedScheduled = await prisma.scheduledMessage.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedScheduled.count} scheduled messages.`);

      // Clear activeUserDidId pointer first to avoid circular reference on UserDid
      await prisma.user.update({
        where: { id: user.id },
        data: { activeUserDidId: null },
      });

      const deletedUserDids = await prisma.userDid.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedUserDids.count} user DIDs.`);

      const deletedPraises = await prisma.praise.deleteMany({
        where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      });
      console.log(`Deleted ${deletedPraises.count} praises.`);

      const deletedPraiseReads = await prisma.praiseRead.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedPraiseReads.count} praise reads.`);

      const deletedDevices = await prisma.userDevice.deleteMany({ where: { userId: user.id } });
      console.log(`Deleted ${deletedDevices.count} user devices.`);

      const deletedAuditLogs = await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: user.id }, { targetUserId: user.id }] },
      });
      console.log(`Deleted ${deletedAuditLogs.count} audit logs.`);

      // Now delete the User
      await prisma.user.delete({
        where: { id: user.id },
      });
      console.log(`Successfully deleted user row for ${emailToDelete}.`);
    } else {
      console.log(`User ${emailToDelete} not found in 'users' table.`);
    }

    // Now delete from pending_users table
    console.log(`Searching for email in pending_users table: ${emailToDelete}`);
    const deletedPending = await prisma.pendingUser.deleteMany({
      where: { email: emailToDelete },
    });
    console.log(`Deleted ${deletedPending.count} rows from 'pending_users' table.`);

  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
