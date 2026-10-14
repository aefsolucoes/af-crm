-- CPF de QUEM foi analisado/aprovado (titular ou 2º participante): o PDF da simulação é buscado no portal por esse CPF + o nº da proposta, sem adivinhar.
ALTER TABLE "CreditAnalysis" ADD COLUMN "holderCpf" TEXT;
