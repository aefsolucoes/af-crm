-- Impostos da nota de comissão (Fabio 14/11): retenções, líquido e impostos a pagar
ALTER TABLE "CommissionNote" ADD COLUMN "retainedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "CommissionNote" ADD COLUMN "netAmount" DOUBLE PRECISION;
ALTER TABLE "CommissionNote" ADD COLUMN "taxesToPay" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "CommissionNote" ADD COLUMN "taxes" JSONB;
-- Onde a nota ficou no Drive (CONTABILIDADE/<ano>/NFE ou /<NN.PAGADOR>/<MM.MÊS>)
ALTER TABLE "CommissionNote" ADD COLUMN "docType" TEXT;
ALTER TABLE "CommissionNote" ADD COLUMN "driveFileId" TEXT;
ALTER TABLE "CommissionNote" ADD COLUMN "driveLink" TEXT;
ALTER TABLE "CommissionNote" ADD COLUMN "drivePath" TEXT;
