-- Public demo mode: the per-address investigation quota looks sessions up by address and day.
-- CreateIndex
CREATE INDEX "RefreshToken_ip_createdAt_idx" ON "RefreshToken"("ip", "createdAt");
