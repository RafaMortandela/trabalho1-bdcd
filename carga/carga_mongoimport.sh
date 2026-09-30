#!/usr/bin/env bash
#
# ITEM (d) - Carga das duas bases no MongoDB usando mongoimport.
#
# Pre-requisitos:
#   1) mongod no ar (veja o README: dbpath proprio em ~/mongodb-trabalho-bd)
#   2) arquivos JSON Lines gerados pelos scripts de coleta/
#
# Uso:
#   bash carga/carga_mongoimport.sh
#
# Variaveis de ambiente opcionais:
#   MONGO_URI    padrao mongodb://localhost:27017
#   MONGO_DB     padrao brasil_bf
#   COMPETENCIAS padrao "202606 202607 202608"
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DADOS="$RAIZ/dados"
URI="${MONGO_URI:-mongodb://localhost:27017}"
BANCO="${MONGO_DB:-brasil_bf}"
COMPETENCIAS="${COMPETENCIAS:-202606 202607 202608}"
TRABALHADORES="${TRABALHADORES:-8}"

echo "=============================================================="
echo " Carga no MongoDB  |  banco: $BANCO  |  uri: $URI"
echo "=============================================================="

# --- limpeza para que o script seja reexecutavel do zero -------------------
echo
echo ">> Removendo colecoes anteriores (script idempotente)"
mongosh "$URI/$BANCO" --quiet --eval '
  ["pagamentos_bf","municipios_ibge","pib_serie_ibge","de_para_siafi_ibge"]
    .forEach(c => { const n = db.getCollection(c).drop(); print("   drop " + c + ": " + n); });
'

# --- BASE 2 (IBGE): colecoes pequenas -------------------------------------
echo
echo ">> BASE 2 - IBGE: municipios (populacao 2026 e PIB 2023)"
mongoimport --uri "$URI/$BANCO" \
            --collection municipios_ibge \
            --type json \
            --file "$DADOS/ibge_municipios.jsonl"

echo
echo ">> BASE 2 - IBGE: serie historica do PIB municipal (2015-2023)"
mongoimport --uri "$URI/$BANCO" \
            --collection pib_serie_ibge \
            --type json \
            --numInsertionWorkers "$TRABALHADORES" \
            --file "$DADOS/ibge_pib_serie.jsonl"

# --- Colecao de integracao entre as duas bases ----------------------------
echo
echo ">> Integracao: de-para do codigo SIAFI para o codigo IBGE"
mongoimport --uri "$URI/$BANCO" \
            --collection de_para_siafi_ibge \
            --type json \
            --file "$DADOS/de_para_siafi_ibge.jsonl"

# --- BASE 1 (Portal da Transparencia): pagamentos -------------------------
for competencia in $COMPETENCIAS; do
  arquivo="$DADOS/pagamentos_${competencia}.jsonl"
  echo
  echo ">> BASE 1 - Novo Bolsa Familia, competencia $competencia"
  echo "   arquivo: $(basename "$arquivo") ($(du -h "$arquivo" | cut -f1))"
  mongoimport --uri "$URI/$BANCO" \
              --collection pagamentos_bf \
              --type json \
              --numInsertionWorkers "$TRABALHADORES" \
              --batchSize 10000 \
              --file "$arquivo"
done

# --- ITEM (e): listagem das colecoes criadas ------------------------------
echo
echo "=============================================================="
echo " ITEM (e) - Colecoes criadas no banco $BANCO"
echo "=============================================================="
mongosh "$URI/$BANCO" --quiet --eval '
  print("");
  db.getCollectionNames().sort().forEach(function (nome) {
    const s = db.getCollection(nome).stats();
    print(
      nome.padEnd(22) +
      String(db.getCollection(nome).countDocuments({})).padStart(12) + " documentos" +
      ("  " + (s.storageSize / 1024 / 1024).toFixed(1) + " MB armazenados").padStart(26)
    );
  });
  print("");
'
echo "Carga concluida."
