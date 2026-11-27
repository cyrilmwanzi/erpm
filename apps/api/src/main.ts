import "./instrument.js";
import "reflect-metadata";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import * as Sentry from "@sentry/nestjs";
import { Readable } from "node:stream";
import { AppModule } from "./app.module.js";
import { authRedisClient } from "./auth/auth.config.js";
import { getEnv } from "./config/env.js";
import { sanitizeRequestId } from "./observability/scrubbing.utils.js";

async function bootstrap() {
  const env = getEnv();
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: env.NODE_ENV !== "test",
      trustProxy: true,
      ignoreTrailingSlash: true,
    }),
    {
      bodyParser: false,
    },
  );

  await app.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-API-Key",
      "X-Request-Id",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "X-Scace-Billing-Status",
      "X-Scace-Grace-Ends-At",
      "X-Scace-Plan-Code",
    ],
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.STORAGE_MAX_FILE_BYTES,
      files: 1,
    },
  });

  app.enableShutdownHooks();

  const fastifyInstance = app.getHttpAdapter().getInstance();

  fastifyInstance.addHook("onRequest", async (request, reply) => {
    const requestId = sanitizeRequestId(
      request.headers["x-request-id"] ?? request.id,
    );
    (request as unknown as { requestId?: string }).requestId = requestId;
    reply.header("X-Request-Id", requestId);
    Sentry.getIsolationScope().setTag("request_id", requestId);
  });

  fastifyInstance.addHook("preParsing", async (request, _reply, payload) => {
    if (
      request.method !== "POST" ||
      !request.url.startsWith("/api/v1/crm/webhooks/")
    ) {
      return payload;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBytes = 1024 * 1024;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        const err = new Error("Webhook payload exceeds 1 MiB limit.") as Error & {
          statusCode?: number;
        };
        err.statusCode = 413;
        throw err;
      }
      chunks.push(buf);
    }
    const rawBuffer = Buffer.concat(chunks);
    (request as unknown as { crmRawBody?: Buffer }).crmRawBody = rawBuffer;
    return Readable.from(rawBuffer);
  });

  fastifyInstance.addHook("onClose", async () => {
    await Promise.allSettled([
      Sentry.flush(2000),
      authRedisClient.status !== "end" ? authRedisClient.quit() : Promise.resolve(),
    ]);
  });

  await app.listen(env.PORT, env.HOST);
  logger.log(`Scace API (Fastify) listening on http://${env.HOST}:${env.PORT}`);
}

bootstrap().catch((error: unknown) => {
  console.error("Failed to start Scace API:", error);
  process.exit(1);
});
