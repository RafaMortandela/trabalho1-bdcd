#!/usr/bin/env python3
"""
BASE 1 - Novo Bolsa Familia (Portal da Transparencia do Governo Federal).

Duas etapas, selecionaveis pela linha de comando:

  --baixar     baixa o ZIP de cada competencia e extrai o CSV
  --converter  le os CSV em streaming e grava JSON Lines tipado, ja enriquecido
               com o codigo IBGE do municipio (de_para_siafi_ibge.py)

Fonte:
  https://portaldatransparencia.gov.br/download-de-dados/novo-bolsa-familia/AAAAMM

Formato do arquivo publicado: ZIP com um unico CSV em latin-1, separador ";",
campos entre aspas duplas e valor monetario com virgula decimal. Colunas:

  MES COMPETENCIA | MES REFERENCIA | UF | CODIGO MUNICIPIO SIAFI |
  NOME MUNICIPIO  | CPF FAVORECIDO | NIS FAVORECIDO | NOME FAVORECIDO |
  VALOR PARCELA

O CPF ja vem mascarado na origem. Nome e NIS sao mantidos como publicados
(fidelidade a fonte oficial e necessarios para contar familias distintas);
nenhuma consulta, grafico ou tela do aplicativo expoe dados individuais.

Uso:
  python coleta/coletar_bolsa_familia.py --baixar
  python coleta/coletar_bolsa_familia.py --converter
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from comum import COMPETENCIAS, DADOS  # noqa: E402

URL = "https://portaldatransparencia.gov.br/download-de-dados/novo-bolsa-familia/{competencia}"
CABECALHO_ESPERADO = [
    "MÊS COMPETÊNCIA", "MÊS REFERÊNCIA", "UF", "CÓDIGO MUNICÍPIO SIAFI",
    "NOME MUNICÍPIO", "CPF FAVORECIDO", "NIS FAVORECIDO", "NOME FAVORECIDO",
    "VALOR PARCELA",
]

# O csv do Portal tem linhas longas; o limite padrao do modulo csv e suficiente,
# mas alguns nomes de favorecido vem com caracteres de controle.
csv.field_size_limit(10 * 1024 * 1024)


def caminho_zip(competencia: int) -> Path:
    return DADOS / f"{competencia}_NovoBolsaFamilia.zip"


def caminho_csv(competencia: int) -> Path:
    return DADOS / f"{competencia}_NovoBolsaFamilia.csv"


def caminho_jsonl(competencia: int) -> Path:
    return DADOS / f"pagamentos_{competencia}.jsonl"


def baixar(competencia: int) -> None:
    """Baixa o ZIP da competencia (em streaming) e extrai o CSV."""
    destino_zip = caminho_zip(competencia)
    destino_csv = caminho_csv(competencia)
    if destino_csv.exists():
        print(f"  {competencia}: CSV ja existe ({destino_csv.stat().st_size/2**20:.0f} MB), "
              f"pulando", flush=True)
        return

    url = URL.format(competencia=competencia)
    print(f"  {competencia}: baixando {url}", flush=True)
    inicio = time.perf_counter()
    with requests.get(url, stream=True, timeout=600) as resposta:
        resposta.raise_for_status()
        with destino_zip.open("wb") as saida:
            for pedaco in resposta.iter_content(chunk_size=1 << 20):
                saida.write(pedaco)
    mb = destino_zip.stat().st_size / 2**20
    print(f"  {competencia}: {mb:.0f} MB em {time.perf_counter()-inicio:.0f}s, extraindo",
          flush=True)

    with zipfile.ZipFile(destino_zip) as zf:
        nomes = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if len(nomes) != 1:
            raise RuntimeError(f"esperava 1 CSV dentro do ZIP, achei {nomes}")
        with zf.open(nomes[0]) as origem, destino_csv.open("wb") as saida:
            while pedaco := origem.read(1 << 22):
                saida.write(pedaco)
    destino_zip.unlink()  # o CSV extraido substitui o ZIP; economiza disco
    print(f"  {competencia}: CSV com {destino_csv.stat().st_size/2**20:.0f} MB "
          f"em {destino_csv.name}", flush=True)


def converter(competencia: int, de_para: dict[tuple[str, int], int]) -> dict[str, int]:
    """
    Le o CSV da competencia e grava um JSON Lines tipado.

    Conversoes aplicadas:
      * competencia/referencia  texto -> int (AAAAMM)
      * codigo SIAFI            texto -> int
      * valor da parcela        "650,00" -> 650.0
      * retroativo              True quando referencia != competencia
      * cod_ibge                acrescentado a partir do de-para SIAFI->IBGE
    """
    origem = caminho_csv(competencia)
    destino = caminho_jsonl(competencia)
    contadores = {"lidas": 0, "gravadas": 0, "sem_cod_ibge": 0,
                  "valor_invalido": 0, "retroativas": 0}
    inicio = time.perf_counter()

    with origem.open(encoding="latin-1", newline="") as f_in, \
         destino.open("w", encoding="utf-8") as f_out:
        leitor = csv.reader(f_in, delimiter=";", quotechar='"')
        cabecalho = next(leitor)
        if [c.strip().lstrip("﻿") for c in cabecalho] != CABECALHO_ESPERADO:
            raise RuntimeError(f"cabecalho inesperado em {origem.name}: {cabecalho}")

        for linha in leitor:
            contadores["lidas"] += 1
            if len(linha) != 9:
                continue
            comp, ref, uf, siafi, municipio, cpf, nis, nome, valor = (
                campo.strip() for campo in linha)
            try:
                valor_num = float(valor.replace(".", "").replace(",", "."))
            except ValueError:
                contadores["valor_invalido"] += 1
                continue

            siafi_num = int(siafi) if siafi.isdigit() else None
            cod_ibge = de_para.get((uf, siafi_num))
            if cod_ibge is None:
                contadores["sem_cod_ibge"] += 1

            comp_num, ref_num = int(comp), int(ref)
            retroativo = ref_num != comp_num
            if retroativo:
                contadores["retroativas"] += 1

            f_out.write(json.dumps({
                "competencia": comp_num,
                "referencia": ref_num,
                "uf": uf,
                "cod_siafi": siafi_num,
                "cod_ibge": cod_ibge,
                "municipio": municipio,
                "cpf_mascarado": cpf,
                "nis": nis,
                "nome": nome,
                "valor": round(valor_num, 2),
                "retroativo": retroativo,
            }, ensure_ascii=False) + "\n")
            contadores["gravadas"] += 1

            if contadores["lidas"] % 2_000_000 == 0:
                print(f"    {competencia}: {contadores['lidas']:,} linhas "
                      f"({time.perf_counter()-inicio:.0f}s)".replace(",", "."),
                      flush=True)

    segundos = time.perf_counter() - inicio
    gb = destino.stat().st_size / 2**30
    print(f"  {competencia}: {contadores['gravadas']:,} documentos, {gb:.2f} GB, "
          f"{segundos:.0f}s".replace(",", "."), flush=True)
    print(f"    retroativos: {contadores['retroativas']:,} | "
          f"sem cod_ibge: {contadores['sem_cod_ibge']:,} | "
          f"valor invalido: {contadores['valor_invalido']:,}".replace(",", "."),
          flush=True)
    return contadores


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baixar", action="store_true", help="baixa e extrai os CSV")
    parser.add_argument("--converter", action="store_true",
                        help="converte os CSV em JSON Lines tipado")
    parser.add_argument("--competencias", nargs="*", type=int, default=COMPETENCIAS,
                        help=f"competencias AAAAMM (padrao: {COMPETENCIAS})")
    args = parser.parse_args()
    if not (args.baixar or args.converter):
        parser.error("informe --baixar e/ou --converter")

    DADOS.mkdir(parents=True, exist_ok=True)

    if args.baixar:
        print(f"== Download das competencias {args.competencias} ==", flush=True)
        for competencia in args.competencias:
            baixar(competencia)

    if args.converter:
        from de_para_siafi_ibge import carregar_de_para
        print("== Conversao para JSON Lines ==", flush=True)
        de_para = carregar_de_para()
        print(f"  de-para SIAFI->IBGE com {len(de_para)} municipios", flush=True)
        total = {"lidas": 0, "gravadas": 0, "sem_cod_ibge": 0,
                 "valor_invalido": 0, "retroativas": 0}
        for competencia in args.competencias:
            parcial = converter(competencia, de_para)
            for chave, valor in parcial.items():
                total[chave] += valor
        print()
        print("Totais:", json.dumps(total, indent=2))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
