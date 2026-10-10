import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../lib/password';
import { env } from '../config/env';
import { WorkspaceRole, PlatformRole, CreditTxnType } from '@prisma/client';
import { ValidationError, UnauthenticatedError } from '../lib/errors';
import { addCredits } from '../services/credit/wallet';

const router = Router();

router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.render('auth/login', {
    title: 'Sign In',
    error: req.query.error,
    email: req.query.email || '',
    appName: env.APP_NAME,
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    const emailNormalized = String(email).trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { emailNormalized },
    });

    if (!user || !user.passwordHash) {
      return res.render('auth/login', {
        title: 'Sign In',
        error: 'Invalid email or password',
        email,
        appName: env.APP_NAME,
      });
    }

    const verifyResult = await verifyPassword(password, user.passwordHash);
    if (!verifyResult.valid) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
      });
      return res.render('auth/login', {
        title: 'Sign In',
        error: 'Invalid email or password',
        email,
        appName: env.APP_NAME,
      });
    }

    // Upgrade hash if needed
    if (verifyResult.needsRehash) {
      const newHash = await hashPassword(password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
    }

    // Update login telemetry
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lastLoginAt: new Date(),
        lastLoginIp: req.ip,
      },
    });

    req.session.userId = user.id;
    req.session.sessionEpoch = user.sessionEpoch;

    // Resolve default workspace
    const member = await prisma.workspaceMember.findFirst({
      where: { userId: user.id },
    });
    if (member) {
      req.session.workspaceId = member.workspaceId;
    }

    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

router.get('/register', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.render('auth/register', {
    title: 'Create Account',
    error: req.query.error,
    name: '',
    email: '',
    appName: env.APP_NAME,
  });
});

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, workspaceName } = req.body;
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    const emailNormalized = String(email).trim().toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { emailNormalized },
    });

    if (existing) {
      return res.render('auth/register', {
        title: 'Create Account',
        error: 'An account with that email already exists.',
        name,
        email,
        appName: env.APP_NAME,
      });
    }

    const strength = checkPasswordStrength(password, { email, name, workspaceName });
    if (!strength.ok) {
      return res.render('auth/register', {
        title: 'Create Account',
        error: strength.problems[0],
        name,
        email,
        appName: env.APP_NAME,
      });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: String(email).trim(),
        emailNormalized,
        name: name ? String(name).trim() : null,
        passwordHash,
        platformRole: PlatformRole.USER,
        emailVerifiedAt: new Date(),
      },
    });

    // Create workspace
    const wsName = workspaceName ? String(workspaceName).trim() : `${user.name || 'My'} Workspace`;
    const slug = `${wsName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${user.id.slice(0, 6)}`;

    const workspace = await prisma.workspace.create({
      data: {
        name: wsName,
        slug,
        ownerId: user.id,
        members: {
          create: {
            userId: user.id,
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

    // Add bonus credits ledger entry
    if (env.SIGNUP_BONUS_CREDITS > 0) {
      await addCredits(
        workspace.id,
        env.SIGNUP_BONUS_CREDITS,
        CreditTxnType.BONUS,
        `bonus:signup:${workspace.id}`,
        'Welcome signup bonus credits',
        { userId: user.id },
      );
    }

    req.session.userId = user.id;
    req.session.workspaceId = workspace.id;
    req.session.sessionEpoch = user.sessionEpoch;

    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

export default router;
