-- Public demo mode: a visitor session id, kept across refresh rotation, and the session that started an investigation.
-- AlterTable
ALTER TABLE "Investigation" ADD COLUMN     "demoSessionId" TEXT;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "demoSessionId" TEXT;

-- CreateIndex
CREATE INDEX "Investigation_organizationId_demoSessionId_idx" ON "Investigation"("organizationId", "demoSessionId");

-- CreateIndex
CREATE INDEX "RefreshToken_demoSessionId_idx" ON "RefreshToken"("demoSessionId");
