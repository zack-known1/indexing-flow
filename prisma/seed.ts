import {
  PrismaClient,
  PlatformRole,
  WorkspaceRole,
  UserStatus,
} from '@prisma/client';
import { hashPassword } from '../src/lib/password';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Do not create/reset an admin with a known fallback password.
  const adminEmail = env.ADMIN_EMAIL.trim().toLowerCase();
  if (!adminEmail) {
    throw new Error('ADMIN_EMAIL is required. Set it in .env before seeding.');
  }
  if (!env.ADMIN_INITIAL_PASSWORD) {
    throw new Error(
      'ADMIN_INITIAL_PASSWORD is required. Set your own password in .env before seeding.',
    );
  }

  const passwordHash = await hashPassword(env.ADMIN_INITIAL_PASSWORD);

  // Existing admin: set the supplied password and restore SUPER_ADMIN access.
  // New admin: create the account with the same supplied credentials.
  const adminUser = await prisma.user.upsert({
    where: { emailNormalized: adminEmail },
    update: {
      passwordHash,
      platformRole: PlatformRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      deletedAt: null,
      sessionEpoch: { increment: 1 },
    },
    create: {
      email: env.ADMIN_EMAIL.trim(),
      emailNormalized: adminEmail,
      name: 'Platform Admin',
      passwordHash,
      platformRole: PlatformRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`Admin user ready: ${adminUser.email}`);

  // Ensure the admin has a default workspace and credit wallet.
  let workspace = await prisma.workspace.findFirst({
    where: { ownerId: adminUser.id },
  });

  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: 'Default Workspace',
        slug: 'default-workspace',
        ownerId: adminUser.id,
        members: {
          create: {
            userId: adminUser.id,
            role: WorkspaceRole.OWNER,
          },
        },
        wallet: {
          create: {
            availableCredits: env.SIGNUP_BONUS_CREDITS,
            lifetimeBonus: env.SIGNUP_BONUS_CREDITS,
          },
        },
      },
    });
    console.log(`Default workspace created: ${workspace.name}`);
  } else {
    const wallet = await prisma.creditWallet.findUnique({
      where: { workspaceId: workspace.id },
    });
    if (!wallet) {
      await prisma.creditWallet.create({
        data: {
          workspaceId: workspace.id,
          availableCredits: env.SIGNUP_BONUS_CREDITS,
          lifetimeBonus: env.SIGNUP_BONUS_CREDITS,
        },
      });
    }
  }

  const packages = [
    {
      code: 'starter_pack',
      name: 'Starter Indexing Pack',
      description: '5,000 URL credits for small sites and blogs',
      credits: 5000,
      priceMinor: 99900,
      currency: 'INR',
      isFeatured: false,
      sortOrder: 1,
    },
    {
      code: 'growth_pack',
      name: 'Growth Indexing Pack',
      description: '25,000 URL credits with priority indexing queue',
      credits: 25000,
      priceMinor: 399900,
      currency: 'INR',
      isFeatured: true,
      sortOrder: 2,
    },
    {
      code: 'scale_pack',
      name: 'Scale Enterprise Pack',
      description: '100,000 URL credits for large programmatic SEO sites',
      credits: 100000,
      priceMinor: 1199900,
      currency: 'INR',
      isFeatured: false,
      sortOrder: 3,
    },
  ];

  // Upsert package fields explicitly so database-generated fields are not supplied.
  for (const pkg of packages) {
    await prisma.creditPackage.upsert({
      where: { code: pkg.code },
      update: {
        name: pkg.name,
        description: pkg.description,
        credits: pkg.credits,
        priceMinor: pkg.priceMinor,
        currency: pkg.currency,
        isFeatured: pkg.isFeatured,
        sortOrder: pkg.sortOrder,
      },
      create: {
        code: pkg.code,
        name: pkg.name,
        description: pkg.description,
        credits: pkg.credits,
        priceMinor: pkg.priceMinor,
        currency: pkg.currency,
        isFeatured: pkg.isFeatured,
        sortOrder: pkg.sortOrder,
      },
    });
  }

  console.log('Credit packages seeded.');
  console.log('Seeding completed successfully.');
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
