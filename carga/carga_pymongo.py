#!/usr/bin/env python3
"""
Carga alternativa com PyMongo, para comparar com o mongoimport do item (d).

Le o mesmo arquivo JSON Lines e insere em lotes com insert_many(ordered=False),
medindo a vazao. Por padrao carrega 1 milhao de documentos em uma colecao
temporaria e a remove no fim, apenas para a medicao - a carga oficial das
57 milhoes de parcelas e feita pelo mongoimport, que e mais rapido porque
paraleliza a insercao em varios trabalhadores.

Uso:
  python carga/carga_pymongo.py
  python carga/carga_pymongo.py --limite 0 --colecao pagamentos_bf --manter
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from pymongo import MongoClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from comum import BANCO, COMPETENCIAS, DADOS, MONGO_URI  # noqa: E402


def carregar(caminho: Path, colecao, limite: int, lote: int) -> tuple[int, float]:
    """Insere o arquivo em lotes. limite=0 carrega o arquivo inteiro."""
    inseridos = 0
    buffer: list[dict] = []
    inicio = time.perf_counter()

    with caminho.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            buffer.append(json.loads(linha))
            if len(buffer) >= lote:
                colecao.insert_many(buffer, ordered=False)
                inseridos += len(buffer)
                buffer.clear()
                if limite and inseridos >= limite:
                    break
                if inseridos % (lote * 10) == 0:
                    taxa = inseridos / (time.perf_counter() - inicio)
                    print(f"    {inseridos:,} documentos ({taxa:,.0f} doc/s)"
                          .replace(",", "."), flush=True)
        if buffer and not (limite and inseridos >= limite):
            colecao.insert_many(buffer, ordered=False)
            inseridos += len(buffer)

    return inseridos, time.perf_counter() - inicio


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--competencia", type=int, default=COMPETENCIAS[0])
    parser.add_argument("--limite", type=int, default=1_000_000,
                        help="quantos documentos inserir (0 = arquivo inteiro)")
    parser.add_argument("--lote", type=int, default=50_000,
                        help="tamanho do lote do insert_many")
    parser.add_argument("--colecao", default="pagamentos_bf_teste_pymongo")
    parser.add_argument("--manter", action="store_true",
                        help="nao remove a colecao no final")
    args = parser.parse_args()

    caminho = DADOS / f"pagamentos_{args.competencia}.jsonl"
    if not caminho.exists():
        sys.exit(f"arquivo nao encontrado: {caminho}")

    cliente = MongoClient(MONGO_URI)
    banco = cliente[BANCO]
    colecao = banco[args.colecao]
    colecao.drop()

    print("=" * 70)
    print(" Carga com PyMongo - insert_many(ordered=False)")
    print("=" * 70)
    print(f"  arquivo : {caminho.name}")
    print(f"  colecao : {BANCO}.{args.colecao}")
    print(f"  lote    : {args.lote:,} documentos".replace(",", "."))
    print(f"  limite  : {'arquivo inteiro' if args.limite == 0 else f'{args.limite:,}'.replace(',', '.')}")
    print()

    inseridos, segundos = carregar(caminho, colecao, args.limite, args.lote)

    print()
    print(f"  inseridos : {inseridos:,} documentos".replace(",", "."))
    print(f"  tempo     : {segundos:.1f} s")
    print(f"  vazao     : {inseridos / segundos:,.0f} documentos/s".replace(",", "."))
    print(f"  conferido : {colecao.count_documents({}):,} no banco".replace(",", "."))

    if not args.manter:
        colecao.drop()
        print(f"  colecao {args.colecao} removida (era so para a medicao)")
    cliente.close()


if __name__ == "__main__":
    main()
