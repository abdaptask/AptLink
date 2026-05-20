// Reusable user-creation script.
//
// Examples (PowerShell):
//   $env:DATABASE_URL = "<your Supabase pooler URL>"
//   $env:NEW_EMAIL = "tester@aptask.com"
//   $env:NEW_PASSWORD = "Test1234!"
//   $env:NEW_FIRST = "Test"
//   $env:NEW_LAST = "User"
//   # Optional — wire to Telnyx:
//   $env:NEW_SIP_USERNAME = "usertestace12345"
//   $env:NEW_DID = "+17322001303"
//   npm run create-user -w packages/db
//
// Re-runs are safe: upserts on email. Updates password + SIP fields each time.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.NEW_EMAIL;
  const password = process.env.NEW_PASSWORD;
  if (!email || !password) {
    console.error(
      'Error: set NEW_EMAIL and NEW_PASSWORD env vars.\n' +
      '  Optional: NEW_FIRST, NEW_LAST, NEW_SIP_USERNAME, NEW_DID, NEW_IS_ADMIN=1',
    );
    process.exit(1);
  }

  const firstName = process.env.NEW_FIRST ?? null;
  const lastName = process.env.NEW_LAST ?? null;
  const sipUsername = process.env.NEW_SIP_USERNAME ?? null;
  const sipPassword = process.env.NEW_SIP_PASSWORD ?? null;
  const didNumber = process.env.NEW_DID ?? null;
  const isAdmin = process.env.NEW_IS_ADMIN === '1';

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      firstName,
      lastName,
      sipUsername,
      sipPassword,
      didNumber,
      isAdmin,
      isActive: true,
    },
    create: {
      email,
      passwordHash,
      firstName,
      lastName,
      sipUsername,
      sipPassword,
      didNumber,
      isAdmin,
      isActive: true,
    },
  });

  console.log(
    `User saved: id=${user.id} email=${user.email}` +
    ` sipUsername=${user.sipUsername ?? '(unset)'}` +
    ` sipPassword=${user.sipPassword ? '(set)' : '(unset)'}` +
    ` did=${user.didNumber ?? '(unset)'} admin=${user.isAdmin}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
