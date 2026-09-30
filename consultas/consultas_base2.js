/* ===========================================================================
 * ITEM (f) - CONSULTAS COMPLEXAS NA BASE 2
 *            IBGE: municipios, populacao estimada 2026 e PIB municipal
 *
 * Uso:  mongosh "mongodb://localhost:27017/brasil_bf" \
 *               --file consultas/consultas_base2.js
 * ======================================================================== */

load("consultas/util_saida.js");

/* =======================================================================
 * CONSULTA 4
 * ==================================================================== */
titulo("BASE 2 / CONSULTA 4 - Em que tamanho de cidade o brasileiro mora");
objetivo(
  "Classificar os 5.570 municipios em faixas de porte populacional e medir, " +
  "em cada faixa, quantos municipios existem, quanta gente vive ali e qual a " +
  "participacao no total do pais. O pipeline cria a faixa com $switch, cruza " +
  "faixa e regiao em um $group de chave composta, reagrupa com $push para " +
  "montar o detalhe regional e usa $setWindowFields para obter o total " +
  "nacional sem uma segunda consulta.");

const pipeline4 = [
  { $match: { populacao_2026: { $ne: null } } },

  // Faixas de porte usadas com frequencia em estudos do proprio IBGE.
  { $addFields: {
      faixa: { $switch: { branches: [
        { case: { $lt: ["$populacao_2026", 5000] },   then: "1. ate 5 mil" },
        { case: { $lt: ["$populacao_2026", 10000] },  then: "2. 5 a 10 mil" },
        { case: { $lt: ["$populacao_2026", 20000] },  then: "3. 10 a 20 mil" },
        { case: { $lt: ["$populacao_2026", 50000] },  then: "4. 20 a 50 mil" },
        { case: { $lt: ["$populacao_2026", 100000] }, then: "5. 50 a 100 mil" },
        { case: { $lt: ["$populacao_2026", 500000] }, then: "6. 100 a 500 mil" }
      ], default: "7. acima de 500 mil" } }
  } },

  // Chave composta: faixa de porte x regiao.
  { $group: {
      _id: { faixa: "$faixa", regiao: "$regiao" },
      municipios: { $sum: 1 },
      populacao: { $sum: "$populacao_2026" }
  } },

  // Reagrupa por faixa mantendo o detalhe por regiao em um array.
  { $group: {
      _id: "$_id.faixa",
      municipios: { $sum: "$municipios" },
      populacao: { $sum: "$populacao" },
      por_regiao: { $push: { regiao: "$_id.regiao", municipios: "$municipios" } }
  } },

  // Totais nacionais calculados na propria janela, sem nova consulta.
  { $setWindowFields: {
      sortBy: { _id: 1 },
      output: {
        municipios_brasil: { $sum: "$municipios",
                             window: { documents: ["unbounded", "unbounded"] } },
        populacao_brasil: { $sum: "$populacao",
                            window: { documents: ["unbounded", "unbounded"] } }
      }
  } },

  { $addFields: {
      pct_municipios: { $multiply: [100, { $divide: ["$municipios", "$municipios_brasil"] }] },
      pct_populacao: { $multiply: [100, { $divide: ["$populacao", "$populacao_brasil"] }] },
      media_habitantes: { $divide: ["$populacao", "$municipios"] },
      regiao_com_mais_municipios: { $reduce: {
        input: "$por_regiao", initialValue: { regiao: "-", municipios: 0 },
        in: { $cond: [{ $gt: ["$$this.municipios", "$$value.municipios"] },
                      "$$this", "$$value"] } } }
  } },
  { $sort: { _id: 1 } },
  { $project: { _id: 0, faixa: "$_id", municipios: 1, pct_municipios: 1,
                populacao: 1, pct_populacao: 1, media_habitantes: 1,
                regiao_com_mais_municipios: 1, municipios_brasil: 1,
                populacao_brasil: 1 } }
];

mostrarPipeline(pipeline4);
const r4 = executar("municipios_ibge", pipeline4);

tabela([
  { rotulo: "Faixa de porte", campo: "faixa", largura: 20 },
  { rotulo: "Municipios", campo: "municipios", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "% dos mun.", campo: "pct_municipios", largura: 10, alinha: "d",
    formato: v => numero(v, 1) + "%" },
  { rotulo: "Populacao", campo: "populacao", largura: 14, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "% da pop.", campo: "pct_populacao", largura: 9, alinha: "d",
    formato: v => numero(v, 1) + "%" },
  { rotulo: "Media hab./mun.", campo: "media_habitantes", largura: 15, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Regiao com mais mun.", campo: "regiao_com_mais_municipios.regiao",
    largura: 20 }
], r4);

print("");
print("LEITURA DO RESULTADO: a maior parte dos municipios brasileiros e pequena,");
print("mas a maior parte da populacao vive nas poucas cidades grandes. Esse");
print("contraste explica por que analises municipais precisam ser normalizadas");
print("por populacao - e nao comparadas em valores absolutos.");

/* =======================================================================
 * CONSULTA 5
 * ==================================================================== */
titulo("BASE 2 / CONSULTA 5 - Campeao de crescimento do PIB em cada estado");
objetivo(
  "Encontrar, em cada UF, o municipio de porte medio ou grande (>= 50 mil " +
  "habitantes) que mais cresceu em PIB nominal entre 2015 e 2023. O pipeline " +
  "faz $lookup com pipeline interno na serie historica, extrai as duas pontas " +
  "com $filter e $arrayElemAt, calcula a variacao e usa $setWindowFields com " +
  "$rank particionado por UF para escolher o primeiro colocado de cada estado.");

const pipeline5 = [
  { $match: { populacao_2026: { $gte: 50000 } } },

  { $lookup: {
      from: "pib_serie_ibge",
      localField: "cod_ibge",
      foreignField: "cod_ibge",
      pipeline: [
        { $match: { ano: { $in: [2015, 2023] } } },
        { $project: { _id: 0, ano: 1, pib_mil_reais: 1 } }
      ],
      as: "serie"
  } },

  { $addFields: {
      pib_2015: { $arrayElemAt: [
        { $map: { input: { $filter: { input: "$serie",
                                      cond: { $eq: ["$$this.ano", 2015] } } },
                  in: "$$this.pib_mil_reais" } }, 0] },
      pib_2023: { $arrayElemAt: [
        { $map: { input: { $filter: { input: "$serie",
                                      cond: { $eq: ["$$this.ano", 2023] } } },
                  in: "$$this.pib_mil_reais" } }, 0] }
  } },
  { $match: { pib_2015: { $gt: 0 }, pib_2023: { $gt: 0 } } },

  { $addFields: {
      crescimento_pct: { $multiply: [
        100, { $subtract: [{ $divide: ["$pib_2023", "$pib_2015"] }, 1] }] }
  } },

  { $setWindowFields: {
      partitionBy: "$uf_sigla",
      sortBy: { crescimento_pct: -1 },
      output: {
        posicao_na_uf: { $rank: {} },
        crescimento_medio_da_uf: { $avg: "$crescimento_pct",
                                   window: { documents: ["unbounded", "unbounded"] } },
        municipios_avaliados_na_uf: { $sum: 1,
                                      window: { documents: ["unbounded", "unbounded"] } }
      }
  } },
  { $match: { posicao_na_uf: 1 } },

  { $addFields: {
      vantagem_sobre_a_media_da_uf: { $subtract: ["$crescimento_pct",
                                                 "$crescimento_medio_da_uf"] }
  } },
  { $sort: { crescimento_pct: -1 } },
  { $project: { _id: 0, uf: "$uf_sigla", municipio: "$nome", regiao: 1,
                populacao_2026: 1, pib_2015: 1, pib_2023: 1, crescimento_pct: 1,
                crescimento_medio_da_uf: 1, municipios_avaliados_na_uf: 1,
                vantagem_sobre_a_media_da_uf: 1,
                participacao_adm_publica: 1 } }
];

mostrarPipeline(pipeline5);
const r5 = executar("municipios_ibge", pipeline5);

tabela([
  { rotulo: "UF", campo: "uf", largura: 3 },
  { rotulo: "Municipio", campo: "municipio", largura: 24 },
  { rotulo: "Pop. 2026", campo: "populacao_2026", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "PIB 2015 (mi R$)", campo: "pib_2015", largura: 16, alinha: "d",
    formato: v => numero(v / 1000, 1) },
  { rotulo: "PIB 2023 (mi R$)", campo: "pib_2023", largura: 16, alinha: "d",
    formato: v => numero(v / 1000, 1) },
  { rotulo: "Crescimento", campo: "crescimento_pct", largura: 11, alinha: "d",
    formato: v => numero(v, 1) + "%" },
  { rotulo: "Media da UF", campo: "crescimento_medio_da_uf", largura: 11, alinha: "d",
    formato: v => numero(v, 1) + "%" },
  { rotulo: "Avaliados", campo: "municipios_avaliados_na_uf", largura: 9, alinha: "d" }
], r5);

print("");
print("LEITURA DO RESULTADO: o crescimento e nominal (a precos correntes) e portanto");
print("inclui inflacao; o que importa aqui e a comparacao entre municipios no mesmo");
print("periodo. O ranking e dominado por cidades que receberam um unico grande vetor");
print("economico: petroleo e royalties (Saquarema/RJ, com crescimento de mais de 30");
print("vezes, e Sao Sebastiao/SP), mineracao (Canaa dos Carajas/PA, da mina S11D),");
print("fronteira agricola (Campo Novo do Parecis/MT, Cristalina/GO, Balsas/MA) e");
print("polos logisticos e industriais (Extrema/MG, Araquari/SC, Goiana/PE).");
print("");
print("Vale cruzar com a consulta 2 da Base 1: varias dessas cidades campeas de");
print("crescimento do PIB continuam com alta proporcao de familias no Bolsa Familia.");
print("O PIB mede o que se produz no territorio, nao o que chega as familias.");
print("");
