import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function ensureDatabaseSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EnrichmentRun" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "cacheKey" TEXT NOT NULL,
      "company" TEXT NOT NULL,
      "city" TEXT NOT NULL,
      "state" TEXT NOT NULL,
      "website" TEXT,
      "status" TEXT NOT NULL,
      "usedCache" BOOLEAN NOT NULL DEFAULT false,
      "requestPayloadJson" TEXT NOT NULL,
      "resultJson" TEXT NOT NULL,
      "confidenceOwner" REAL,
      "confidenceCompetitor" REAL,
      "confidenceService" REAL,
      "overallConfidence" REAL,
      "errorMessage" TEXT,
      "startedAt" DATETIME NOT NULL,
      "completedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Evidence" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "runId" INTEGER NOT NULL,
      "sourceType" TEXT NOT NULL,
      "url" TEXT NOT NULL,
      "snippet" TEXT NOT NULL,
      "field" TEXT,
      "confidence" REAL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EnrichmentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppSetting" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "valueJson" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "EnrichmentRun_cacheKey_idx" ON "EnrichmentRun"("cacheKey")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "Evidence_runId_idx" ON "Evidence"("runId")`
  );
}
