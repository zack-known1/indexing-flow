import { PrismaClient, PlatformRole, WorkspaceRole, CreditPackage } from '@prisma/client';
import { hashPassword } from '../src/lib/password';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Create or update admin user
  const adminEmail = env.ADMIN_EMAIL.toLowerCase();
  const passwordHash = env.ADMIN_INITIAL_PASSWORD
    ? await hashPassword(env.ADMIN_INITIAL_PASSWORD)
    : await hashPassword('ChangeMe_AtOnce_2026');

  const adminUser = await prisma.user.upsert({
    where: { emailNormalized: adminEmail },
    update: {
      platformRole: PlatformRole.SUPER_ADMIN,
    },
    create: {
      email: env.ADMIN_EMAIL,
      emailNormalized: adminEmail,
      name: 'Platform Admin',
      passwordHash,
      platformRole: PlatformRole.SUPER_ADMIN,
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`👤 Admin user ready: ${adminUser.email}`);

  // 2. Create default workspace for admin
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
    console.log(`🏢 Default workspace created: ${workspace.name}`);
  } else {
    // Ensure wallet exists
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

  // 3. Create default credit packages
  const packages = [
    {
      code: 'starter_pack',
      name: 'Starter Indexing Pack',
      description: '5,000 URL credits for small sites and blogs',
      credits: 5000,
      priceMinor: 99900, // ₹999.00
      currency: 'INR',
      isFeatured: false,
      sortOrder: 1,
    },
    {
      code: 'growth_pack',
      name: 'Growth Indexing Pack',
      description: '25,000 URL credits with priority indexing queue',
      credits: 25000,
      priceMinor: 399900, // ₹3,999.00
      currency: 'INR',
      isFeatured: true,
      sortOrder: 2,
    },
    {
      code: 'scale_pack',
      name: 'Scale Enterprise Pack',
      description: '100,000 URL credits for large programmatic SEO sites',
      credits: 100000,
      priceMinor: 1199900, // ₹11,999.00
      currency: 'INR',
      isFeatured: false,
      sortOrder: 3,
    },
  ];

  for (const pkg of packages) {
    await prisma.creditPackage.upsert({
      where: { code: pkg.code },
      update: {
        name: pkg.name,
        description: pkg.description,
        credits: pkg.credits,
        priceMinor: pkg.priceMinor,
        isFeatured: pkg.isFeatured,
        sortOrder: pkg.sortOrder,
      },
      create: pkg,
    });
  }

  console.log('📦 Credit packages seeded.');
  console.log('✨ Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
