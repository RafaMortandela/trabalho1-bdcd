#!/usr/bin/env bash
#
# Executa o trabalho inteiro, do zero, guardando cada saida em saidas/.
#
# Uso:
#   bash executar_tudo.sh              # tudo, inclusive coleta e carga
#   bash executar_tudo.sh --consultas  # pula coleta e carga
#
# Pre-requisitos: mongod no ar em localhost:27017 e o venv criado
# (python3 -m venv .venv && .venv/bin/pip install -r requirements.txt).
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RAIZ"
PY="$RAIZ/.venv/bin/python"
URI="mongodb://localhost:27017/brasil_bf"
SAIDAS="$RAIZ/saidas"
mkdir -p "$SAIDAS/graficos"

etapa() { echo; echo "############ $* ############"; echo; }

if [[ "${1:-}" != "--consultas" ]]; then
  etapa "1/8  Coleta da BASE 2 (IBGE)"
  "$PY" coleta/coletar_ibge.py 2>&1 | tee "$SAIDAS/coleta_ibge.txt"

  etapa "2/8  Coleta da BASE 1 (Portal da Transparencia)"
  "$PY" coleta/coletar_bolsa_familia.py --baixar 2>&1 | tee "$SAIDAS/coleta_bolsa_familia.txt"

  etapa "3/8  Integracao SIAFI <-> IBGE"
  "$PY" coleta/de_para_siafi_ibge.py 2>&1 | tee -a "$SAIDAS/coleta_bolsa_familia.txt"

  etapa "4/8  Conversao para JSON Lines"
  "$PY" coleta/coletar_bolsa_familia.py --converter 2>&1 | tee -a "$SAIDAS/coleta_bolsa_familia.txt"

  etapa "5/8  ITENS (d) e (e) - carga e listagem das colecoes"
  bash carga/carga_mongoimport.sh 2>&1 | tee "$SAIDAS/item_d_carga_mongoimport.txt"

  etapa "6/8  Comparacao de desempenho: mongoimport x PyMongo"
  "$PY" carga/carga_pymongo.py 2>&1 | tee "$SAIDAS/carga_pymongo.txt"
fi

# O item (g) precisa rodar ANTES de carga/indices.js, para que o plano
# "antes do indice" seja legitimo.
etapa "7/8  ITEM (g) - plano de execucao antes e depois do indice"
mongosh "$URI" --quiet --file consultas/explain_antes_depois.js 2>&1 \
  | tee "$SAIDAS/item_g_explain_antes_depois.txt"
mongosh "$URI" --quiet --file carga/indices.js 2>&1 | tee "$SAIDAS/indices.txt"

etapa "8/8  ITEM (f) - consultas complexas, visao materializada e validacao"
mongosh "$URI" --quiet --file consultas/consultas_base1.js 2>&1 \
  | tee "$SAIDAS/item_f_consultas_base1.txt"
mongosh "$URI" --quiet --file consultas/consultas_base2.js 2>&1 \
  | tee "$SAIDAS/item_f_consultas_base2.txt"
mongosh "$URI" --quiet --file consultas/materializar_resumo.js 2>&1 \
  | tee "$SAIDAS/materializar_resumo.txt"
"$PY" consultas/validacao_numerica.py 2>&1 | tee "$SAIDAS/validacao_numerica.txt"

echo
echo "Concluido. Saidas em saidas/"
echo "Falta so o notebook (itens h e i):"
echo "  .venv/bin/jupyter nbconvert --to notebook --execute --inplace \\"
echo "      notebook/trabalho_mongo_colab.ipynb"
