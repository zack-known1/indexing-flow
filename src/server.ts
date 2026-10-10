import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { sessionRedis, connectRedis } from './lib/redis';
import { logger } from './lib/logger';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import propertiesRoutes from './routes/properties';
import urlsRoutes from './routes/urls';
import billingRoutes from './routes/billing';

const app = express();

// Security + Core
if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // Allow external assets like FontAwesome
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', './src/views');

// Sessions
app.use(session({
  store: new RedisStore({ client: sessionRedis, prefix: `${env.REDIS_PREFIX}:session:` }),
  secret: env.SESSION_SECRET,
  name: 'sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: env.isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
  },
}));

// Routes
app.use(authRoutes);
app.use(dashboardRoutes);
app.use('/properties', propertiesRoutes);
app.use('/urls', urlsRoutes);
app.use('/billing', billingRoutes);

// Error Handler
app.use(errorHandler);

async function start(): Promise<void> {
  await connectRedis();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
  });
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
