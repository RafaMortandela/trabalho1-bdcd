#!/usr/bin/env bash
#
# Gera o pacote que o notebook restaura dentro da VM do Google Colab.
#
# Conteudo:
#   * municipios_ibge, pib_serie_ibge, de_para_siafi_ibge  (completos)
#   * resumo_municipio_competencia                         (completo)
#   * pagamentos_bf                                        (amostra: UF = AC)
#
# A colecao completa de pagamentos tem 57 milhoes de documentos e nao caberia em
# um arquivo para enviar ao Colab. A amostra do Acre preserva a estrutura e
# permite repetir, no Colab, a consulta indexada da secao 6 do notebook.
#
# Uso:  bash notebook/gerar_dump_colab.sh
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URI="${MONGO_URI:-mongodb://localhost:27017}"
BANCO="${MONGO_DB:-brasil_bf}"
UF_AMOSTRA="${UF_AMOSTRA:-AC}"
SAIDA="$RAIZ/dados/dump_colab"
PACOTE="$RAIZ/dados/dump_colab.tgz"

rm -rf "$SAIDA" "$PACOTE"
mkdir -p "$SAIDA"

echo ">> Colecoes completas (IBGE, de-para e visao materializada)"
mongodump --uri "$URI" --db "$BANCO" --gzip --out "$SAIDA" \
          --excludeCollection pagamentos_bf \
          --excludeCollection system.profile

echo
echo ">> Amostra de pagamentos_bf (UF = $UF_AMOSTRA)"
mongodump --uri "$URI" --db "$BANCO" --gzip --out "$SAIDA" \
          --collection pagamentos_bf \
          --query "{\"uf\": \"$UF_AMOSTRA\"}"

echo
echo ">> Empacotando"
tar czf "$PACOTE" -C "$RAIZ/dados" dump_colab
rm -rf "$SAIDA"

echo
echo "OK  $PACOTE  ($(du -h "$PACOTE" | cut -f1))"
echo "Envie este arquivo ao Colab quando o notebook pedir."
