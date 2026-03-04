import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './shared/middleware/error-handler';
import { logger } from './shared/logging/logger';

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler());

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
  });
}

export default app;
