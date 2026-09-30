#!/usr/bin/env python3
"""
BASE 2 - IBGE: municipios brasileiros, populacao estimada e PIB municipal.

Coleta tres recursos das APIs publicas do IBGE e grava dois arquivos JSON Lines
prontos para o mongoimport:

  dados/ibge_municipios.jsonl   1 documento por municipio (5.571)
  dados/ibge_pib_serie.jsonl    1 documento por municipio/ano (5.571 x 9)

Fontes (APIs abertas, sem necessidade de chave):
  * Localidades  : /api/v1/localidades/municipios?view=nivelado
  * Populacao    : /api/v3/agregados/6579 (Estimativas de Populacao), var 9324
  * PIB municipal: /api/v3/agregados/5938 (PIB dos Municipios), vars 37/498/525

Observacao sobre os limites da API de agregados: pedir varios anos e varias
variaveis de uma vez para os 5.570 municipios estoura o limite do servidor
(HTTP 500). Por isso a coleta do PIB e feita ano a ano, com as tres variaveis
juntas (~2 MB por requisicao).

Uso:  python coleta/coletar_ibge.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from comum import (  # noqa: E402
    ANO_PIB,
    ANO_POPULACAO,
    ANOS_PIB_SERIE,
    DADOS,
    normalizar_nome,
)

API_V1 = "https://servicodados.ibge.gov.br/api/v1"
API_V3 = "https://servicodados.ibge.gov.br/api/v3"

AGREGADO_POPULACAO = 6579
VAR_POPULACAO = 9324

AGREGADO_PIB = 5938
VAR_PIB = 37                # PIB a precos correntes (mil reais)
VAR_VAB_TOTAL = 498         # Valor adicionado bruto total (mil reais)
VAR_VAB_ADM = 525           # VAB da administracao, defesa, educacao e saude publicas

TIMEOUT = 180


def baixar_json(url: str, tentativas: int = 4) -> object:
    """GET com repeticao: as APIs do IBGE ocasionalmente devolvem 500/503."""
    for tentativa in range(1, tentativas + 1):
        try:
            resposta = requests.get(url, timeout=TIMEOUT)
            resposta.raise_for_status()
            return resposta.json()
        except Exception as erro:
            if tentativa == tentativas:
                raise
            espera = 3 * tentativa
            print(f"    ! {erro} -- nova tentativa em {espera}s "
                  f"({tentativa}/{tentativas - 1})", flush=True)
            time.sleep(espera)
    raise RuntimeError("inalcancavel")


def serie_por_municipio(agregado: int, variavel: int, periodo: int) -> dict[int, float | None]:
    """
    Devolve {cod_ibge: valor} para uma variavel de um agregado em um periodo,
    no nivel territorial de municipio (N6).

    Valores ausentes no IBGE vem como "..." ou "-"; sao convertidos em None.
    """
    url = (f"{API_V3}/agregados/{agregado}/periodos/{periodo}"
           f"/variaveis/{variavel}?localidades=N6[all]")
    dados = baixar_json(url)
    valores: dict[int, float | None] = {}
    for serie in dados[0]["resultados"][0]["series"]:
        cod = int(serie["localidade"]["id"])
        bruto = serie["serie"].get(str(periodo))
        try:
            valores[cod] = float(bruto)
        except (TypeError, ValueError):
            valores[cod] = None
    return valores


def series_multivariavel(agregado: int, variaveis: list[int],
                         periodo: int) -> dict[int, dict[int, float | None]]:
    """Mesma ideia, porem com varias variaveis em uma unica requisicao."""
    url = (f"{API_V3}/agregados/{agregado}/periodos/{periodo}/variaveis/"
           f"{'|'.join(str(v) for v in variaveis)}?localidades=N6[all]")
    dados = baixar_json(url)
    resultado: dict[int, dict[int, float | None]] = {}
    for bloco in dados:
        variavel = int(bloco["id"])
        for serie in bloco["resultados"][0]["series"]:
            cod = int(serie["localidade"]["id"])
            bruto = serie["serie"].get(str(periodo))
            try:
                valor = float(bruto)
            except (TypeError, ValueError):
                valor = None
            resultado.setdefault(cod, {})[variavel] = valor
    return resultado


def main() -> None:
    DADOS.mkdir(parents=True, exist_ok=True)

    print("[1/4] Localidades (hierarquia geografica dos municipios)...", flush=True)
    localidades = baixar_json(f"{API_V1}/localidades/municipios?view=nivelado")
    print(f"      {len(localidades)} municipios", flush=True)

    print(f"[2/4] Populacao residente estimada {ANO_POPULACAO} "
          f"(agregado {AGREGADO_POPULACAO})...", flush=True)
    populacao = serie_por_municipio(AGREGADO_POPULACAO, VAR_POPULACAO, ANO_POPULACAO)
    print(f"      {sum(1 for v in populacao.values() if v)} municipios com populacao",
          flush=True)

    print(f"[3/4] PIB municipal {ANOS_PIB_SERIE[0]}-{ANOS_PIB_SERIE[-1]} "
          f"(agregado {AGREGADO_PIB}), um ano por requisicao...", flush=True)
    pib_por_ano: dict[int, dict[int, dict[int, float | None]]] = {}
    for ano in ANOS_PIB_SERIE:
        inicio = time.perf_counter()
        pib_por_ano[ano] = series_multivariavel(
            AGREGADO_PIB, [VAR_PIB, VAR_VAB_TOTAL, VAR_VAB_ADM], ano)
        print(f"      {ano}: {len(pib_por_ano[ano])} municipios "
              f"({time.perf_counter() - inicio:.1f}s)", flush=True)

    print("[4/4] Montando os documentos...", flush=True)
    caminho_municipios = DADOS / "ibge_municipios.jsonl"
    caminho_pib = DADOS / "ibge_pib_serie.jsonl"

    sem_populacao = sem_pib = 0
    with caminho_municipios.open("w", encoding="utf-8") as f_mun, \
         caminho_pib.open("w", encoding="utf-8") as f_pib:

        for loc in localidades:
            cod = int(loc["municipio-id"])
            nome = loc["municipio-nome"]
            uf = loc["UF-sigla"]
            pop = populacao.get(cod)
            pib_ano = pib_por_ano[ANO_PIB].get(cod, {})
            pib = pib_ano.get(VAR_PIB)
            vab_total = pib_ano.get(VAR_VAB_TOTAL)
            vab_adm = pib_ano.get(VAR_VAB_ADM)

            if pop is None:
                sem_populacao += 1
            if pib is None:
                sem_pib += 1

            doc = {
                "_id": cod,
                "cod_ibge": cod,
                "nome": nome,
                "nome_norm": normalizar_nome(nome),
                "uf_sigla": uf,
                "uf_nome": loc["UF-nome"],
                "uf_id": int(loc["UF-id"]),
                "regiao": loc["regiao-nome"],
                "regiao_sigla": loc["regiao-sigla"],
                "mesorregiao": loc["mesorregiao-nome"],
                "microrregiao": loc["microrregiao-nome"],
                "regiao_imediata": loc["regiao-imediata-nome"],
                "regiao_intermediaria": loc["regiao-intermediaria-nome"],
                f"populacao_{ANO_POPULACAO}": int(pop) if pop is not None else None,
                f"pib_{ANO_PIB}_mil_reais": pib,
                f"vab_total_{ANO_PIB}_mil_reais": vab_total,
                f"vab_adm_publica_{ANO_PIB}_mil_reais": vab_adm,
            }
            # PIB per capita em reais: o IBGE publica o PIB em mil reais.
            if pib is not None and pop:
                doc["pib_per_capita"] = round(pib * 1000.0 / pop, 2)
            else:
                doc["pib_per_capita"] = None
            # Quanto do valor adicionado do municipio vem do setor publico:
            # indicador de dependencia da maquina publica local.
            if vab_total and vab_adm is not None and vab_total > 0:
                doc["participacao_adm_publica"] = round(100.0 * vab_adm / vab_total, 2)
            else:
                doc["participacao_adm_publica"] = None

            f_mun.write(json.dumps(doc, ensure_ascii=False) + "\n")

            for ano in ANOS_PIB_SERIE:
                valores = pib_por_ano[ano].get(cod, {})
                f_pib.write(json.dumps({
                    "cod_ibge": cod,
                    "nome": nome,
                    "uf_sigla": uf,
                    "regiao": loc["regiao-nome"],
                    "ano": ano,
                    "pib_mil_reais": valores.get(VAR_PIB),
                    "vab_total_mil_reais": valores.get(VAR_VAB_TOTAL),
                    "vab_adm_publica_mil_reais": valores.get(VAR_VAB_ADM),
                }, ensure_ascii=False) + "\n")

    n_mun = sum(1 for _ in caminho_municipios.open(encoding="utf-8"))
    n_pib = sum(1 for _ in caminho_pib.open(encoding="utf-8"))
    print()
    print(f"OK  {caminho_municipios}  ({n_mun} documentos)")
    print(f"OK  {caminho_pib}  ({n_pib} documentos)")
    print(f"    municipios sem populacao informada: {sem_populacao}")
    print(f"    municipios sem PIB {ANO_PIB} informado: {sem_pib}")


if __name__ == "__main__":
    main()
