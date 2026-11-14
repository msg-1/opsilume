-- Ingestion requests that carried an Idempotency-Key. Additive: no existing table changes.
CREATE TABLE "IngestionRequest" (
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionRequest_pkey" PRIMARY KEY ("organizationId","scope","key")
);

CREATE INDEX "IngestionRequest_expiresAt_idx" ON "IngestionRequest"("expiresAt");

ALTER TABLE "IngestionRequest" ADD CONSTRAINT "IngestionRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
