// One-shot lookup: show UserDid + owning User for a given DID (E.164).
// Usage: npx tsx packages/db/scripts/lookup-did.ts +16467379912
//
// Or via the workspace shortcut (after adding to package.json scripts):
//   npm --workspace=packages/db run lookup-did -- +16467379912

import { PrismaClient } from '@prisma/client';

async function main() {
  const did = process.argv[2];
  if (!did) {
    console.error('Usage: tsx lookup-did.ts <E.164-number>');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.userDid.findMany({
      where: { didNumber: did },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            sipUsername: true,
            voicemailGreetingMode: true,
            voicemailGreetingUrl: true,
          },
        },
      },
    });
    if (rows.length === 0) {
      console.log(`No UserDid row for ${did}. The TeXML route will fall through to default greeting until a row is inserted.`);
      return;
    }
    for (const r of rows) {
      console.log('---');
      console.log(`UserDid.id:              ${r.id}`);
      console.log(`didNumber:               ${r.didNumber}`);
      console.log(`userId:                  ${r.userId ?? '(null)'}`);
      console.log(`telnyxNumberId:          ${r.telnyxNumberId ?? '(null)'}`);
      console.log(`connectionId:            ${r.connectionId ?? '(null)'}`);
      console.log(`callControlMigratedAt:   ${r.callControlMigratedAt?.toISOString() ?? '(null)'}`);
      console.log(`texmlMigratedAt:         ${r.texmlMigratedAt?.toISOString() ?? '(null)'}`);
      console.log(`preMigrationConnectionId:${r.preMigrationConnectionId ?? '(null)'}`);
      if (r.user) {
        console.log(`Owner email:             ${r.user.email}`);
        console.log(`Owner name:              ${[r.user.firstName, r.user.lastName].filter(Boolean).join(' ')}`);
        console.log(`Owner sipUsername:       ${r.user.sipUsername ?? '(null)'}`);
        console.log(`Owner greetingMode:      ${r.user.voicemailGreetingMode ?? '(null)'}`);
        console.log(`Owner greetingUrl:       ${r.user.voicemailGreetingUrl ?? '(null)'}`);
      } else {
        console.log(`Owner: NONE (orphan DID)`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
