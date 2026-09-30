"""
Configuracoes e funcoes compartilhadas pelos scripts do trabalho.

Trabalho de Banco de Dados NAO Relacional - MongoDB
Antonio Adolfo Geraldino Bernardo (RA 828561)
Rafael Yugo Hashimoto (RA 834417)
Rafaela Silva Ruis (RA 834416)
"""
from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
DADOS = RAIZ / "dados"
SAIDAS = RAIZ / "saidas"
GRAFICOS = SAIDAS / "graficos"

# ---------------------------------------------------------------- MongoDB ----
# A URI vem de variavel de ambiente para que o mesmo codigo rode sem auth
# (fase de carga), com auth (fase final) ou contra um cluster Atlas.
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
BANCO = os.environ.get("MONGO_DB", "brasil_bf")

COL_PAGAMENTOS = "pagamentos_bf"
COL_MUNICIPIOS = "municipios_ibge"
COL_PIB = "pib_serie_ibge"
COL_DE_PARA = "de_para_siafi_ibge"

# Competencias do Novo Bolsa Familia carregadas (AAAAMM).
COMPETENCIAS = [202606, 202607, 202608]

# Ano de referencia de cada indicador do IBGE.
ANO_POPULACAO = 2026
ANO_PIB = 2023
ANOS_PIB_SERIE = list(range(2015, 2024))

UFS = [
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS",
    "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC",
    "SE", "SP", "TO",
]


def get_db(uri: str | None = None, banco: str | None = None):
    """Devolve o objeto Database do PyMongo."""
    from pymongo import MongoClient

    cliente = MongoClient(uri or MONGO_URI, serverSelectionTimeoutMS=10_000)
    return cliente[banco or BANCO]


# ------------------------------------------------------- Nomes de municipio --
# Remove sufixo do tipo "- SP" / "/MG" no fim do nome. A sigla precisa ser uma
# UF de verdade: sem essa checagem, "XANGRI-LA" perderia o "-LA" e viraria
# "XANGRI", deixando de casar com "Xangri-la" do IBGE.
_SUFIXO_UF = re.compile(r"\s*[-/]\s*([A-Za-z]{2})\s*$")


def normalizar_nome(nome: str) -> str:
    """
    Normaliza o nome de um municipio para permitir o casamento entre as duas
    bases. O Portal da Transparencia publica os nomes em caixa alta, sem
    acentos e com grafias herdadas do SIAFI ("MOJI MIRIM"); o IBGE publica
    com acentuacao e grafia atual ("Mogi Mirim").

    Passos: remove sufixo de UF, decompoe em NFKD e descarta os diacriticos,
    passa para caixa alta, troca tudo que nao for letra/numero por espaco e
    colapsa os espacos.
    """
    if not nome:
        return ""
    texto = nome.strip()
    achado = _SUFIXO_UF.search(texto)
    if achado and achado.group(1).upper() in UFS:
        texto = texto[: achado.start()]
    texto = unicodedata.normalize("NFKD", texto)
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    texto = texto.upper()
    texto = re.sub(r"[^A-Z0-9]+", " ", texto)
    return re.sub(r"\s+", " ", texto).strip()
