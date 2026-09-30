#!/usr/bin/env python3
"""
Integracao das duas bases: de-para entre o CODIGO MUNICIPIO SIAFI (usado pelo
Portal da Transparencia) e o CODIGO IBGE de 7 digitos (usado pelo IBGE).

As duas bases nao compartilham a chave do municipio, logo o cruzamento e feito
por (UF, nome normalizado). A normalizacao esta em comum.normalizar_nome().

Estrategia em tres niveis, sempre restrita a mesma UF:
  1. casamento exato do nome normalizado                          -> "exato"
  2. dicionario de excecoes para municipios renomeados ou com     -> "excecao"
     grafia antiga mantida no SIAFI
  3. maior similaridade textual acima de 0,85 (difflib)           -> "similaridade"

Gera dados/de_para_siafi_ibge.jsonl e um relatorio de qualidade em
saidas/relatorio_de_para.txt com a taxa de casamento e os casos resolvidos
fora do casamento exato - ou seja, tudo que foi decidido por heuristica fica
registrado e auditavel.

Uso:  python coleta/de_para_siafi_ibge.py
"""
from __future__ import annotations

import csv
import difflib
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from comum import COMPETENCIAS, DADOS, SAIDAS, normalizar_nome  # noqa: E402

ARQUIVO_DE_PARA = DADOS / "de_para_siafi_ibge.jsonl"
ARQUIVO_UNIVERSO = DADOS / "universo_portal.json"
ARQUIVO_IBGE = DADOS / "ibge_municipios.jsonl"
RELATORIO = SAIDAS / "relatorio_de_para.txt"

LIMITE_SIMILARIDADE = 0.85

# Municipios renomeados ou com grafia antiga preservada no SIAFI. Cada par foi
# conferido um a um contra a lista de municipios do IBGE da respectiva UF.
# Formato: (UF, nome normalizado no Portal) -> nome normalizado no IBGE
EXCECOES: dict[tuple[str, str], str] = {
    # Municipios renomeados. O proprio Portal carrega o nome antigo entre
    # parenteses, o que confirma a equivalencia.
    ("RN", "CAMPO GRANDE EX AUGUSTO SEVERO"): "CAMPO GRANDE",
    ("RN", "SERRA CAIADA EX PRESIDENTE JUSCELINO"): "SERRA CAIADA",
    ("PB", "SAO DOMINGOS DE POMBAL"): "SAO DOMINGOS",
    ("PB", "SERIDO"): "SAO VICENTE DO SERIDO",
    ("TO", "FORTALEZA DO TABOCAO"): "TABOCAO",
    ("TO", "SAO VALERIO DA NATIVIDADE"): "SAO VALERIO",
    # Grafias divergentes que a similaridade nao alcanca por serem curtas.
    ("RJ", "PARATI"): "PARATY",
    ("RN", "ACU"): "ASSU",
    ("RN", "ARES"): "AREZ",
    # O SIAFI trata Fernando de Noronha como distrito estadual; no IBGE e
    # municipio (codigo 2605459).
    ("PE", "DISTRITO ESTADUAL DE FERNANDO DE NORONHA"): "FERNANDO DE NORONHA",
    # Roraima tem 15 municipios nas duas bases e os outros 14 casaram de forma
    # exata; por eliminacao, o "SAO LUIZ" do SIAFI e o "Sao Luiz do Anaua"
    # do IBGE (codigo 1400605).
    ("RR", "SAO LUIZ"): "SAO LUIZ DO ANAUA",
}

csv.field_size_limit(10 * 1024 * 1024)


def universo_portal(competencias: list[int] | None = None,
                    usar_cache: bool = True) -> dict[tuple[str, int], str]:
    """
    Varre os CSV do Portal e devolve {(UF, cod_siafi): nome do municipio}.

    O resultado e guardado em cache porque a varredura le ~1,1 GB por mes.
    """
    competencias = competencias or COMPETENCIAS
    if usar_cache and ARQUIVO_UNIVERSO.exists():
        bruto = json.loads(ARQUIVO_UNIVERSO.read_text(encoding="utf-8"))
        return {(item["uf"], item["cod_siafi"]): item["nome"] for item in bruto}

    encontrados: dict[tuple[str, int], str] = {}
    for competencia in competencias:
        caminho = DADOS / f"{competencia}_NovoBolsaFamilia.csv"
        if not caminho.exists():
            print(f"  ! {caminho.name} ainda nao existe, ignorando", flush=True)
            continue
        with caminho.open(encoding="latin-1", newline="") as arquivo:
            leitor = csv.reader(arquivo, delimiter=";", quotechar='"')
            next(leitor)
            for linha in leitor:
                if len(linha) != 9:
                    continue
                uf, siafi, nome = linha[2].strip(), linha[3].strip(), linha[4].strip()
                if siafi.isdigit():
                    encontrados.setdefault((uf, int(siafi)), nome)
        print(f"  {competencia}: universo acumulado em {len(encontrados)} municipios",
              flush=True)

    ARQUIVO_UNIVERSO.write_text(json.dumps(
        [{"uf": uf, "cod_siafi": siafi, "nome": nome}
         for (uf, siafi), nome in sorted(encontrados.items())],
        ensure_ascii=False, indent=1), encoding="utf-8")
    return encontrados


def municipios_ibge() -> dict[str, dict[str, int]]:
    """Devolve {UF: {nome_normalizado: cod_ibge}} a partir da coleta do IBGE."""
    por_uf: dict[str, dict[str, int]] = defaultdict(dict)
    with ARQUIVO_IBGE.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            doc = json.loads(linha)
            por_uf[doc["uf_sigla"]][doc["nome_norm"]] = doc["cod_ibge"]
    return por_uf


def construir() -> tuple[list[dict], list[dict]]:
    """Monta o de-para. Devolve (casados, nao_casados)."""
    portal = universo_portal()
    ibge = municipios_ibge()
    if not portal:
        raise RuntimeError("nenhum CSV do Portal encontrado - rode antes o --baixar")

    casados: list[dict] = []
    nao_casados: list[dict] = []

    for (uf, siafi), nome in sorted(portal.items()):
        nome_norm = normalizar_nome(nome)
        candidatos = ibge.get(uf, {})

        if nome_norm in candidatos:
            casados.append({"cod_siafi": siafi, "uf": uf, "nome_portal": nome,
                            "nome_ibge_norm": nome_norm,
                            "cod_ibge": candidatos[nome_norm],
                            "metodo_match": "exato", "score": 1.0})
            continue

        alvo = EXCECOES.get((uf, nome_norm))
        if alvo and alvo in candidatos:
            casados.append({"cod_siafi": siafi, "uf": uf, "nome_portal": nome,
                            "nome_ibge_norm": alvo, "cod_ibge": candidatos[alvo],
                            "metodo_match": "excecao", "score": 1.0})
            continue

        proximos = difflib.get_close_matches(nome_norm, list(candidatos), n=1,
                                             cutoff=LIMITE_SIMILARIDADE)
        if proximos:
            escolhido = proximos[0]
            score = difflib.SequenceMatcher(None, nome_norm, escolhido).ratio()
            casados.append({"cod_siafi": siafi, "uf": uf, "nome_portal": nome,
                            "nome_ibge_norm": escolhido,
                            "cod_ibge": candidatos[escolhido],
                            "metodo_match": "similaridade", "score": round(score, 4)})
            continue

        sugestoes = difflib.get_close_matches(nome_norm, list(candidatos), n=3, cutoff=0.5)
        nao_casados.append({"cod_siafi": siafi, "uf": uf, "nome_portal": nome,
                            "nome_norm": nome_norm, "sugestoes": sugestoes})

    return casados, nao_casados


def gravar(casados: list[dict], nao_casados: list[dict]) -> None:
    SAIDAS.mkdir(parents=True, exist_ok=True)
    with ARQUIVO_DE_PARA.open("w", encoding="utf-8") as arquivo:
        for doc in casados:
            arquivo.write(json.dumps(doc, ensure_ascii=False) + "\n")

    total = len(casados) + len(nao_casados)
    por_metodo: dict[str, int] = defaultdict(int)
    for doc in casados:
        por_metodo[doc["metodo_match"]] += 1

    linhas = [
        "RELATORIO DE QUALIDADE DO DE-PARA SIAFI -> IBGE",
        "=" * 62,
        f"Municipios distintos no Portal da Transparencia : {total}",
        f"Municipios casados com o cadastro do IBGE       : {len(casados)} "
        f"({100.0 * len(casados) / total:.2f}%)",
        f"Nao casados                                     : {len(nao_casados)}",
        "",
        "Casamentos por metodo:",
    ]
    for metodo, quantidade in sorted(por_metodo.items(), key=lambda x: -x[1]):
        linhas.append(f"  {metodo:14s} {quantidade:5d} "
                      f"({100.0 * quantidade / total:.2f}%)")

    resolvidos_por_heuristica = [d for d in casados if d["metodo_match"] != "exato"]
    linhas += ["", f"Casos resolvidos fora do casamento exato "
                   f"({len(resolvidos_por_heuristica)}):"]
    for doc in sorted(resolvidos_por_heuristica, key=lambda d: (d["uf"], d["nome_portal"])):
        linhas.append(f"  {doc['uf']} {doc['cod_siafi']:>5} "
                      f"{doc['nome_portal']:<34} -> {doc['nome_ibge_norm']:<34} "
                      f"[{doc['metodo_match']}, score {doc['score']}]")

    if nao_casados:
        linhas += ["", f"Nao casados ({len(nao_casados)}):"]
        for doc in nao_casados:
            linhas.append(f"  {doc['uf']} {doc['cod_siafi']:>5} "
                          f"{doc['nome_portal']:<34} sugestoes: {doc['sugestoes']}")

    RELATORIO.write_text("\n".join(linhas) + "\n", encoding="utf-8")
    print("\n".join(linhas[:14]))
    print(f"\nOK  {ARQUIVO_DE_PARA} ({len(casados)} documentos)")
    print(f"OK  {RELATORIO}")


def carregar_de_para() -> dict[tuple[str, int], int]:
    """Carrega o de-para pronto (construindo, se ainda nao existir)."""
    if not ARQUIVO_DE_PARA.exists():
        gravar(*construir())
    mapa: dict[tuple[str, int], int] = {}
    with ARQUIVO_DE_PARA.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            doc = json.loads(linha)
            mapa[(doc["uf"], doc["cod_siafi"])] = doc["cod_ibge"]
    return mapa


if __name__ == "__main__":
    gravar(*construir())
